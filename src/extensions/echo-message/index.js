const IrcMessage = require('irc-framework').Message;
const { cloneIrcMessage } = require('../../libs/helpers');

let baseId = 'kiwibnc-'+Date.now();
let msgId = 0;

const MESSAGE_COMMANDS = ['PRIVMSG', 'NOTICE', 'TAGMSG'];

// labeled-response relay state.
// A client's label is never forwarded verbatim: it is replaced with a namespaced
// BNC label before going upstream, and mapped back when the upstream echoes the
// message (echo-message) so the originating client can reconcile its optimistic copy.
const LABEL_PREFIX = 'kbnc-';
const LABEL_TTL = 60 * 1000;
let labelCounter = 0;

// bncLabel -> {clientId, clientLabel, added}
let pendingLabels = new Map();
// `${upstreamConId} ${batchId}` -> bncLabel, for labeled responses wrapped in a BATCH
let openLabelBatches = new Map();

function nextBncLabel() {
    return LABEL_PREFIX + Date.now().toString(36) + '-' + (labelCounter++);
}

function isBncLabel(label) {
    return typeof label === 'string' && label.startsWith(LABEL_PREFIX);
}

function sweepPendingLabels() {
    // Map iteration is in insertion order == time order, so stop at the first fresh entry
    let now = Date.now();
    for (let [label, entry] of pendingLabels) {
        if (now - entry.added < LABEL_TTL) {
            break;
        }
        pendingLabels.delete(label);
    }
}

// labeled-response spec: a labeled command that produces no response must be answered
// with an ACK carrying the label back
function sendAck(client, label) {
    let m = new IrcMessage('ACK');
    m.prefix = (client.upstream && client.upstream.state.serverPrefix) || '*bnc';
    if (label) {
        m.tags['label'] = label;
    }
    client.writeMsg(m);
}

module.exports.init = async function init(hooks) {
    // echo-message + labeled-response support
    hooks.on('available_caps', (event) => {
        event.caps.add('echo-message');
        event.caps.add('labeled-response');
    });
    hooks.on('wanted_caps', (event) => {
        event.wantedCaps.add('echo-message');
        event.wantedCaps.add('labeled-response');
    });

    hooks.on('message_from_client', (event) => {
        let msg = event.message;
        let client = event.client;

        // Capture then remove any client label. It must never leak upstream,
        // into stored history, or to other clients as-is.
        let clientLabel = msg.tags['label'];
        if (clientLabel !== undefined) {
            delete msg.tags['label'];
        }

        if (!client.state.netRegistered) {
            return;
        }
        let upstream = client.upstream;
        if (!upstream) {
            return;
        }

        let command = msg.command.toUpperCase();
        let isMessageCmd = MESSAGE_COMMANDS.includes(command);
        let hasLabel = !!clientLabel && client.state.caps.has('labeled-response');

        if (hasLabel && !isMessageCmd) {
            // Catch-all: we can't correlate upstream responses for other commands,
            // so complete the label contract with an ACK
            sendAck(client, clientLabel);
            return;
        }

        let upstreamEcho = upstream.state.caps.has('echo-message');

        if (upstreamEcho) {
            if (!hasLabel) {
                // Upstream will echo the message; nothing more to do here
                return;
            }

            if (upstream.state.caps.has('labeled-response')) {
                // Relay the label upstream under our own namespace. The upstream echo
                // will come back with it and gets routed in message_from_upstream below.
                let bncLabel = nextBncLabel();
                msg.tags['label'] = bncLabel;
                pendingLabels.set(bncLabel, {
                    clientId: client.id,
                    clientLabel: clientLabel,
                    added: Date.now(),
                });
                sweepPendingLabels();

                // Tell clientcommands to skip its own fan-out to other clients; the
                // relayed upstream echo (carrying the real msgid) covers everyone
                msg.bncLabelRelayed = true;
            } else {
                // Upstream echoes but can't carry our label. The echo can't be
                // correlated, so at least ACK the label; the client falls back to
                // heuristic reconciliation.
                sendAck(client, clientLabel);
            }
            return;
        }

        // No upstream echo-message: generate the echo ourselves
        if (!isMessageCmd) {
            return;
        }

        let m = new IrcMessage(msg.command, ...msg.params);
        m.tags = {...msg.tags};
        m.tags.msgid = baseId + '-' + msgId++;
        m.nick = upstream.state.nick;
        m.username = upstream.state.username;
        m.hostname = upstream.state.host;
        m.prefix = m.nick + '!' + m.username + '@' + m.hostname;

        if (hasLabel && !client.state.caps.has('echo-message')) {
            // The sender won't get the echo below, answer its label with an ACK
            sendAck(client, clientLabel);
        }

        upstream.forEachClient((c) => {
            // Don't echo back to the sending client if it's not expecting it
            if (c === client && !client.state.caps.has('echo-message')) {
                return;
            }

            let echoMsg = cloneIrcMessage(m);
            if (c === client && hasLabel) {
                // The echo is the labeled response to the sender's command
                echoMsg.tags['label'] = clientLabel;
            }
            c.writeMsg(echoMsg);
        });
    });

    hooks.on('message_from_upstream', (event) => {
        let msg = event.message;
        let upstream = event.client;
        let command = msg.command.toUpperCase();

        // Labeled responses may be wrapped in a BATCH carrying the label
        if (command === 'BATCH') {
            let ref = msg.params[0] || '';
            let batchKey = upstream.id + ' ' + ref.substring(1);
            if (ref[0] === '+' && isBncLabel(msg.tags['label'])) {
                openLabelBatches.set(batchKey, msg.tags['label']);
                delete msg.tags['label'];
                // Never forward our internal batch wrappers to clients
                msg.bncLabelBatch = true;
            } else if (ref[0] === '-' && openLabelBatches.has(batchKey)) {
                pendingLabels.delete(openLabelBatches.get(batchKey));
                openLabelBatches.delete(batchKey);
                msg.bncLabelBatch = true;
            }
            return;
        }

        // Correlate a labeled response, either labeled directly or via a labeled batch.
        // Strip the label/batch tags here so they never reach stored history
        // (storeMessage runs after this hook)
        let bncLabel = null;
        let viaBatch = false;
        if (isBncLabel(msg.tags['label'])) {
            bncLabel = msg.tags['label'];
            delete msg.tags['label'];
        } else if (msg.tags['batch'] && openLabelBatches.has(upstream.id + ' ' + msg.tags['batch'])) {
            bncLabel = openLabelBatches.get(upstream.id + ' ' + msg.tags['batch']);
            delete msg.tags['batch'];
            viaBatch = true;
        }

        if (!bncLabel) {
            return;
        }

        let entry = pendingLabels.get(bncLabel);
        if (!entry) {
            return;
        }
        if (!viaBatch) {
            // Directly labeled = single response, we're done with this label.
            // Batched responses keep the entry until the closing BATCH
            pendingLabels.delete(bncLabel);
        }

        // Carry the routing info on the message object for message_to_clients below
        // (it runs before the per-client cloning, so the property survives)
        msg.bncLabelEcho = {clientId: entry.clientId, clientLabel: entry.clientLabel};
    });

    hooks.on('message_to_clients', (event) => {
        let msg = event.message;

        if (msg.bncLabelBatch) {
            event.preventDefault();
            return;
        }

        let echo = msg.bncLabelEcho;
        if (!echo) {
            return;
        }

        // This is the correlated response to a labeled client command; deliver it
        // ourselves so the originating client gets its label back
        event.preventDefault();

        let isMessageCmd = MESSAGE_COMMANDS.includes(msg.command.toUpperCase());

        for (let client of event.clients) {
            if (client.id === echo.clientId) {
                if (isMessageCmd && !client.state.caps.has('echo-message')) {
                    // The sender doesn't expect its own echo; complete the label with an ACK
                    sendAck(client, echo.clientLabel);
                    continue;
                }

                let m = cloneIrcMessage(msg);
                if (echo.clientLabel) {
                    m.tags['label'] = echo.clientLabel;
                }
                m.bncEchoRelay = true;
                client.writeMsg(m);
            } else if (isMessageCmd) {
                // Other clients get the real upstream echo. It carries the upstream
                // msgid, matching what's in stored history (the old BNC fan-out sent
                // a BNC-generated msgid instead, causing replay duplicates)
                let m = cloneIrcMessage(msg);
                m.bncEchoRelay = true;
                client.writeMsg(m);
            }
            // Correlated non-message responses (ACK, numerics, ...) only go to the requester
        }
    });

    hooks.on('message_to_client', (event) => {
        // Disables normal bnc behavior of echoing a message to connected clients
        if(!event.client.upstream) {
            return;
        }
        let {client, message} = event;
        if (message.bncEchoRelay) {
            // Already routed by the labeled echo relay above
            return;
        }
        if(MESSAGE_COMMANDS.includes(message.command)) {
            if (!client.state.caps.has('echo-message')
            && client.upstream.state.nick === message.nick) {
                event.preventDefault();
            } else if(client.state.caps.has('echo-message') && message.source === 'client') {
                event.preventDefault(); // Client and server support echo-message and msg came from a client, so ignore it.
            }
        }
    });
};
