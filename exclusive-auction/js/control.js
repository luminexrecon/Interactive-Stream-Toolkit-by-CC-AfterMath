(function () {
  'use strict';

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
    formStatusText: document.getElementById('form-status-text'),
    statusActive: document.getElementById('status-active'),
    statusEmptyHint: document.getElementById('status-empty-hint'),
    statusItemName: document.getElementById('status-item-name'),
    statusEntryFee: document.getElementById('status-entry-fee'),
    statusJoinedCount: document.getElementById('status-joined-count'),
    statusCurrentBid: document.getElementById('status-current-bid'),
    statusMinNext: document.getElementById('status-min-next'),
    statusTimeLeft: document.getElementById('status-time-left'),
    closeNowBtn: document.getElementById('close-now-btn'),
    historyList: document.getElementById('auction-history-list'),
    historyEmptyHint: document.getElementById('auction-history-empty-hint'),
    giveForm: document.getElementById('give-currency-form'),
    giveUserSelect: document.getElementById('give-user-select'),
    giveAmount: document.getElementById('give-amount'),
    giveBtn: document.getElementById('give-btn'),
    giveStatusText: document.getElementById('give-status-text'),
    refreshUsersBtn: document.getElementById('refresh-users-btn'),
    registeredUsersList: document.getElementById('registered-users-list'),
    registeredUsersEmptyHint: document.getElementById('registered-users-empty-hint'),
  };

  var client = window.ExclusiveAuctionClient;
  var timeLeftTimer = null;
  var pendingImageUrl = null;
  var registeredUsers = [];

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

  // itemName/winnerName can contain untrusted content (winnerName comes
  // from a YouTube viewer's own display name/alias) -- escape before
  // interpolating into innerHTML, same pattern as leaderboard/js/overlay.js.
  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = String(str == null ? '' : str);
    return div.innerHTML;
  }

  function fmtTimestamp(ts) {
    var d = new Date(ts);
    function pad(n) {
      return n < 10 ? '0' + n : '' + n;
    }
    return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function renderHistory() {
    var history = client.getState().auctionHistory || [];
    if (!history.length) {
      els.historyList.innerHTML = '';
      els.historyEmptyHint.hidden = false;
      return;
    }
    els.historyEmptyHint.hidden = true;
    els.historyList.innerHTML = history
      .map(function (entry) {
        var result =
          entry.winnerChannelId != null
            ? '<strong>' + entry.finalBid + ' Premium Points</strong> oleh ' + escapeHtml(entry.winnerName || entry.winnerChannelId)
            : 'Tidak ada yang bid';
        return (
          '<div class="history-row">' +
          '<div class="history-meta">' +
          '<div class="history-title">' + escapeHtml(entry.itemName) + '</div>' +
          '<div class="history-time">' + fmtTimestamp(entry.closedAt) + '</div>' +
          '</div>' +
          '<div class="history-note">' + result + '</div>' +
          '</div>'
        );
      })
      .join('');
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
      // Re-reads client.getState().auction each tick -- NOT the local
      // `auction` var above, which would otherwise freeze this interval's
      // closure on whatever endsAt was current the first time this ran,
      // silently ignoring later extensions from the anti-snipe
      // +30s-per-bid rule in server.js.
      timeLeftTimer = setInterval(function () {
        var latestAuction = client.getState().auction;
        if (latestAuction) els.statusTimeLeft.textContent = formatTimeLeft(latestAuction.endsAt);
      }, 1000);
    }
  }

  // alias/displayName come from a YouTube viewer's own !register -- untrusted,
  // same escapeHtml() used for history rendering applies here too.
  function renderUsers() {
    if (!registeredUsers.length) {
      els.registeredUsersList.innerHTML = '';
      els.registeredUsersEmptyHint.hidden = false;
    } else {
      els.registeredUsersEmptyHint.hidden = true;
      els.registeredUsersList.innerHTML = registeredUsers
        .map(function (u) {
          return (
            '<div class="history-row">' +
            '<div class="history-meta"><div class="history-title">' + escapeHtml(u.alias) + '</div></div>' +
            '<div class="history-note"><strong>' + u.balance + '</strong> Premium Points</div>' +
            '</div>'
          );
        })
        .join('');
    }

    var previouslySelected = els.giveUserSelect.value;
    els.giveUserSelect.innerHTML = registeredUsers
      .map(function (u) {
        return '<option value="' + escapeHtml(u.channelId) + '">' + escapeHtml(u.alias) + ' (' + u.balance + ' Premium Points)</option>';
      })
      .join('');
    if (previouslySelected && registeredUsers.some(function (u) { return u.channelId === previouslySelected; })) {
      els.giveUserSelect.value = previouslySelected;
    }
  }

  function refreshUsers() {
    return client.listRegisteredUsers().then(function (result) {
      if (result.ok) {
        registeredUsers = result.users || [];
        renderUsers();
      }
    });
  }

  client.on('connect', function () {
    els.connStatus.hidden = true;
    refreshUsers();
  });
  client.on('disconnect', function () {
    els.connStatus.hidden = false;
  });
  client.on('state', renderStatus);
  client.on('state', renderHistory);

  els.refreshUsersBtn.addEventListener('click', function () {
    els.refreshUsersBtn.disabled = true;
    refreshUsers().finally(function () {
      els.refreshUsersBtn.disabled = false;
    });
  });

  els.giveForm.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var selectedChannelId = els.giveUserSelect.value;
    var selectedUser = registeredUsers.filter(function (u) {
      return u.channelId === selectedChannelId;
    })[0];
    if (!selectedUser) {
      els.giveStatusText.textContent = 'Pilih user dulu dari daftar.';
      return;
    }
    var amount = Number(els.giveAmount.value);
    if (!isFinite(amount) || amount <= 0) {
      els.giveStatusText.textContent = 'Jumlah Premium Points harus angka positif.';
      return;
    }

    els.giveBtn.disabled = true;
    els.giveStatusText.textContent = 'Mengirim...';
    client
      .giveCurrency(selectedUser.channelId, selectedUser.displayName, amount)
      .then(function (result) {
        if (result.ok) {
          els.giveStatusText.textContent = 'Berhasil! Saldo ' + selectedUser.alias + ' sekarang ' + result.balance + ' Premium Points.';
          els.giveAmount.value = 100;
          return refreshUsers();
        }
        var messages = {
          invalid_input: 'Input tidak valid.',
          not_connected: 'Tidak terhubung ke server.',
          timeout: 'Server tidak merespons (timeout).',
        };
        els.giveStatusText.textContent = 'Gagal: ' + (messages[result.reason] || result.reason || 'unknown');
      })
      .finally(function () {
        els.giveBtn.disabled = false;
      });
  });

  els.form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    els.startBtn.disabled = true;
    els.formStatusText.textContent = 'Memulai...';

    client
      .startAuction(
        els.itemName.value.trim(),
        pendingImageUrl,
        Number(els.startingPrice.value),
        Number(els.durationMinutes.value),
        Number(els.entryFee.value)
      )
      .then(function (result) {
        if (result.ok) {
          els.formStatusText.textContent = 'Auction dimulai!';
          els.form.reset();
          els.startingPrice.value = 100;
          els.durationMinutes.value = 10;
          els.entryFee.value = 0;
          pendingImageUrl = null;
          els.itemPicturePreview.hidden = true;
          els.itemPicturePreview.src = '';
        } else {
          var messages = {
            already_active: 'Masih ada auction yang aktif -- tutup dulu sebelum mulai yang baru.',
            invalid_input: 'Input tidak valid -- cek nama item, harga awal, dan durasi.',
            not_connected: 'Tidak terhubung ke server.',
            timeout: 'Server tidak merespons (timeout).',
          };
          els.formStatusText.textContent = 'Gagal: ' + (messages[result.reason] || result.reason || 'unknown');
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
