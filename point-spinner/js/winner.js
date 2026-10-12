/* Standalone "winner announcement" overlay for the Chat Spinner model:
   same reveal-after-SPIN_DURATION_MS pattern as the main model's winner.js,
   plus the winning participant's name. A small mascot occupies the same
   spot the rest of the time: "bling" while idle, "confuse" while a spin
   is in progress. */
(function () {
  'use strict';

  var C = window.GiveawayClient;

  var card = document.getElementById('winner-card');
  var imageEl = document.getElementById('winner-image');
  var nameEl = document.getElementById('winner-name');
  var qtyEl = document.getElementById('winner-qty');
  var participantEl = document.getElementById('winner-participant');
  var connStatus = document.getElementById('conn-status');
  var mascot = document.getElementById('mascot');
  var mascotImg = document.getElementById('mascot-img');

  var revealTimer = null;
  var hideTimer = null;
  var winSound = tryCreateAudio('assets/sfx/win.mp3');

  function tryCreateAudio(src) {
    try {
      var a = new Audio(src);
      a.preload = 'auto';
      return a;
    } catch (err) {
      return null;
    }
  }

  function playWinSound() {
    if (!winSound) return;
    try {
      winSound.currentTime = 0;
      var p = winSound.play();
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

  function setMascot(name) {
    mascotImg.src = 'assets/emote/' + name + '.gif';
  }

  function showMascot() {
    mascot.classList.remove('hidden');
  }

  function hideMascot() {
    mascot.classList.add('hidden');
  }

  function goIdle() {
    card.classList.remove('show');
    setMascot('bling');
    showMascot();
  }

  function showWinner(winner, participantWinner) {
    imageEl.src = winner.imageUrl || placeholderSrc(winner.name);
    imageEl.alt = winner.name || '';
    nameEl.textContent = winner.name || '';
    var qtyText = (winner.qty !== undefined && winner.qty !== null ? winner.qty : '') +
      (winner.qtyFormat ? ' ' + winner.qtyFormat : '');
    qtyEl.textContent = qtyText.trim();

    if (participantWinner && participantWinner.name) {
      participantEl.innerHTML = 'untuk <span class="who">' + escapeHtml(participantWinner.name) + '</span>';
      participantEl.hidden = false;
    } else {
      participantEl.hidden = true;
    }

    hideMascot();
    card.classList.add('show');
    playWinSound();
    if (window.Confetti) window.Confetti.burst({ count: 220 });

    clearTimeout(hideTimer);
    hideTimer = setTimeout(goIdle, C.TIMING.REVEAL_HOLD_MS);
  }

  function escapeHtml(s) {
    var div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  function onSpin(command) {
    if (!command || !command.winner) return;
    clearTimeout(revealTimer);
    clearTimeout(hideTimer);
    card.classList.remove('show');
    setMascot('confuse');
    showMascot();
    revealTimer = setTimeout(function () {
      showWinner(command.winner, command.participantWinner);
    }, C.TIMING.SPIN_DURATION_MS);
  }

  function init() {
    goIdle();
    C.on('spin', onSpin);
    C.on('connect', function () {
      if (connStatus) connStatus.hidden = true;
    });
    C.on('disconnect', function () {
      if (connStatus) connStatus.hidden = false;
    });
    C.connect();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
