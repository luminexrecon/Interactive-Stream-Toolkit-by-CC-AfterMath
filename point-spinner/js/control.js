(function () {
  'use strict';

  var C = window.GiveawayClient;

  var els = {
    form: document.getElementById('item-form'),
    name: document.getElementById('item-name'),
    qty: document.getElementById('item-qty'),
    qtyFormat: document.getElementById('item-qty-format'),
    weight: document.getElementById('item-weight'),
    imageInput: document.getElementById('item-image'),
    imagePreview: document.getElementById('item-image-preview'),
    submitBtn: document.getElementById('item-submit-btn'),
    cancelBtn: document.getElementById('item-cancel-btn'),
    itemList: document.getElementById('item-list'),
    itemEmptyHint: document.getElementById('item-empty-hint'),
    importTextarea: document.getElementById('import-textarea'),
    importBtn: document.getElementById('import-btn'),

    pointsPerMessage: document.getElementById('setting-points-per-message'),
    cooldownSeconds: document.getElementById('setting-cooldown-seconds'),
    spinCost: document.getElementById('setting-spin-cost'),

    removeAfterWin: document.getElementById('setting-remove-after-win'),
    spinBtn: document.getElementById('spin-btn'),
    spinStatus: document.getElementById('spin-status-text'),
    historyList: document.getElementById('history-list'),
    historyEmptyHint: document.getElementById('history-empty-hint'),
    clearHistoryBtn: document.getElementById('clear-history-btn'),
    connStatus: document.getElementById('conn-status'),
  };

  var editingId = null;
  var pendingImageUrl = null;
  var spinLocked = false;

  // itemName/participantName can contain untrusted content -- escape before
  // interpolating into innerHTML, same pattern as exclusive-auction/js/control.js.
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
    return (
      pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear() +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
    );
  }

  // ---- Item form ----------------------------------------------------------

  function resetForm() {
    editingId = null;
    pendingImageUrl = null;
    els.form.reset();
    els.qty.value = 1;
    els.weight.value = 1;
    els.imagePreview.hidden = true;
    els.imagePreview.src = '';
    els.submitBtn.textContent = 'Tambah Item';
    els.cancelBtn.hidden = true;
  }

  function startEdit(item) {
    editingId = item.id;
    pendingImageUrl = item.imageUrl || null;
    els.name.value = item.name || '';
    els.qty.value = item.qty != null ? item.qty : 1;
    els.qtyFormat.value = item.qtyFormat || '';
    els.weight.value = item.weight != null ? item.weight : 1;
    if (pendingImageUrl) {
      els.imagePreview.src = pendingImageUrl;
      els.imagePreview.hidden = false;
    } else {
      els.imagePreview.hidden = true;
    }
    els.submitBtn.textContent = 'Simpan Perubahan';
    els.cancelBtn.hidden = false;
    els.name.focus();
  }

  els.cancelBtn.addEventListener('click', function () {
    resetForm();
  });

  els.imageInput.addEventListener('change', function () {
    var file = els.imageInput.files && els.imageInput.files[0];
    if (!file) return;
    els.submitBtn.disabled = true;
    C.fileToSquareImageUrl(file, C.IMAGE_SIZE)
      .then(function (url) {
        pendingImageUrl = url;
        els.imagePreview.src = url;
        els.imagePreview.hidden = false;
      })
      .catch(function (err) {
        alert('Gagal memproses gambar: ' + err.message);
      })
      .then(function () {
        els.submitBtn.disabled = false;
      });
  });

  els.form.addEventListener('submit', function (e) {
    e.preventDefault();
    var name = els.name.value.trim();
    if (!name) {
      els.name.focus();
      return;
    }
    var qty = parseFloat(els.qty.value);
    if (!isFinite(qty) || qty < 0) qty = 1;
    var qtyFormat = els.qtyFormat.value.trim() || 'pcs';
    var weight = parseFloat(els.weight.value);
    if (!isFinite(weight) || weight <= 0) weight = 1;

    var payload = {
      id: editingId || C.uid(),
      name: name,
      qty: qty,
      qtyFormat: qtyFormat,
      weight: weight,
      imageUrl: pendingImageUrl,
    };

    if (editingId) {
      C.updateItem(payload);
    } else {
      C.addItem(payload);
    }

    resetForm();
  });

  // ---- Item list ------------------------------------------------------------

  function renderItems(items) {
    els.itemList.innerHTML = '';
    els.itemEmptyHint.hidden = items.length > 0;

    var totalWeight = 0;
    for (var i = 0; i < items.length; i++) totalWeight += Number(items[i].weight || 1);

    items.forEach(function (item) {
      var row = document.createElement('div');
      row.className = 'item-row';

      var thumb = document.createElement('img');
      thumb.className = 'item-thumb';
      if (item.imageUrl) {
        thumb.src = item.imageUrl;
      } else {
        thumb.classList.add('item-thumb--empty');
      }
      thumb.alt = item.name || '';

      var info = document.createElement('div');
      info.className = 'item-info';

      var nameEl = document.createElement('div');
      nameEl.className = 'item-name';
      nameEl.textContent = item.name;

      var metaEl = document.createElement('div');
      metaEl.className = 'item-meta';
      var pct = totalWeight > 0 ? ((Number(item.weight || 1) / totalWeight) * 100).toFixed(1) : '0.0';
      metaEl.textContent = item.qty + ' ' + item.qtyFormat + '  •  peluang ' + pct + '%';

      info.appendChild(nameEl);
      info.appendChild(metaEl);

      var actions = document.createElement('div');
      actions.className = 'item-actions';

      var editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'btn btn-secondary btn-small';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', function () {
        startEdit(item);
      });

      var delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn btn-danger btn-small';
      delBtn.textContent = 'Hapus';
      delBtn.addEventListener('click', function () {
        if (!confirm('Hapus "' + item.name + '" dari daftar?')) return;
        C.deleteItem(item.id);
        if (editingId === item.id) resetForm();
      });

      actions.appendChild(editBtn);
      actions.appendChild(delBtn);

      row.appendChild(thumb);
      row.appendChild(info);
      row.appendChild(actions);
      els.itemList.appendChild(row);
    });
  }

  els.importBtn.addEventListener('click', function () {
    var raw = els.importTextarea.value;
    var lines = raw.split(/\r?\n/);
    var items = [];

    lines.forEach(function (line) {
      var trimmed = line.trim();
      if (!trimmed) return;
      var parts = trimmed.split(';');
      var name = (parts[0] || '').trim();
      if (!name) return;
      var qty = parseFloat(parts[1]);
      if (!isFinite(qty) || qty < 0) qty = 1;
      var qtyFormat = (parts[2] || '').trim() || 'pcs';

      items.push({ name: name, qty: qty, qtyFormat: qtyFormat, weight: 1, imageUrl: null });
    });

    if (items.length > 0) {
      C.importItems(items);
      els.importTextarea.value = '';
    }
  });

  // ---- Settings ------------------------------------------------------------

  els.removeAfterWin.addEventListener('change', function () {
    C.setSettings({ removeAfterWin: els.removeAfterWin.checked });
  });

  function commitEconomySetting(input, key, minValue) {
    input.addEventListener('change', function () {
      var val = parseFloat(input.value);
      if (!isFinite(val) || val < minValue) val = minValue;
      input.value = val;
      var payload = {};
      payload[key] = val;
      C.setSettings(payload);
    });
  }

  commitEconomySetting(els.pointsPerMessage, 'pointsPerMessage', 0);
  commitEconomySetting(els.cooldownSeconds, 'cooldownSeconds', 0);
  commitEconomySetting(els.spinCost, 'spinCost', 1);

  // ---- Spin ------------------------------------------------------------

  function renderSpinState(items) {
    if (!C.isConnected()) {
      els.spinBtn.disabled = true;
      els.spinStatus.textContent = 'Tidak terhubung ke server…';
      return;
    }
    if (spinLocked) {
      els.spinBtn.disabled = true;
      els.spinStatus.textContent = 'Sedang berputar…';
      return;
    }
    if (items.length === 0) {
      els.spinBtn.disabled = true;
      els.spinStatus.textContent = 'Tambahkan minimal 1 item untuk mulai spin.';
      return;
    }
    els.spinBtn.disabled = false;
    els.spinStatus.textContent = items.length + ' item siap di-spin.';
  }

  els.spinBtn.addEventListener('click', function () {
    var items = C.getState().items;
    if (items.length === 0 || spinLocked || !C.isConnected()) return;

    C.triggerSpin('Tes Manual');

    spinLocked = true;
    renderSpinState(C.getState().items);
    setTimeout(function () {
      spinLocked = false;
      renderSpinState(C.getState().items);
    }, C.TIMING.SPIN_DURATION_MS + 500);
  });

  // ---- History ------------------------------------------------------------

  function renderHistory(history) {
    els.historyList.innerHTML = '';
    els.historyEmptyHint.hidden = history.length > 0;

    history.forEach(function (entry) {
      var row = document.createElement('div');
      row.className = 'history-row';

      var meta = document.createElement('div');
      meta.className = 'history-meta';

      var title = document.createElement('div');
      title.className = 'history-title';
      var titleHtml = '<strong>' + escapeHtml(entry.itemName) + '</strong> — ' + entry.qty + ' ' + escapeHtml(entry.qtyFormat);
      if (entry.participantName) titleHtml += '  →  ' + escapeHtml(entry.participantName);
      title.innerHTML = titleHtml;

      var time = document.createElement('div');
      time.className = 'history-time';
      time.textContent = fmtTimestamp(entry.timestamp);

      meta.appendChild(title);
      meta.appendChild(time);

      var noteInput = document.createElement('input');
      noteInput.type = 'text';
      noteInput.className = 'history-note';
      noteInput.placeholder = 'Catatan';
      noteInput.value = entry.note || '';
      noteInput.addEventListener('change', function () {
        C.updateHistoryNote(entry.id, noteInput.value);
      });

      var delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn btn-danger btn-small';
      delBtn.textContent = 'Hapus';
      delBtn.addEventListener('click', function () {
        C.deleteHistoryEntry(entry.id);
      });

      row.appendChild(meta);
      row.appendChild(noteInput);
      row.appendChild(delBtn);
      els.historyList.appendChild(row);
    });
  }

  els.clearHistoryBtn.addEventListener('click', function () {
    if (!confirm('Bersihkan semua riwayat?')) return;
    C.clearHistory();
  });

  // ---- Init ------------------------------------------------------------

  function init() {
    resetForm();

    C.on('state', function (state) {
      renderItems(state.items);
      renderHistory(state.history);
      els.removeAfterWin.checked = !!state.settings.removeAfterWin;
      els.pointsPerMessage.value = state.settings.pointsPerMessage != null ? state.settings.pointsPerMessage : 1;
      els.cooldownSeconds.value = state.settings.cooldownSeconds != null ? state.settings.cooldownSeconds : 15;
      els.spinCost.value = state.settings.spinCost != null ? state.settings.spinCost : 10;
      renderSpinState(state.items);
    });

    C.on('connect', function () {
      if (els.connStatus) els.connStatus.hidden = true;
      renderSpinState(C.getState().items);
    });

    C.on('disconnect', function () {
      if (els.connStatus) els.connStatus.hidden = false;
      renderSpinState(C.getState().items);
    });

    renderSpinState([]);
    C.connect();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
