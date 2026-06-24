'use strict';

const { createMockState, createMockMessage } = require('../helpers/mocks');

// Exercises the upstream CAP negotiation in upstreamcommands.js, focusing on the
// CAP LIST reconciliation that self-heals a caps set left incomplete by an ACK
// lost between the sockets and worker processes.
describe('upstream CAP negotiation', () => {
    let UpstreamCommands;
    let hooks;

    beforeEach(() => {
        global.l = Object.assign(jest.fn(), { debug: jest.fn(), info: jest.fn(), error: jest.fn(), trace: jest.fn(), warn: jest.fn() });
        global.config = { get: jest.fn().mockReturnValue(500) };

        jest.resetModules();
        jest.doMock('../../src/worker/hooks', () => ({
            emit: jest.fn(async (eventName, event) => {
                // The echo-message extension adds this via the wanted_caps hook.
                if (eventName === 'wanted_caps') {
                    event.wantedCaps.add('echo-message');
                }
                return { prevent: false, event };
            }),
        }));

        hooks = require('../../src/worker/hooks');
        UpstreamCommands = require('../../src/worker/upstreamcommands');
    });

    afterEach(() => {
        delete global.l;
        delete global.config;
        jest.resetModules();
    });

    function createUpstream(caps = [], stateOptions = {}) {
        const state = createMockState(caps, {
            netRegistered: false,
            receivedMotd: false,
            ...stateOptions,
        });
        state.sasl = stateOptions.sasl || { account: '', password: '' };
        state.receivedMotd = stateOptions.receivedMotd || false;

        return {
            id: 'up-1',
            state,
            writeLine: jest.fn(),
            throttle: jest.fn(),
            forEachClient: jest.fn(),
        };
    }

    function capMsg(...params) {
        return createMockMessage('CAP', params, { prefix: 'irc.test.server' });
    }

    it('requests offered caps then ends with CAP LIST before CAP END', async () => {
        const con = createUpstream();

        // Server offers caps including echo-message
        await UpstreamCommands.run(
            capMsg('*', 'LS', 'multi-prefix echo-message server-time'),
            con
        );

        // We should REQ the caps we want (no LIST/END yet - waiting on ACK)
        const reqCall = con.writeLine.mock.calls.find((c) => c[0] === 'CAP' && c[1] === 'REQ');
        expect(reqCall).toBeTruthy();
        expect(reqCall[2]).toContain('echo-message');

        con.writeLine.mockClear();

        // Server ACKs them -> we end negotiation. CAP LIST must be sent before END.
        await UpstreamCommands.run(
            capMsg('*', 'ACK', 'multi-prefix echo-message server-time'),
            con
        );

        const calls = con.writeLine.mock.calls.filter((c) => c[0] === 'CAP');
        const listIdx = calls.findIndex((c) => c[1] === 'LIST');
        const endIdx = calls.findIndex((c) => c[1] === 'END');
        expect(listIdx).toBeGreaterThanOrEqual(0);
        expect(endIdx).toBeGreaterThanOrEqual(0);
        expect(listIdx).toBeLessThan(endIdx);
    });

    it('reconciles caps from CAP LIST, healing an ACK that was lost during negotiation', async () => {
        // Simulate the bug state: the worker missed the echo-message ACK, so its
        // caps set is incomplete even though the server enabled it.
        const con = createUpstream(['multi-prefix', 'server-time']);
        expect(con.state.caps.has('echo-message')).toBe(false);

        // The authoritative CAP LIST reply includes echo-message.
        await UpstreamCommands.run(
            capMsg('*', 'LIST', 'multi-prefix echo-message server-time'),
            con
        );

        expect(con.state.caps.has('echo-message')).toBe(true);
        expect(con.state._dirty).toBe(true);
    });

    it('drops caps from the set that the server no longer reports in LIST', async () => {
        // Local set wrongly thinks echo-message is on; LIST is authoritative.
        const con = createUpstream(['multi-prefix', 'echo-message', 'server-time']);

        await UpstreamCommands.run(
            capMsg('*', 'LIST', 'multi-prefix server-time'),
            con
        );

        expect(con.state.caps.has('echo-message')).toBe(false);
        expect(con.state.caps.has('multi-prefix')).toBe(true);
    });

    it('accumulates a multiline CAP LIST before reconciling', async () => {
        const con = createUpstream([]);

        // Continuation line (params[2] === '*')
        await UpstreamCommands.run(
            capMsg('nick', 'LIST', '*', 'multi-prefix echo-message'),
            con
        );
        // Not reconciled yet - waiting for the final line
        expect(con.state.caps.has('echo-message')).toBe(false);

        // Final line
        await UpstreamCommands.run(
            capMsg('nick', 'LIST', 'server-time'),
            con
        );

        expect(con.state.caps.has('echo-message')).toBe(true);
        expect(con.state.caps.has('multi-prefix')).toBe(true);
        expect(con.state.caps.has('server-time')).toBe(true);
    });

    it('strips =value suffixes from LIST caps so bare-name lookups match', async () => {
        const con = createUpstream([]);

        await UpstreamCommands.run(
            capMsg('*', 'LIST', 'sasl=PLAIN echo-message'),
            con
        );

        expect(con.state.caps.has('sasl')).toBe(true);
        expect(con.state.caps.has('echo-message')).toBe(true);
    });
});
