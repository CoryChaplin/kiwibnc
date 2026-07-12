const sqlite3 = require('better-sqlite3');

function profile(label, startedAt) {
    l.info(`${label}: ${Date.now() - startedAt} ms`);
}

/**
 * Runs the KiwiBNC SQLite message retention cleanup in a standalone
 * process so synchronous database queries cannot block IRC keepalives,
 * client sockets, or the main Node.js event loop.
 *
 * This implementation intentionally removes rows only from the `logs`
 * table. Orphaned rows in `data` must be cleaned during offline
 * maintenance because the live KiwiBNC process caches data IDs in memory.
 */
module.exports = async function cleanupMessages() {
    const app = await require('../libs/bootstrap')('cleanupmessages');
    const loggingConf = app.conf.get('logging', {});

    if (!loggingConf.database) {
        l.error('Missing logging.database in config');
        process.exitCode = 1;
        return;
    }

    const databasePath = app.conf.relativePath(
        loggingConf.database
    );

    const retentionDaysChannels = parseNonNegativeInteger(
        loggingConf.retention_days_channels,
        0
    );

    const retentionDaysPMs = parseNonNegativeInteger(
        loggingConf.retention_days_pms,
        0
    );

    /*
     * Cory's cleanup uses batches of 150 rows so operations remain short
     * and SQLite parameter limits are never approached.
     */
    const batchSize = parsePositiveInteger(
        loggingConf.retention_cleanup_batch_size,
        150
    );

    /*
     * Maximum number of log rows removed by one command execution.
     * This limit is shared globally between channels and PMs.
     *
     * Zero means unlimited.
     */
    const maxRows = parseNonNegativeInteger(
        loggingConf.retention_cleanup_max_rows,
        100000
    );

    /*
     * Pause after each synchronous SQLite batch. This reduces contention
     * with the live KiwiBNC process and gives it opportunities to write.
     */
    const batchPauseMs = parseNonNegativeInteger(
        loggingConf.retention_cleanup_pause_ms,
        50
    );

    if (
        retentionDaysChannels === 0 &&
        retentionDaysPMs === 0
    ) {
        l.info('Message retention is disabled');
        return;
    }

    let db = null;

    try {
        const dbOpenStarted = Date.now();

        db = new sqlite3(databasePath);

        profile('Opening database', dbOpenStarted);

        /*
         * Match the SQLite configuration used by Cory's message store.
         * The standalone process must always open its own connection.
         */
        db.pragma('journal_mode = WAL');
        db.pragma('synchronous = NORMAL');
        db.pragma('temp_store = MEMORY');
        db.pragma('busy_timeout = 100');

        /*
         * Retention searches globally by timestamp. The normal
         * (user_id, bufferref, time) index cannot efficiently serve
         * a WHERE time < ? query on its own.
         */
        db.exec(`
            CREATE INDEX IF NOT EXISTS logs_time
            ON logs (time)
        `);

        const state = {
            totalDeleted: 0,
            startedAt: Date.now(),
        };

        await processRetention({
            db,
            days: retentionDaysChannels,
            isChannel: true,
            batchSize,
            maxRows,
            batchPauseMs,
            state,
        });

        if (
            maxRows === 0 ||
            state.totalDeleted < maxRows
        ) {
            await processRetention({
                db,
                days: retentionDaysPMs,
                isChannel: false,
                batchSize,
                maxRows,
                batchPauseMs,
                state,
            });
        }

        const durationMs = Date.now() - state.startedAt;

        l.info(
            `Message retention completed: ` +
            `${state.totalDeleted} rows removed in ${durationMs} ms`
        );
    } catch (err) {
        l.error('Message retention failed', err);
        process.exitCode = 1;
    } finally {
        if (db) {
            try {
                /*
                 * Remove temporary tables explicitly before closing.
                 * They are connection-local, but explicit cleanup keeps
                 * execution predictable after handled errors.
                 */
                db.exec(`
                    DROP TABLE IF EXISTS tmp_ret_ch_bufs;
                    DROP TABLE IF EXISTS tmp_ret_pm_bufs;
                `);

                db.close();
            } catch (err) {
                l.error('Error closing retention database', err);
                process.exitCode = 1;
            }
        }
    }
};

/**
 * Removes expired messages for channels or private-message buffers.
 *
 * Buffer IDs are precomputed once into a temporary indexed table. This
 * avoids rescanning the large BLOB-backed `data` table for every batch.
 *
 * @param {Object} options Cleanup options.
 * @returns {Promise<void>}
 */
async function processRetention(options) {
    const {
        db,
        days,
        isChannel,
        batchSize,
        maxRows,
        batchPauseMs,
        state,
    } = options;

    if (days <= 0) {
        return;
    }

    const label = isChannel ? 'channels' : 'PMs';

    const tempTable = isChannel
        ? 'tmp_ret_ch_bufs'
        : 'tmp_ret_pm_bufs';

    const tempIndex = `idx_${tempTable}`;

    const cutoffTime =
        Date.now() - (days * 24 * 60 * 60 * 1000);

    l.info(
        `Starting ${label} retention: ` +
        `${days} days, batch=${batchSize}`
    );

    /*
     * The data column has BLOB affinity. CAST is therefore required for
     * reliable LIKE matching when classifying channel and PM buffers.
     */
    const bufferSelectionSql = isChannel
    ? `
        SELECT DISTINCT logs.bufferref AS id
        FROM logs
        INNER JOIN data
            ON data.id = logs.bufferref
        WHERE CAST(data.data AS TEXT) LIKE '#%'
           OR CAST(data.data AS TEXT) LIKE '&%'
    `
    : `
        SELECT DISTINCT logs.bufferref AS id
        FROM logs
        INNER JOIN data
            ON data.id = logs.bufferref
        WHERE CAST(data.data AS TEXT) NOT LIKE '#%'
          AND CAST(data.data AS TEXT) NOT LIKE '&%'
    `;

    const tempTableStarted = Date.now();

    db.exec(`DROP TABLE IF EXISTS ${tempTable}`);

    db.exec(`
        CREATE TEMP TABLE ${tempTable}
        AS
        ${bufferSelectionSql}
    `);

    db.exec(`
        CREATE INDEX ${tempIndex}
        ON ${tempTable} (id)
    `);

    profile(
        `Create temp table (${label})`,
        tempTableStarted
    );

    const deleteBatch = db.prepare(`
        DELETE FROM logs
        WHERE rowid IN (
            SELECT logs.rowid
            FROM logs
            INNER JOIN ${tempTable}
                ON logs.bufferref = ${tempTable}.id
            WHERE logs.time < ?
            ORDER BY logs.time ASC
            LIMIT ?
        )
    `);

    try {
        while (true) {
            let currentBatchSize = batchSize;

            if (maxRows > 0) {
                const remaining =
                    maxRows - state.totalDeleted;

                if (remaining <= 0) {
                    l.info(
                        `Global cleanup limit reached ` +
                        `(${state.totalDeleted} rows)`
                    );
                    return;
                }

                currentBatchSize = Math.min(
                    currentBatchSize,
                    remaining
                );
            }

            const batchStarted = Date.now();

            const deleted = await runDeleteBatchWithRetry({
                db,
                statement: deleteBatch,
                cutoffTime,
                batchSize: currentBatchSize,
            });

            profile(
                `${label} batch (${deleted} rows)`,
                batchStarted
            );

            state.totalDeleted += deleted;

            if (
                state.totalDeleted % 100000 < deleted ||
                deleted < currentBatchSize
            ) {
                l.info(
                    `Message retention removed ` +
                    `${state.totalDeleted} rows so far`
                );
            }

            /*
             * A partial batch means there are no more expired rows for
             * this buffer category.
             */
            if (deleted < currentBatchSize) {
                l.info(`${label} retention completed`);
                return;
            }

            if (
                maxRows > 0 &&
                state.totalDeleted >= maxRows
            ) {
                l.info(
                    `Global cleanup limit reached ` +
                    `(${state.totalDeleted} rows)`
                );
                return;
            }

            await sleep(batchPauseMs);
        }
    } finally {
        db.exec(`DROP TABLE IF EXISTS ${tempTable}`);
    }
}

/**
 * Runs one delete transaction and retries temporary SQLite lock errors.
 *
 * @param {Object} options Batch options.
 * @returns {Promise<number>} Number of deleted rows.
 */
async function runDeleteBatchWithRetry(options) {
    const {
        db,
        statement,
        cutoffTime,
        batchSize,
    } = options;

    let retries = 0;

    while (true) {
        try {
            const info = db.transaction(() => {
                return statement.run(
                    cutoffTime,
                    batchSize
                );
            })();

            return info.changes;
        } catch (err) {
            if (
                (
                    err.code === 'SQLITE_BUSY' ||
                    err.code === 'SQLITE_LOCKED'
                ) &&
                retries < 10
            ) {
                retries += 1;

                l.warn(
                    `SQLite busy during retention; ` +
                    `retry ${retries}/10`
                );

                await sleep(200);
                continue;
            }

            throw err;
        }
    }
}

/**
 * Parses an integer configuration value that may also be zero.
 */
function parseNonNegativeInteger(value, defaultValue) {
    const parsed = Number(value);

    if (
        Number.isFinite(parsed) &&
        parsed >= 0
    ) {
        return Math.floor(parsed);
    }

    return defaultValue;
}

/**
 * Parses a strictly positive integer configuration value.
 */
function parsePositiveInteger(value, defaultValue) {
    const parsed = Number(value);

    if (
        Number.isFinite(parsed) &&
        parsed > 0
    ) {
        return Math.floor(parsed);
    }

    return defaultValue;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
