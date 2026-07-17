'use strict';

const EventEmitter = require('../../src/libs/eventemitter');
const IrcMessage = require('irc-framework').Message;
const {
    createMockClient,
    createMockUpstream,
} = require('../helpers/mocks');

/**
 * Tests for labeled-response support in the echo-message extension.
 *
 * The extension relays a client's labeled PRIVMSG/NOTICE/TAGMSG upstream under a
 * namespaced label, then correlates the upstream echo (echo-message) back to the
 * originating client with its original label so it can reconcile its optimistic copy.
 */

function ircMsg(command, params = [], tags = {}, nick = '') {
    let m = new IrcMessage(command, ...params);
    Object.assign(m.tags, tags);
    if (nick) {
        m.nick = nick;
    }
    return m;
}

describe('echo-message labeled-response relay', () => {
    let hooks;
    let upstream;

    beforeEach(() => {
        hooks = new EventEmitter();

        // The extension emits [label] diagnostic logging via the global logger
        global.l = { info: jest.fn(), debug: jest.fn(), trace: jest.fn(), error: jest.fn() };

        // Clear module state (label maps, counters) between tests
        delete require.cache[require.resolve('../../src/extensions/echo-message/index')];
        const ext = require('../../src/extensions/echo-message/index');
        ext.init(hooks);

        upstream = createMockUpstream({
            caps: ['echo-message', 'labeled-response', 'message-tags'],
        });
        upstream.state.connected = true;
        upstream.forEachClient = jest.fn();
    });

    afterEach(() => {
        delete global.l;
    });

    function makeClient(id, caps) {
        return createMockClient(id, caps, { upstream });
    }

    it('advertises and wants echo-message + labeled-response', async () => {
        let caps = new Set();
        await hooks.emit('available_caps', { client: {}, caps });
        expect(caps.has('echo-message')).toBe(true);
        expect(caps.has('labeled-response')).toBe(true);

        let wantedCaps = new Set();
        await hooks.emit('wanted_caps', { client: {}, wantedCaps });
        expect(wantedCaps.has('echo-message')).toBe(true);
        expect(wantedCaps.has('labeled-response')).toBe(true);
    });

    it('replaces a client label with a namespaced label before going upstream', async () => {
        const client = makeClient('client-1', ['labeled-response']);
        const msg = ircMsg('PRIVMSG', ['#chan', 'hello'], { label: 'abc123' });

        await hooks.emit('message_from_client', { client, message: msg });

        expect(msg.tags.label).toBeDefined();
        expect(msg.tags.label).not.toBe('abc123');
        expect(msg.tags.label.startsWith('kbnc-')).toBe(true);
        expect(msg.bncLabelRelayed).toBe(true);
    });

    it('routes the correlated upstream echo: label to the sender, plain echo to others', async () => {
        const sender = makeClient('client-1', ['labeled-response', 'echo-message', 'message-tags']);
        const other = makeClient('client-2', []);

        const sent = ircMsg('PRIVMSG', ['#chan', 'hello'], { label: 'abc123' });
        await hooks.emit('message_from_client', { client: sender, message: sent });
        const bncLabel = sent.tags.label;

        // Upstream echoes the message back with our namespaced label + real msgid
        const echo = ircMsg('PRIVMSG', ['#chan', 'hello'], { label: bncLabel, msgid: 'real-id' }, 'testnick');
        await hooks.emit('message_from_upstream', { client: upstream, message: echo });

        // Label stripped before it can reach stored history
        expect(echo.tags.label).toBeUndefined();
        expect(echo.bncLabelEcho).toEqual({ clientId: 'client-1', clientLabel: 'abc123' });

        const hook = await hooks.emit('message_to_clients', { clients: [sender, other], message: echo });
        expect(hook.prevent).toBe(true);

        expect(sender.writeMsg).toHaveBeenCalledTimes(1);
        const senderMsg = sender.writeMsg.mock.calls[0][0];
        expect(senderMsg.tags.label).toBe('abc123');
        expect(senderMsg.tags.msgid).toBe('real-id');
        expect(senderMsg.bncEchoRelay).toBe(true);

        expect(other.writeMsg).toHaveBeenCalledTimes(1);
        const otherMsg = other.writeMsg.mock.calls[0][0];
        expect(otherMsg.tags.label).toBeUndefined();
        expect(otherMsg.tags.msgid).toBe('real-id');
        expect(otherMsg.bncEchoRelay).toBe(true);
    });

    it('answers with ACK when the sender lacks echo-message', async () => {
        const sender = makeClient('client-1', ['labeled-response']);

        const sent = ircMsg('PRIVMSG', ['#chan', 'hello'], { label: 'abc123' });
        await hooks.emit('message_from_client', { client: sender, message: sent });

        const echo = ircMsg('PRIVMSG', ['#chan', 'hello'], { label: sent.tags.label, msgid: 'real-id' }, 'testnick');
        await hooks.emit('message_from_upstream', { client: upstream, message: echo });
        await hooks.emit('message_to_clients', { clients: [sender], message: echo });

        expect(sender.writeMsg).toHaveBeenCalledTimes(1);
        const ack = sender.writeMsg.mock.calls[0][0];
        expect(ack.command).toBe('ACK');
        expect(ack.tags.label).toBe('abc123');
    });

    it('correlates echoes wrapped in a labeled BATCH and swallows the wrappers', async () => {
        const sender = makeClient('client-1', ['labeled-response', 'echo-message', 'message-tags']);

        const sent = ircMsg('PRIVMSG', ['#chan', 'hello'], { label: 'abc123' });
        await hooks.emit('message_from_client', { client: sender, message: sent });
        const bncLabel = sent.tags.label;

        const batchOpen = ircMsg('BATCH', ['+b1', 'labeled-response'], { label: bncLabel });
        await hooks.emit('message_from_upstream', { client: upstream, message: batchOpen });
        expect(batchOpen.bncLabelBatch).toBe(true);
        expect(batchOpen.tags.label).toBeUndefined();

        let hook = await hooks.emit('message_to_clients', { clients: [sender], message: batchOpen });
        expect(hook.prevent).toBe(true);

        const echo = ircMsg('PRIVMSG', ['#chan', 'hello'], { batch: 'b1', msgid: 'real-id' }, 'testnick');
        await hooks.emit('message_from_upstream', { client: upstream, message: echo });
        expect(echo.tags.batch).toBeUndefined();
        expect(echo.bncLabelEcho).toEqual({ clientId: 'client-1', clientLabel: 'abc123' });

        const batchClose = ircMsg('BATCH', ['-b1']);
        await hooks.emit('message_from_upstream', { client: upstream, message: batchClose });
        expect(batchClose.bncLabelBatch).toBe(true);

        hook = await hooks.emit('message_to_clients', { clients: [sender], message: batchClose });
        expect(hook.prevent).toBe(true);
    });

    it('ACKs labeled non-message commands (catch-all)', async () => {
        const client = makeClient('client-1', ['labeled-response']);
        const msg = ircMsg('JOIN', ['#chan'], { label: 'xyz' });

        await hooks.emit('message_from_client', { client, message: msg });

        expect(msg.tags.label).toBeUndefined();
        expect(client.writeMsg).toHaveBeenCalledTimes(1);
        const ack = client.writeMsg.mock.calls[0][0];
        expect(ack.command).toBe('ACK');
        expect(ack.tags.label).toBe('xyz');
    });

    it('ACKs immediately when upstream cannot carry labels', async () => {
        upstream.state.caps = new Set(['echo-message']);
        const client = makeClient('client-1', ['labeled-response']);
        const msg = ircMsg('PRIVMSG', ['#chan', 'hello'], { label: 'abc123' });

        await hooks.emit('message_from_client', { client, message: msg });

        expect(msg.tags.label).toBeUndefined();
        expect(msg.bncLabelRelayed).toBeUndefined();
        expect(client.writeMsg).toHaveBeenCalledTimes(1);
        expect(client.writeMsg.mock.calls[0][0].command).toBe('ACK');
    });

    it('ACKs when upstream lacks message-tags (labels would be wiped by write())', async () => {
        upstream.state.caps = new Set(['echo-message', 'labeled-response']);
        const client = makeClient('client-1', ['labeled-response']);
        const msg = ircMsg('PRIVMSG', ['#chan', 'hello'], { label: 'abc123' });

        await hooks.emit('message_from_client', { client, message: msg });

        expect(msg.tags.label).toBeUndefined();
        expect(msg.bncLabelRelayed).toBeUndefined();
        expect(client.writeMsg).toHaveBeenCalledTimes(1);
        expect(client.writeMsg.mock.calls[0][0].command).toBe('ACK');
    });

    it('ACKs labeled commands when there is no upstream', async () => {
        const client = createMockClient('client-1', ['labeled-response'], { upstream: null });
        const msg = ircMsg('PRIVMSG', ['*bnc', 'hello'], { label: 'abc123' });

        await hooks.emit('message_from_client', { client, message: msg });

        expect(msg.tags.label).toBeUndefined();
        expect(client.writeMsg).toHaveBeenCalledTimes(1);
        const ack = client.writeMsg.mock.calls[0][0];
        expect(ack.command).toBe('ACK');
        expect(ack.tags.label).toBe('abc123');
    });

    it('ACKs labeled messages targeting *bnc instead of relaying them', async () => {
        const client = makeClient('client-1', ['labeled-response']);
        const msg = ircMsg('PRIVMSG', ['*bnc', 'help'], { label: 'abc123' });

        await hooks.emit('message_from_client', { client, message: msg });

        expect(msg.tags.label).toBeUndefined();
        expect(msg.bncLabelRelayed).toBeUndefined();
        expect(client.writeMsg).toHaveBeenCalledTimes(1);
        expect(client.writeMsg.mock.calls[0][0].command).toBe('ACK');
    });

    it('leaves the label unanswered when the upstream is disconnected', async () => {
        upstream.state.connected = false;
        const client = makeClient('client-1', ['labeled-response']);
        const msg = ircMsg('PRIVMSG', ['#chan', 'hello'], { label: 'abc123' });

        await hooks.emit('message_from_client', { client, message: msg });

        // No relay and no ACK: the client's own timeout marks the message unsent
        expect(msg.tags.label).toBeUndefined();
        expect(msg.bncLabelRelayed).toBeUndefined();
        expect(client.writeMsg).not.toHaveBeenCalled();
    });

    it('ignores labels echoed by a different upstream connection', async () => {
        const sender = makeClient('client-1', ['labeled-response', 'echo-message', 'message-tags']);

        const sent = ircMsg('PRIVMSG', ['#chan', 'hello'], { label: 'abc123' });
        await hooks.emit('message_from_client', { client: sender, message: sent });
        const bncLabel = sent.tags.label;

        // A hostile server on another user's network forges the label
        const otherUpstream = createMockUpstream({ id: 'upstream-evil' });
        const forged = ircMsg('PRIVMSG', ['#chan', 'gotcha'], { label: bncLabel, msgid: 'fake' }, 'testnick');
        await hooks.emit('message_from_upstream', { client: otherUpstream, message: forged });
        expect(forged.bncLabelEcho).toBeUndefined();

        // The real echo still correlates: the pending entry was not consumed
        const echo = ircMsg('PRIVMSG', ['#chan', 'hello'], { label: bncLabel, msgid: 'real-id' }, 'testnick');
        await hooks.emit('message_from_upstream', { client: upstream, message: echo });
        expect(echo.bncLabelEcho).toEqual({ clientId: 'client-1', clientLabel: 'abc123' });
    });

    it('ignores forged labeled batches from a different upstream connection', async () => {
        const sender = makeClient('client-1', ['labeled-response', 'echo-message', 'message-tags']);

        const sent = ircMsg('PRIVMSG', ['#chan', 'hello'], { label: 'abc123' });
        await hooks.emit('message_from_client', { client: sender, message: sent });
        const bncLabel = sent.tags.label;

        // A hostile server opens then closes a batch with the forged label,
        // trying to get the pending entry deleted via the batch-close path
        const otherUpstream = createMockUpstream({ id: 'upstream-evil' });
        const forgedOpen = ircMsg('BATCH', ['+f1', 'labeled-response'], { label: bncLabel });
        await hooks.emit('message_from_upstream', { client: otherUpstream, message: forgedOpen });
        expect(forgedOpen.bncLabelBatch).toBeUndefined();

        const forgedClose = ircMsg('BATCH', ['-f1']);
        await hooks.emit('message_from_upstream', { client: otherUpstream, message: forgedClose });

        // The real echo still correlates: the pending entry survived
        const echo = ircMsg('PRIVMSG', ['#chan', 'hello'], { label: bncLabel, msgid: 'real-id' }, 'testnick');
        await hooks.emit('message_from_upstream', { client: upstream, message: echo });
        expect(echo.bncLabelEcho).toEqual({ clientId: 'client-1', clientLabel: 'abc123' });
    });

    it('strips labels from clients without the labeled-response cap, without relaying', async () => {
        const client = makeClient('client-1', []);
        const msg = ircMsg('PRIVMSG', ['#chan', 'hello'], { label: 'abc123' });

        await hooks.emit('message_from_client', { client, message: msg });

        expect(msg.tags.label).toBeUndefined();
        expect(msg.bncLabelRelayed).toBeUndefined();
        expect(client.writeMsg).not.toHaveBeenCalled();
    });

    it('attaches the label to the locally generated echo when upstream lacks echo-message', async () => {
        upstream.state.caps = new Set();
        const sender = makeClient('client-1', ['labeled-response', 'echo-message', 'message-tags']);
        const other = makeClient('client-2', []);
        upstream.forEachClient = jest.fn((fn) => {
            [sender, other].forEach(fn);
        });

        const msg = ircMsg('PRIVMSG', ['#chan', 'hello'], { label: 'abc123' });
        await hooks.emit('message_from_client', { client: sender, message: msg });

        // The original message must not carry the label (or a msgid) upstream
        expect(msg.tags.label).toBeUndefined();
        expect(msg.tags.msgid).toBeUndefined();

        expect(sender.writeMsg).toHaveBeenCalledTimes(1);
        const senderEcho = sender.writeMsg.mock.calls[0][0];
        expect(senderEcho.command).toBe('PRIVMSG');
        expect(senderEcho.tags.label).toBe('abc123');
        expect(senderEcho.tags.msgid).toBeDefined();

        expect(other.writeMsg).toHaveBeenCalledTimes(1);
        const otherEcho = other.writeMsg.mock.calls[0][0];
        expect(otherEcho.tags.label).toBeUndefined();
        expect(otherEcho.tags.msgid).toBe(senderEcho.tags.msgid);
    });

    it('bypasses own-message suppression for relayed echoes', async () => {
        const client = makeClient('client-1', []);

        // Normal own-nick message to a non-echo-message client is suppressed
        const plain = ircMsg('PRIVMSG', ['#chan', 'hello'], {}, 'testnick');
        let hook = await hooks.emit('message_to_client', { client, message: plain });
        expect(hook.prevent).toBe(true);

        // But a message routed by the labeled echo relay is not
        const relayed = ircMsg('PRIVMSG', ['#chan', 'hello'], {}, 'testnick');
        relayed.bncEchoRelay = true;
        hook = await hooks.emit('message_to_client', { client, message: relayed });
        expect(hook.prevent).toBe(false);
    });
});
