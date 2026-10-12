(function () {
  'use strict';

  var HOLD_MS = 3 * 60 * 1000; // ~3 minutes on screen, per spec

  var card = document.getElementById('winner-card');
  var imageEl = document.getElementById('winner-image');
  var itemNameEl = document.getElementById('winner-item-name');
  var nameEl = document.getElementById('winner-name');
  var priceEl = document.getElementById('winner-price-value');
  var connStatus = document.getElementById('conn-status');

  var socket = null;
  var reconnectDelay = 1000;
  var hideTimer = null;

  // Baseline is set from the FIRST state message this page ever sees, so a
  // page (re)load doesn't re-celebrate an auction that already closed
  // before this Browser Source was opened -- only a genuinely NEW entry
  // appearing after that point triggers the reveal.
  var lastSeenClosedAt = undefined;

  function escapeText(s) {
    var div = document.createElement('div');
    div.textContent = s == null ? '' : String(s);
    return div.innerHTML;
  }

  function showWinner(entry) {
    if (entry.pictureUrl) {
      imageEl.src = entry.pictureUrl;
      imageEl.hidden = false;
    } else {
      imageEl.hidden = true;
    }
    itemNameEl.textContent = entry.itemName || '';
    nameEl.textContent = entry.winnerName || entry.winnerChannelId || '';
    priceEl.textContent = entry.finalBid;

    card.classList.add('show');
    if (window.Confetti) window.Confetti.burst({ count: 200 });

    clearTimeout(hideTimer);
    hideTimer = setTimeout(function () {
      card.classList.remove('show');
    }, HOLD_MS);
  }

  function handleState(state) {
    var history = state.auctionHistory || [];
    var top = history[0];
    var topClosedAt = top ? top.closedAt : null;

    if (lastSeenClosedAt === undefined) {
      // First message this session -- just record the baseline, never
      // reveal retroactively for history that already existed.
      lastSeenClosedAt = topClosedAt;
      return;
    }

    if (top && top.winnerChannelId != null && topClosedAt !== lastSeenClosedAt) {
      lastSeenClosedAt = topClosedAt;
      showWinner(top);
    } else if (topClosedAt !== lastSeenClosedAt) {
      // A new history entry landed but nobody actually bid on it --
      // nothing to celebrate, just move the baseline forward silently.
      lastSeenClosedAt = topClosedAt;
    }
  }

  function connect() {
    var proto = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(proto + '://' + location.host + '/exclusive-auction/ws');

    socket.addEventListener('open', function () {
      reconnectDelay = 1000;
      connStatus.hidden = true;
    });

    socket.addEventListener('message', function (ev) {
      var msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (err) {
        return;
      }
      if (msg.type === 'state') handleState(msg);
    });

    socket.addEventListener('close', function () {
      connStatus.hidden = false;
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 1.5, 8000);
    });

    socket.addEventListener('error', function () {
      socket.close();
    });
  }

  connect();
})();
