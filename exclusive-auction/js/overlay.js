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

  // Tracks what was last actually PAINTED (not just the latest state object)
  // so bid-change effects only fire on a real change, never on every
  // broadcast (join/close also broadcast state, not just bid).
  var lastAuctionCreatedAt = null;
  var lastRenderedBid = null;
  var lastRenderedEndsAt = null;
  var bidCountAnimFrame = null;

  // Same tryCreateAudio pattern as point-spinner/js/winner.js. Missing
  // file / blocked autoplay both fail silently -- OBS Browser Source needs
  // "Control audio via OBS" ticked in its properties for this to actually
  // route into the stream's audio mix.
  var bidSound = tryCreateAudio('assets/sfx/bid.mp3');

  function tryCreateAudio(src) {
    try {
      var a = new Audio(src);
      a.preload = 'auto';
      return a;
    } catch (err) {
      return null;
    }
  }

  function playBidSound() {
    if (!bidSound) return;
    try {
      bidSound.currentTime = 0;
      var p = bidSound.play();
      if (p && p.catch) p.catch(function () {});
    } catch (err) {}
  }

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

  // Counts currentBidEl's number up from `fromValue` to `toValue` over
  // ~500ms (ease-out), then re-appends `suffix` verbatim ("Premium Points" or
  // "Premium Points (harga awal)") so the label text stays correct mid-animation.
  function animateBidNumber(fromValue, toValue, suffix) {
    if (bidCountAnimFrame) cancelAnimationFrame(bidCountAnimFrame);
    var duration = 500;
    var startTime = null;
    function step(ts) {
      if (startTime === null) startTime = ts;
      var progress = Math.min((ts - startTime) / duration, 1);
      var eased = 1 - Math.pow(1 - progress, 3);
      var value = Math.round(fromValue + (toValue - fromValue) * eased);
      currentBidEl.textContent = value + suffix;
      if (progress < 1) {
        bidCountAnimFrame = requestAnimationFrame(step);
      } else {
        currentBidEl.textContent = toValue + suffix;
        bidCountAnimFrame = null;
      }
    }
    bidCountAnimFrame = requestAnimationFrame(step);
  }

  // Restarting a CSS animation on an element that already has the class
  // requires a reflow in between remove/add, otherwise the browser just
  // no-ops the second `add` since nothing "changed".
  function replayAnimation(el, className) {
    el.classList.remove(className);
    void el.offsetWidth;
    el.classList.add(className);
  }

  function showExtensionBadge() {
    var badge = document.createElement('div');
    badge.className = 'extension-badge';
    badge.textContent = '+30s';
    timeLeftEl.insertAdjacentElement('afterend', badge);
    // Matches the CSS animation duration (see overlay.css) -- removed from
    // the DOM afterward so repeated extensions don't stack up badges.
    setTimeout(function () {
      if (badge.parentNode) badge.parentNode.removeChild(badge);
    }, 900);
  }

  function render() {
    var auction = currentAuction;
    if (!auction || auction.status !== 'active') {
      stage.classList.add('empty');
      if (tickTimer) {
        clearInterval(tickTimer);
        tickTimer = null;
      }
      lastAuctionCreatedAt = null;
      lastRenderedBid = null;
      lastRenderedEndsAt = null;
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
      entryFeeEl.textContent = auction.entryFee + ' Premium Points';
    } else {
      entryFeeRow.hidden = true;
    }

    var isFreshAuction = auction.createdAt !== lastAuctionCreatedAt;
    var bidValue = auction.currentBid != null ? auction.currentBid : auction.startingPrice;
    var bidSuffix = auction.currentBid != null ? ' Premium Points' : ' Premium Points (harga awal)';

    if (isFreshAuction || lastRenderedBid === null) {
      // First paint of this auction -- set directly, no animation.
      currentBidEl.textContent = bidValue + bidSuffix;
    } else if (bidValue !== lastRenderedBid) {
      animateBidNumber(lastRenderedBid, bidValue, bidSuffix);
      replayAnimation(currentBidEl, 'bid-pulse');
      playBidSound();
    }

    currentBidderEl.textContent = auction.currentBid != null ? auction.currentBidderName || auction.currentBidderChannelId : '-';
    minNextBidEl.textContent = minNextBid(auction) + ' Premium Points';
    timeLeftEl.textContent = formatTimeLeft(auction.endsAt);

    // Anti-snipe extension badge: only for a GENUINE extension on an
    // already-running auction, never on first paint (where endsAt is just
    // "new auction's deadline", not an extension of anything).
    if (!isFreshAuction && lastRenderedEndsAt !== null && auction.endsAt > lastRenderedEndsAt) {
      showExtensionBadge();
    }

    lastAuctionCreatedAt = auction.createdAt;
    lastRenderedBid = bidValue;
    lastRenderedEndsAt = auction.endsAt;

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
    socket = new WebSocket(proto + '://' + location.host + '/exclusive-auction/ws');

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
