'use strict';

/**
 * Tests for the echo-message extension in src/extensions/echo-message/
 *
 * Focus: the message_to_client hook that suppresses echoing a client's own
 * message back to it. For a client without the echo-message cap this is the
 * only thing preventing the user's own messages being shown twice (optimistic
 * local render + echo). The suppression must match the sender's nick
 * case-insensitively (a case-sensitive compare leaked the echo after a nick
 * change) and must not throw if a nick is unset.
 */

describe('echo-message message_to_client suppression', () => {
    let echoModule;
    let hooks;

    beforeEach(() => {
        hooks = {
            handlers: {},
            on: function(event, handler) {
                (this.handlers[event] = this.handlers[event] || []).push(handler);
            },
            emit: async function(event, data) {
                if (this.handlers[event]) {
                    for (const handler of this.handlers[event]) {
                        await handler(data);
                    }
                }
            },
        };

        global.l = { info: jest.fn(), debug: jest.fn(), error: jest.fn() };

        delete require.cache[require.resolve('../../src/extensions/echo-message/index')];
        echoModule = require('../../src/extensions/echo-message/index');
        echoModule.init(hooks);
    });

    afterEach(() => {
        delete global.l;
    });

    // Build the event passed to the message_to_client hook.
    function makeEvent({ clientCaps = [], upstreamNick = 'SoSo', message }) {
        return {
            prevented: false,
            preventDefault() { this.prevented = true; },
            client: {
                state: { caps: new Set(clientCaps), nick: upstreamNick },
                upstream: { state: { nick: upstreamNick } },
            },
            message,
        };
    }

    function privmsg(nick, source) {
        return { command: 'PRIVMSG', nick, params: ['#chan', 'hi'], source, tags: {} };
    }

    it('suppresses the client\'s own echo (nick matches, same case)', async () => {
        const event = makeEvent({ upstreamNick: 'SoSo', message: privmsg('SoSo') });
        await hooks.emit('message_to_client', event);
        expect(event.prevented).toBe(true);
    });

    it('suppresses the client\'s own echo when nick casing differs', async () => {
        // The regression: a case-sensitive compare left this un-suppressed.
        const event = makeEvent({ upstreamNick: 'SoSo', message: privmsg('soso') });
        await hooks.emit('message_to_client', event);
        expect(event.prevented).toBe(true);
    });

    it('does not suppress a message from a different nick', async () => {
        const event = makeEvent({ upstreamNick: 'SoSo', message: privmsg('SomeoneElse') });
        await hooks.emit('message_to_client', event);
        expect(event.prevented).toBe(false);
    });

    it('suppresses client-sourced messages for echo-message clients', async () => {
        const event = makeEvent({
            clientCaps: ['echo-message'],
            upstreamNick: 'SoSo',
            message: privmsg('SoSo', 'client'),
        });
        await hooks.emit('message_to_client', event);
        expect(event.prevented).toBe(true);
    });

    it('does not throw when the upstream nick is unset', async () => {
        const event = makeEvent({ upstreamNick: undefined, message: privmsg(undefined) });
        await expect(hooks.emit('message_to_client', event)).resolves.not.toThrow();
    });

    it('ignores clients with no upstream', async () => {
        const event = {
            prevented: false,
            preventDefault() { this.prevented = true; },
            client: { state: { caps: new Set() }, upstream: null },
            message: privmsg('SoSo'),
        };
        await hooks.emit('message_to_client', event);
        expect(event.prevented).toBe(false);
    });
});
