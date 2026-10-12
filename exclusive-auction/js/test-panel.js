(function () {
  'use strict';

  var DUMMY_BIDDERS = [
    { channelId: '__dummy_bidder_1__', displayName: 'TestBidder1' },
    { channelId: '__dummy_bidder_2__', displayName: 'TestBidder2' },
    { channelId: '__dummy_bidder_3__', displayName: 'TestBidder3' },
  ];
  var TOP_UP_AMOUNT = 500;

  var els = {
    connStatus: document.getElementById('conn-status'),
    form: document.getElementById('auction-form'),
    itemName: document.getElementById('item-name'),
    itemPicture: document.getElementById('item-picture'),
    itemPicturePreview: document.getElementById('item-picture-preview'),
    startingPrice: document.getElementById('starting-price'),
    durationMinutes: document.getElementById('duration-minutes'),
    entryFee: document.getElementById('entry-fee'),
    startBtn: document.getElementById('start-btn'),
    closeNowBtn: document.getElementById('close-now-btn'),
    formStatusText: document.getElementById('form-status-text'),
    statusActive: document.getElementById('status-active'),
    statusEmptyHint: document.getElementById('status-empty-hint'),
    statusItemName: document.getElementById('status-item-name'),
    statusEntryFee: document.getElementById('status-entry-fee'),
    statusJoinedCount: document.getElementById('status-joined-count'),
    statusCurrentBid: document.getElementById('status-current-bid'),
    statusMinNext: document.getElementById('status-min-next'),
    statusTimeLeft: document.getElementById('status-time-left'),
    biddersContainer: document.getElementById('bidders'),
  };

  var client = window.ExclusiveAuctionClient;
  var timeLeftTimer = null;
  var bidderCards = {};
  var pendingImageUrl = null;

  els.itemPicture.addEventListener('change', function () {
    var file = els.itemPicture.files && els.itemPicture.files[0];
    if (!file) return;
    els.startBtn.disabled = true;
    els.formStatusText.textContent = 'Meng-upload gambar...';
    client
      .fileToSquareImageUrl(file, client.IMAGE_SIZE)
      .then(function (url) {
        pendingImageUrl = url;
        els.itemPicturePreview.src = url;
        els.itemPicturePreview.hidden = false;
        els.formStatusText.textContent = '';
      })
      .catch(function (err) {
        els.formStatusText.textContent = 'Gagal upload gambar: ' + err.message;
      })
      .then(function () {
        els.startBtn.disabled = false;
      });
  });

  function minNextBid(auction) {
    if (auction.currentBid == null) return auction.startingPrice;
    return Math.ceil(auction.currentBid * 1.05);
  }

  function formatTimeLeft(endsAt) {
    var ms = endsAt - Date.now();
    if (ms <= 0) return 'Berakhir';
    var totalSeconds = Math.floor(ms / 1000);
    var m = Math.floor(totalSeconds / 60);
    var s = totalSeconds % 60;
    return m + 'm ' + (s < 10 ? '0' + s : s) + 's';
  }

  function renderStatus() {
    var auction = client.getState().auction;
    if (!auction || auction.status !== 'active') {
      els.statusActive.hidden = true;
      els.statusEmptyHint.hidden = false;
      if (timeLeftTimer) {
        clearInterval(timeLeftTimer);
        timeLeftTimer = null;
      }
      return;
    }
    els.statusActive.hidden = false;
    els.statusEmptyHint.hidden = true;
    els.statusItemName.textContent = auction.itemName;
    els.statusEntryFee.textContent = (auction.entryFee || 0) > 0 ? auction.entryFee + ' Premium Points' : 'Gratis';
    els.statusJoinedCount.textContent = (auction.joinedChannelIds || []).length + ' orang';
    els.statusCurrentBid.textContent =
      auction.currentBid != null ? auction.currentBid + ' Premium Points oleh ' + (auction.currentBidderName || auction.currentBidderChannelId) : 'Belum ada (harga awal ' + auction.startingPrice + ')';
    els.statusMinNext.textContent = minNextBid(auction) + ' Premium Points';
    els.statusTimeLeft.textContent = formatTimeLeft(auction.endsAt);

    if (!timeLeftTimer) {
      // Same re-read-live-state pattern as control.js -- avoids the
      // closure-staleness bug from freezing on the first endsAt seen.
      timeLeftTimer = setInterval(function () {
        var latestAuction = client.getState().auction;
        if (latestAuction) els.statusTimeLeft.textContent = formatTimeLeft(latestAuction.endsAt);
      }, 1000);
    }
  }

  function renderBidderJoinState() {
    var auction = client.getState().auction;
    var joined = (auction && auction.joinedChannelIds) || [];
    DUMMY_BIDDERS.forEach(function (b) {
      var card = bidderCards[b.channelId];
      if (!card) return;
      card.joinedEl.textContent = joined.indexOf(b.channelId) !== -1 ? 'Sudah join auction ini' : '';
      card.joinBtn.disabled = joined.indexOf(b.channelId) !== -1;
    });
  }

  function refreshBalance(b) {
    return client.getBalance(b.channelId, b.displayName).then(function (result) {
      var card = bidderCards[b.channelId];
      if (card && result.ok) card.balanceEl.innerHTML = '<strong>' + result.balance + '</strong> Premium Points';
    });
  }

  function refreshAllBalances() {
    DUMMY_BIDDERS.forEach(refreshBalance);
  }

  function buildBidderCard(b) {
    var card = document.createElement('div');
    card.className = 'bidder-card';

    var nameEl = document.createElement('div');
    nameEl.className = 'bidder-name';
    nameEl.textContent = b.displayName;
    card.appendChild(nameEl);

    var balanceEl = document.createElement('div');
    balanceEl.className = 'bidder-balance';
    balanceEl.innerHTML = '<strong>...</strong> Premium Points';
    card.appendChild(balanceEl);

    var joinedEl = document.createElement('div');
    joinedEl.className = 'bidder-joined';
    card.appendChild(joinedEl);

    var actions = document.createElement('div');
    actions.className = 'bidder-actions';

    var topUpBtn = document.createElement('button');
    topUpBtn.type = 'button';
    topUpBtn.className = 'btn btn-secondary';
    topUpBtn.textContent = '+' + TOP_UP_AMOUNT + ' Premium Points';
    actions.appendChild(topUpBtn);

    var joinBtn = document.createElement('button');
    joinBtn.type = 'button';
    joinBtn.className = 'btn btn-secondary';
    joinBtn.textContent = 'Join';
    actions.appendChild(joinBtn);

    var bidMinBtn = document.createElement('button');
    bidMinBtn.type = 'button';
    bidMinBtn.className = 'btn btn-primary';
    bidMinBtn.textContent = 'Bid Min';
    actions.appendChild(bidMinBtn);

    card.appendChild(actions);

    var bidCustomRow = document.createElement('div');
    bidCustomRow.className = 'bidder-bid-custom';
    var bidInput = document.createElement('input');
    bidInput.type = 'number';
    bidInput.placeholder = 'Jumlah';
    bidCustomRow.appendChild(bidInput);
    var bidCustomBtn = document.createElement('button');
    bidCustomBtn.type = 'button';
    bidCustomBtn.className = 'btn btn-secondary';
    bidCustomBtn.textContent = 'Bid';
    bidCustomRow.appendChild(bidCustomBtn);
    card.appendChild(bidCustomRow);

    var statusEl = document.createElement('div');
    statusEl.className = 'bidder-status';
    card.appendChild(statusEl);

    function setStatus(text) {
      statusEl.textContent = text;
    }

    topUpBtn.addEventListener('click', function () {
      topUpBtn.disabled = true;
      client
        .giveCurrency(b.channelId, b.displayName, TOP_UP_AMOUNT)
        .then(function (result) {
          setStatus(result.ok ? 'Saldo sekarang: ' + result.balance : 'Gagal: ' + (result.reason || 'unknown'));
          if (result.ok) refreshBalance(b);
        })
        .finally(function () {
          topUpBtn.disabled = false;
        });
    });

    joinBtn.addEventListener('click', function () {
      joinBtn.disabled = true;
      client
        .joinBid(b.channelId, b.displayName)
        .then(function (result) {
          setStatus(result.ok ? 'Berhasil join' + (result.fee > 0 ? ' (-' + result.fee + ' Premium Points)' : '') : 'Gagal: ' + (result.reason || 'unknown'));
          if (result.ok) refreshBalance(b);
        })
        .finally(function () {
          joinBtn.disabled = false;
        });
    });

    bidMinBtn.addEventListener('click', function () {
      bidMinBtn.disabled = true;
      client
        .bid(b.channelId, b.displayName, null)
        .then(function (result) {
          setStatus(result.ok ? 'Bid ' + result.amount + ' Premium Points berhasil' : 'Gagal: ' + (result.reason || 'unknown'));
          if (result.ok) refreshAllBalances();
        })
        .finally(function () {
          bidMinBtn.disabled = false;
        });
    });

    bidCustomBtn.addEventListener('click', function () {
      var amount = Number(bidInput.value);
      if (!isFinite(amount) || amount <= 0) {
        setStatus('Isi jumlah bid dulu.');
        return;
      }
      bidCustomBtn.disabled = true;
      client
        .bid(b.channelId, b.displayName, amount)
        .then(function (result) {
          setStatus(result.ok ? 'Bid ' + result.amount + ' Premium Points berhasil' : 'Gagal: ' + (result.reason || 'unknown'));
          if (result.ok) {
            refreshAllBalances();
            bidInput.value = '';
          }
        })
        .finally(function () {
          bidCustomBtn.disabled = false;
        });
    });

    bidderCards[b.channelId] = { card: card, balanceEl: balanceEl, joinedEl: joinedEl, joinBtn: joinBtn };
    return card;
  }

  DUMMY_BIDDERS.forEach(function (b) {
    els.biddersContainer.appendChild(buildBidderCard(b));
  });

  client.on('connect', function () {
    els.connStatus.hidden = true;
    refreshAllBalances();
  });
  client.on('disconnect', function () {
    els.connStatus.hidden = false;
  });
  client.on('state', renderStatus);
  client.on('state', renderBidderJoinState);

  els.form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    els.startBtn.disabled = true;
    els.formStatusText.textContent = 'Memulai...';
    client
      .startAuction(els.itemName.value.trim(), pendingImageUrl, Number(els.startingPrice.value), Number(els.durationMinutes.value), Number(els.entryFee.value))
      .then(function (result) {
        els.formStatusText.textContent = result.ok ? 'Auction dimulai!' : 'Gagal: ' + (result.reason || 'unknown');
        if (result.ok) {
          pendingImageUrl = null;
          els.itemPicturePreview.hidden = true;
          els.itemPicturePreview.src = '';
          els.itemPicture.value = '';
        }
      })
      .finally(function () {
        els.startBtn.disabled = false;
      });
  });

  els.closeNowBtn.addEventListener('click', function () {
    els.closeNowBtn.disabled = true;
    client.closeAuctionNow().finally(function () {
      els.closeNowBtn.disabled = false;
    });
  });

  client.connect();
})();
