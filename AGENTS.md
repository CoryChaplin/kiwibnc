# Kiwibnc Agent Notes

## Project snapshot
- Node.js IRC bouncer with a two-process architecture: sockets keep TCP connections alive, worker holds IRC/app logic.
- Queue between sockets/worker is IPC by default, AMQP (RabbitMQ) if `queue.amqp_host` is set.
- Supports IRCv3 features, extensions, and message history via sqlite/flat file/custom store.

## Entry points and flow
- CLI entry: `src/server.js` (also exported as bin `kiwibnc` and `kiwibnc.js` wrapper).
- Default command (`run`) starts socket layer in-process and forks a worker; worker is auto-restarted on exit. See `src/actions/run.js`.
- Config + logger + stats are set up in `src/libs/bootstrap.js`.

## Key directories
- `src/actions/`: CLI commands (`adduser`, `deleteuser`, `listusers`, `updatedb`, `run`).
- `src/sockets/`: Socket layer, keeps TCP/WS/TLS connections alive (`sockets.js`, `socketserver.js`, `connection.js`).
- `src/worker/`: Core logic (IRC parsing, connections, hooks, extensions, webserver).
- `src/extensions/`: Built-in plugins (bouncer, replyrouter, webchat, chathistory, etc.).
- `src/libs/`: Shared utilities (config, database, queue, logger, helpers, stats).
- `src/dbschemas/`: Knex migration files for `connections` and `users` DBs.
- `src/configProfileTemplate/`: Default config template copied on first run.
- `tests/unit/`: Jest unit tests.

## Running locally
- Install deps: `npm install`.
- Start bouncer: `npm start` or `node src/server.js`.
- On first run, config is generated in `~/.kiwibnc/config.ini` from `src/configProfileTemplate/config.ini`.
- Use a custom config: `node src/server.js --config=/path/to/config.ini`.
- Interactive reload (worker only): `node src/server.js --interactive` then press `r`.

## Configuration notes
- Config is TOML (`src/configProfileTemplate/config.ini`).
- `$ENV_NAME` substitutions come from `.env` next to the config file or process env.
- Per-key overrides via env vars: `BNC_SECTION_KEY` (eg `BNC_LOG_LEVEL`).
- `database.crypt_key` must be 32 chars or startup exits.
- Webserver is Koa and binds to a unix socket by default (`/tmp/kiwibnc_httpd.sock`).
- `webchat` extension will download Kiwi IRC on first run if `webserver.public_dir` is empty (requires network).

## Data storage and migrations
- `connections.db`: sqlite state for active connections (used for zero-downtime worker restarts).
- `users.db`: sqlite by default; can be Postgres/MySQL via connection string.
- Migrations run at startup or via `node src/server.js updatedb`.
- Message stores:
  - sqlite (`logging.database`) supports read/write for CHATHISTORY.
  - flat file (`logging.files`) write-only.
  - custom store via `logging.custom` path.

## Extensions and hooks
- Extensions live under `src/extensions/<name>/index.js` and export `init(hooks, app)`.
- Loaded from `extensions.loaded` in config; built-ins include `bouncer`, `replyrouter`, `chathistory`, `webchat`.
- Hook system is in `src/worker/hooks.js` (caps, message filters, events).

## Web server + status
- Koa app in `src/worker/worker.js` serves static files and status endpoints.
- Status endpoints are under `webserver.status_path` (default `/status`) and CIDR-guarded.

## Testing
- Jest config: `jest.config.js` (unit tests under `tests/unit`).
- Run: `npm test`.

## Tools
- `src/tools/testspeed.js`: throughput benchmark for socket/worker messaging.
- `src/tools/recover.js` + `src/tools/recover_worker.js`: test worker restart safety.

## Conventions
- Logging via global `l` (`l.info`, `l.warn`, etc), configured from `log.level` and `log.colour`.
- Use `app.conf.get('section.key', default)` for config and `app.queue` for socket/worker messaging.
- Worker has a central `app` object with `conf`, `db`, `queue`, `cons`, `stats`, and `messages`.
