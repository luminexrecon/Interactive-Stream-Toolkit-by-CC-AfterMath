/* WebSocket clients the bot uses to talk to server.js, as if it were
 * another control panel. server.js exposes 4 namespaces the bot needs:
 *
 *   /point-spinner/ws      read the item pool/settings, trigger spins
 *   /economy/ws            check/earn/spend the chat-earned currency
 *   /live-auction/ws       submit !joinbid / !bid
 *   /exclusive-auction/ws  submit !joinex / !bidex / !give, check balance
 *
 * All 4 share the exact same connect/reconnect/request-reply pattern, so
 * it's implemented once here (createClient) instead of as 4 separate
 * near-identical files -- this bot is the only consumer, so there's no
 * reuse benefit to splitting it up further.
 */

var WebSocket = require('ws');

/** Generic connect/reconnect + request/reply client.
 * `stateMessageType` (optional) names a message type the server pushes
 * proactively (on connect, and again on every broadcast) that should be
 * treated as "the current full state" rather than a reply to a specific
 * request -- e.g. 'state' for point-spinner/live-auction/exclusive-auction.
 * Messages of that type are stored and handed back by getState(); anything
 * else is matched to a pending request() call by its requestId. */
function createClient(url, label, stateMessageType) {
  var socket = null;
  var connected = false;
  var latestState = null;
  var pendingResolvers = {};
  var reqCounter = 0;

  function log() {
    var args = Array.prototype.slice.call(arguments);
    console.log.apply(console, ['[' + label + ']'].concat(args));
  }

  function open() {
    socket = new WebSocket(url);

    socket.on('open', function () {
      connected = true;
      log('connected to', url);
    });

    socket.on('message', function (raw) {
      var msg;
      try {
        msg = JSON.parse(raw);
      } catch (err) {
        return;
      }
      if (stateMessageType && msg.type === stateMessageType) {
        latestState = msg;
        return;
      }
      if (msg.requestId && pendingResolvers[msg.requestId]) {
        pendingResolvers[msg.requestId](msg);
        delete pendingResolvers[msg.requestId];
      }
    });

    socket.on('close', function () {
      connected = false;
      log('disconnected, retrying in 2s...');
      setTimeout(open, 2000);
    });

    socket.on('error', function (err) {
      log('connection error:', err.message);
      try {
        socket.close();
      } catch (e) {}
    });
  }

  open();

  function getState() {
    return latestState;
  }

  function isConnected() {
    return connected;
  }

  /** Fire-and-forget -- no reply awaited. Returns false if not currently
   * connected. */
  function send(type, payload) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(Object.assign({ type: type }, payload)));
    return true;
  }

  /** Request/reply -- resolves with the matching `<type>_result` message,
   * or `{ ok: false, reason: 'not_connected' | 'timeout' }`. */
  function request(type, payload, timeoutMs) {
    return new Promise(function (resolve) {
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        resolve({ ok: false, reason: 'not_connected' });
        return;
      }
      var requestId = Date.now().toString(36) + '-' + (++reqCounter).toString(36) + Math.random().toString(36).slice(2, 6);
      pendingResolvers[requestId] = resolve;
      socket.send(JSON.stringify(Object.assign({ type: type, requestId: requestId }, payload)));
      setTimeout(function () {
        if (pendingResolvers[requestId]) {
          pendingResolvers[requestId]({ ok: false, reason: 'timeout' });
          delete pendingResolvers[requestId];
        }
      }, timeoutMs || 5000);
    });
  }

  return { getState: getState, isConnected: isConnected, send: send, request: request };
}

function connectPointSpinner(url) {
  var client = createClient(url, 'point-spinner', 'state');

  /** Resolves with { ok: true, spinId } or { ok: false, reason }. */
  function requestSpin(participantName) {
    return client.request('spin', { participantName: participantName });
  }

  /** Fire-and-forget settings update (e.g. from a moderator's !setcost) --
   * reuses the exact same message the control panel sends. */
  function updateSettings(partialSettings) {
    return client.send('set_settings', { settings: partialSettings });
  }

  return {
    getState: function () {
      return client.getState() || { items: [], settings: {}, history: [] };
    },
    isConnected: client.isConnected,
    requestSpin: requestSpin,
    updateSettings: updateSettings,
  };
}

function connectEconomy(url) {
  var client = createClient(url, 'economy');
  return {
    isConnected: client.isConnected,
    ensureUser: function (channelId, displayName) {
      return client.request('ensure_user', { channelId: channelId, displayName: displayName });
    },
    getBalance: function (channelId) {
      return client.request('get_balance', { channelId: channelId });
    },
    earn: function (channelId, displayName, amount, cooldownSeconds) {
      return client.request('earn', { channelId: channelId, displayName: displayName, amount: amount, cooldownSeconds: cooldownSeconds });
    },
    spend: function (channelId, amount) {
      return client.request('spend', { channelId: channelId, amount: amount });
    },
    adjust: function (channelId, amount, displayName) {
      return client.request('adjust', { channelId: channelId, amount: amount, displayName: displayName });
    },
    setBalance: function (channelId, amount) {
      return client.request('set_balance', { channelId: channelId, amount: amount });
    },
    setAlias: function (channelId, alias) {
      return client.request('set_alias', { channelId: channelId, alias: alias });
    },
    findUser: function (query) {
      return client.request('find_user', { query: query });
    },
  };
}

function connectLiveAuction(url) {
  var client = createClient(url, 'live-auction', 'state');
  return {
    isConnected: client.isConnected,
    joinBid: function (channelId, displayName) {
      return client.request('join_bid', { channelId: channelId, displayName: displayName });
    },
    // `nominal` null/undefined -> server defaults to the minimum (+5%).
    bid: function (channelId, displayName, nominal) {
      return client.request('bid', { channelId: channelId, displayName: displayName, nominal: nominal != null ? nominal : null });
    },
  };
}

function connectExclusiveAuction(url) {
  var client = createClient(url, 'exclusive-auction', 'state');
  return {
    isConnected: client.isConnected,
    joinBid: function (channelId, displayName) {
      return client.request('join_bid', { channelId: channelId, displayName: displayName });
    },
    bid: function (channelId, displayName, nominal) {
      return client.request('bid', { channelId: channelId, displayName: displayName, nominal: nominal != null ? nominal : null });
    },
    // Direct grant -- used by `!give`. `channelId` must already be
    // resolved (via the economy alias lookup); this namespace only knows
    // channelIds, not nicknames.
    giveCurrency: function (channelId, displayName, amount) {
      return client.request('give_currency', { channelId: channelId, displayName: displayName, amount: amount });
    },
    // Read-only balance check -- used by `!balanceex`.
    getBalance: function (channelId, displayName) {
      return client.request('get_balance', { channelId: channelId, displayName: displayName });
    },
  };
}

module.exports = {
  connectPointSpinner: connectPointSpinner,
  connectEconomy: connectEconomy,
  connectLiveAuction: connectLiveAuction,
  connectExclusiveAuction: connectExclusiveAuction,
};
