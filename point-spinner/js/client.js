/* Realtime client for the "Point Spinner" model: same pattern as the other
   models' js/client.js, but talks to its own WebSocket namespace and state
   (items + economy settings) -- no manual participant list here, since the
   "participant" for each spin is whoever the YouTube bot says triggered it. */
(function () {
  'use strict';

  var TIMING = { SPIN_DURATION_MS: 7000, REVEAL_HOLD_MS: 5000 };
  var IMAGE_SIZE = 540;

  var socket = null;
  var connected = false;
  var reconnectDelay = 1000;
  var state = {
    items: [],
    settings: { removeAfterWin: true, pointsPerMessage: 1, cooldownSeconds: 15, spinCost: 10 },
    history: [],
  };
  var listeners = {};

  function on(event, fn) {
    if (!listeners[event]) listeners[event] = [];
    listeners[event].push(fn);
  }

  function emit(event, payload) {
    (listeners[event] || []).forEach(function (fn) {
      try {
        fn(payload);
      } catch (err) {
        console.error('[client] listener error for', event, err);
      }
    });
  }

  function connect() {
    var proto = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(proto + '://' + location.host + '/point-spinner/ws');

    socket.addEventListener('open', function () {
      connected = true;
      reconnectDelay = 1000;
      emit('connect');
    });

    socket.addEventListener('message', function (ev) {
      var msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (err) {
        return;
      }
      if (msg.type === 'state') {
        state = {
          items: msg.items || [],
          settings: msg.settings || state.settings,
          history: msg.history || [],
        };
        emit('state', state);
      } else if (msg.type === 'spin_command') {
        emit('spin', msg);
      }
    });

    socket.addEventListener('close', function () {
      connected = false;
      emit('disconnect');
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 1.5, 8000);
    });

    socket.addEventListener('error', function () {
      socket.close();
    });
  }

  function send(type, payload) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    var msg = Object.assign({ type: type }, payload);
    socket.send(JSON.stringify(msg));
    return true;
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function uploadImage(blob) {
    return fetch('/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'image/jpeg' },
      body: blob,
    })
      .then(function (res) {
        if (!res.ok) throw new Error('Upload gagal (' + res.status + ')');
        return res.json();
      })
      .then(function (data) {
        return data.url;
      });
  }

  function fileToSquareImageUrl(file, size) {
    size = size || IMAGE_SIZE;
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () {
        reject(new Error('Gagal membaca file'));
      };
      reader.onload = function () {
        var img = new Image();
        img.onerror = function () {
          reject(new Error('File bukan gambar yang valid'));
        };
        img.onload = function () {
          try {
            var side = Math.min(img.width, img.height);
            var sx = (img.width - side) / 2;
            var sy = (img.height - side) / 2;
            var canvas = document.createElement('canvas');
            canvas.width = size;
            canvas.height = size;
            var ctx = canvas.getContext('2d');
            ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
            canvas.toBlob(
              function (blob) {
                if (!blob) {
                  reject(new Error('Gagal membuat gambar'));
                  return;
                }
                uploadImage(blob).then(resolve, reject);
              },
              'image/jpeg',
              0.85
            );
          } catch (err) {
            reject(err);
          }
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  window.GiveawayClient = {
    TIMING: TIMING,
    IMAGE_SIZE: IMAGE_SIZE,
    uid: uid,
    connect: connect,
    on: on,
    isConnected: function () {
      return connected;
    },
    getState: function () {
      return state;
    },
    addItem: function (item) {
      send('add_item', { item: item });
    },
    updateItem: function (item) {
      send('update_item', { item: item });
    },
    deleteItem: function (id) {
      send('delete_item', { id: id });
    },
    importItems: function (items) {
      send('import_items', { items: items });
    },
    setSettings: function (settings) {
      send('set_settings', { settings: settings });
    },
    triggerSpin: function (participantName) {
      send('spin', { participantName: participantName || null });
    },
    updateHistoryNote: function (id, note) {
      send('update_history_note', { id: id, note: note });
    },
    deleteHistoryEntry: function (id) {
      send('delete_history_entry', { id: id });
    },
    clearHistory: function () {
      send('clear_history', {});
    },
    fileToSquareImageUrl: fileToSquareImageUrl,
  };
})();
