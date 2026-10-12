(function () {
  'use strict';

  var stage = document.getElementById('stage');
  var itemImage = document.getElementById('item-image');
  var itemName = document.getElementById('item-name');
  var entryFeeRow = document.getElementById('entry-fee-row');
  var entryFeeEl = document.getElementById('entry-fee');
  var currentBidEl = document.getElementById('current-bid');
  var currentBidderEl = document.getElementById('current-bidder');
  var minNextBidEl = document.getElementById('min-next-bid');
  var timeLeftEl = document.getElementById('time-left');

  var socket = null;
  var reconnectDelay = 1000;
  var currentAuction = null;
  var tickTimer = null;

  function minNextBid(auction) {
    if (auction.currentBid == null) return auction.startingPrice;
    return Math.ceil(auction.currentBid * 1.05);
  }

  function formatTimeLeft(endsAt) {
    var ms = endsAt - Date.now();
    if (ms <= 0) return '00:00';
    var totalSeconds = Math.floor(ms / 1000);
    var m = Math.floor(totalSeconds / 60);
    var s = totalSeconds % 60;
    return (m < 10 ? '0' + m : m) + ':' + (s < 10 ? '0' + s : s);
  }

  function render() {
    var auction = currentAuction;
    if (!auction || auction.status !== 'active') {
      stage.classList.add('empty');
      if (tickTimer) {
        clearInterval(tickTimer);
        tickTimer = null;
      }
      return;
    }
    stage.classList.remove('empty');

    if (auction.pictureUrl) {
      itemImage.src = auction.pictureUrl;
      itemImage.hidden = false;
    } else {
      itemImage.hidden = true;
    }
    itemName.textContent = auction.itemName;
    if ((auction.entryFee || 0) > 0) {
      entryFeeRow.hidden = false;
      entryFeeEl.textContent = auction.entryFee + ' Points';
    } else {
      entryFeeRow.hidden = true;
    }
    currentBidEl.textContent = auction.currentBid != null ? auction.currentBid + ' Points' : String(auction.startingPrice) + ' Points (harga awal)';
    currentBidderEl.textContent = auction.currentBid != null ? auction.currentBidderName || auction.currentBidderChannelId : '-';
    minNextBidEl.textContent = minNextBid(auction) + ' Points';
    timeLeftEl.textContent = formatTimeLeft(auction.endsAt);

    if (!tickTimer) {
      // Reads currentAuction (module-level, updated on every state
      // broadcast) each tick -- NOT the local `auction` var above, which
      // would otherwise freeze this interval's closure on whatever endsAt
      // was current the first time this ran, silently ignoring later
      // extensions from the anti-snipe +30s-per-bid rule in server.js.
      tickTimer = setInterval(function () {
        if (currentAuction) timeLeftEl.textContent = formatTimeLeft(currentAuction.endsAt);
      }, 1000);
    }
  }

  function connect() {
    var proto = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(proto + '://' + location.host + '/live-auction/ws');

    socket.addEventListener('open', function () {
      reconnectDelay = 1000;
    });

    socket.addEventListener('message', function (ev) {
      var msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (err) {
        return;
      }
      if (msg.type === 'state') {
        currentAuction = msg.auction || null;
        render();
      }
    });

    socket.addEventListener('close', function () {
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 1.5, 8000);
    });

    socket.addEventListener('error', function () {
      socket.close();
    });
  }

  connect();
})();
