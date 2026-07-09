const IrcMessage = require('irc-framework').Message;

let baseId = 'kiwibnc-'+Date.now();
let msgId = 0;

module.exports.init = async function init(hooks) {
    // echo-message support
    hooks.on('available_caps', (event) => {
        event.caps.add('echo-message');
    });
    hooks.on('wanted_caps', (event) => {
        event.wantedCaps.add('echo-message');
    });
    hooks.on('message_from_client', (event) => {
        if (!event.client.state.netRegistered) {
            return;
        }
        let upstream = event.client.upstream;
        if(!upstream) {
            return;
        }
        // If the server doesn't support echo-message we do it ourselves with our own message.
        if (!upstream.state.caps.has('echo-message')) {
            let msg = event.message;
            if(msg.command !== 'PRIVMSG' && msg.command !== 'NOTICE' && msg.command !== 'TAGMSG') {
                return;
            }
            // Give ID to original message so it is stored correctly
            msg.tags.msgid = baseId + '-' + msgId++;

            let m = new IrcMessage(msg.command, ...msg.params);
            m.tags = {...msg.tags};
            m.nick = upstream.state.nick;
            m.username = upstream.state.username;
            m.hostname = upstream.state.host;
            m.prefix = m.nick + '!' + m.username + '@' + m.hostname;

            upstream.forEachClient((client) => {
                // Don't echo back to client that sent if it's not expecting it.
                if(client === event.client && !event.client.state.caps.has('echo-message')) {
                    return;
                }
                client.writeMsg(m);
            });
        }
    });
    hooks.on('message_to_client', (event) => {
        // Disables normal bnc behavior of echoing a message to connected clients
        if(!event.client.upstream) {
            return;
        }
        let {client, message} = event;
        if(message.command === 'PRIVMSG' || message.command === 'NOTICE' || message.command === 'TAGMSG') {
            if (!client.state.caps.has('echo-message')
            && client.upstream.state.nick.toLowerCase() === (message.nick || '').toLowerCase()) {
                event.preventDefault();
            } else if(client.state.caps.has('echo-message') && message.source === 'client') {
                event.preventDefault(); // Client and server support echo-message and msg came from a client, so ignore it.
            } else if (!client.state.caps.has('echo-message') && message.source !== 'client') {
                // [nick-dup] The echo was NOT suppressed. To avoid noise from other users' traffic,
                // only flag the suspect case: the message nick matches the nick tracked on this
                // client connection (client.state.nick) but diverges from upstream.state.nick. That
                // divergence between the two nick trackers is precisely what would leak a self-echo
                // back to the sender and cause the "own messages doubled after nick change" issue.
                let msgNick = (message.nick || '').toLowerCase();
                let clientNick = (client.state.nick || '').toLowerCase();
                let upstreamNick = (client.upstream.state.nick || '').toLowerCase();
                if (msgNick && msgNick === clientNick && msgNick !== upstreamNick) {
                    l.info(`[nick-dup] self-echo LEAKED cmd=${message.command} message.nick=${message.nick} client.state.nick=${client.state.nick} upstream.state.nick=${client.upstream.state.nick} target=${message.params && message.params[0]}`);
                }
            }
        }
    });
};
