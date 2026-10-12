/* Point Spinner overlay: same item image+name swap mechanic as Chat Spinner,
   but the "participant" is never drawn from a manually-managed list -- it's
   whoever the YouTube bot says just spent points on `!spin`, sent in as
   `command.participantWinner`. Driven in real time over WebSocket via
   GiveawayClient. */
(function () {
  'use strict';

  var C = window.GiveawayClient;

  var IDLE_SWAP_MS = 1400;
  var SPIN_STEPS = 20;

  var stage = document.getElementById('stage');
  var itemSlot = document.getElementById('item-slot');
  var itemImage = document.getElementById('item-image');
  var itemName = document.getElementById('item-name');
  var itemQty = document.getElementById('item-qty');
  var nameBar = document.getElementById('name-bar');
  var participantNameEl = document.getElementById('participant-name');
  var connStatus = document.getElementById('conn-status');

  var state = {
    mode: 'idle', // idle | spinning | revealed
  };

  var idleTimer = null;
  var spinSound = tryCreateAudio('assets/sfx/spin.mp3');

  function tryCreateAudio(src) {
    try {
      var a = new Audio(src);
      a.preload = 'auto';
      return a;
    } catch (err) {
      return null;
    }
  }

  function playSpinSound() {
    if (!spinSound) return;
    try {
      spinSound.currentTime = 0;
      var p = spinSound.play();
      if (p && p.catch) p.catch(function () {});
    } catch (err) {}
  }

  function placeholderSrc(name) {
    var raw = (name || '').trim().charAt(0).toUpperCase();
    var letter = /[A-Za-z0-9]/.test(raw) ? raw : '?';
    var svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="540" height="540">' +
      '<rect width="540" height="540" fill="#2a2f3a"/>' +
      '<text x="270" y="330" font-size="240" font-family="sans-serif" fill="#5b6470" text-anchor="middle">' +
      letter +
      '</text></svg>';
    return 'data:image/svg+xml,' + encodeURIComponent(svg);
  }

  function setEmptyState(isEmpty) {
    stage.classList.toggle('empty', isEmpty);
  }

  function renderItemFrame(item) {
    itemImage.src = item.imageUrl || placeholderSrc(item.name);
    itemImage.alt = item.name || '';
    itemName.textContent = item.name || '';
    var qtyText =
      (item.qty !== undefined && item.qty !== null ? item.qty : '') +
      (item.qtyFormat ? ' ' + item.qtyFormat : '');
    itemQty.textContent = qtyText.trim();
  }

  function renderParticipantFrame(p) {
    participantNameEl.textContent = p ? p.name : '';
  }

  // ---- Idle ambient cycling ------------------------------------------------

  function stopIdle() {
    if (idleTimer) {
      clearInterval(idleTimer);
      idleTimer = null;
    }
  }

  function tickIdle() {
    var st = C.getState();
    var items = st.items || [];

    if (items.length === 0) {
      setEmptyState(true);
      return;
    }
    setEmptyState(false);
    renderItemFrame(items[(Math.random() * items.length) | 0]);
    participantNameEl.textContent = 'Ketik !spin di chat!';
  }

  function startIdle() {
    stopIdle();
    state.mode = 'idle';
    itemSlot.classList.remove('item-slot--won');
    nameBar.classList.remove('name-bar--won');
    tickIdle();
    idleTimer = setInterval(tickIdle, IDLE_SWAP_MS);
  }

  // ---- Spin: discrete steps with an increasing (decelerating) delay --------

  function buildScheduleDelays(totalMs, steps) {
    var weights = [];
    var sum = 0;
    for (var i = 0; i < steps; i++) {
      var t = steps <= 1 ? 1 : i / (steps - 1);
      var w = 0.12 + Math.pow(t, 2.3) * 1.7;
      weights.push(w);
      sum += w;
    }
    return weights.map(function (w) {
      return Math.max(30, Math.round((w / sum) * totalMs));
    });
  }

  function runReel(pool, winnerData, totalMs, steps, renderFn, onDone) {
    if (!winnerData) {
      onDone();
      return;
    }
    var delays = buildScheduleDelays(totalMs, steps);
    var i = 0;
    function step() {
      if (i >= steps) {
        onDone();
        return;
      }
      var isLast = i === steps - 1;
      var data = isLast ? winnerData : pool.length ? pool[(Math.random() * pool.length) | 0] : winnerData;
      renderFn(data);
      var d = delays[i];
      i++;
      setTimeout(step, d);
    }
    step();
  }

  function startSpin(command) {
    var winner = command.winner;
    if (!winner) return;
    var participantWinner = command.participantWinner || null;

    stopIdle();
    state.mode = 'spinning';
    setEmptyState(false);
    itemSlot.classList.remove('item-slot--won');
    nameBar.classList.remove('name-bar--won');
    playSpinSound();

    var st = C.getState();
    var itemPool = st.items && st.items.length ? st.items : [winner];
    // No manual participant list in this model -- the reel just holds on the
    // one name the bot sent in (no filler variety to shuffle through).
    var participantPool = participantWinner ? [participantWinner] : [];

    var totalMs = C.TIMING.SPIN_DURATION_MS;
    var itemDone = false;
    var nameDone = false;

    function checkAllDone() {
      if (itemDone && nameDone) landOnWinner(participantWinner);
    }

    runReel(
      itemPool,
      winner,
      totalMs,
      SPIN_STEPS,
      function (item) {
        renderItemFrame(item);
      },
      function () {
        itemDone = true;
        checkAllDone();
      }
    );

    if (participantWinner) {
      runReel(
        participantPool,
        participantWinner,
        totalMs,
        SPIN_STEPS,
        function (p) {
          renderParticipantFrame(p);
        },
        function () {
          nameDone = true;
          checkAllDone();
        }
      );
    } else {
      participantNameEl.textContent = '';
      nameDone = true;
    }
  }

  function landOnWinner(participantWinner) {
    state.mode = 'revealed';
    itemSlot.classList.add('item-slot--won');
    if (participantWinner) nameBar.classList.add('name-bar--won');

    if (window.Confetti) window.Confetti.burst();

    setTimeout(function () {
      startIdle();
    }, C.TIMING.REVEAL_HOLD_MS);
  }

  // ---- Init ------------------------------------------------------------

  function init() {
    C.on('state', function () {
      if (state.mode === 'idle') tickIdleOnce();
    });

    function tickIdleOnce() {
      // Refresh idle content immediately when item/participant lists change,
      // without resetting the swap interval's timing.
      tickIdle();
    }

    C.on('spin', function (command) {
      startSpin(command);
    });

    C.on('connect', function () {
      if (connStatus) connStatus.hidden = true;
    });

    C.on('disconnect', function () {
      if (connStatus) connStatus.hidden = false;
    });

    startIdle();
    C.connect();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
