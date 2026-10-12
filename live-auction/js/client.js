/* Realtime client for the "Live Auction" model -- talks to its own
   WebSocket namespace (/live-auction/ws). Used by both control.html
   (start/close auction) and overlay.html (read-only display), same
   connect/reconnect/emit pattern as the other models' js/client.js. */
(function () {
  'use strict';

  var socket = null;
  var connected = false;
  var reconnectDelay = 1000;
  var state = { auction: null, auctionHistory: [] };
  var listeners = {};
  var pendingResolvers = {};
  var reqCounter = 0;

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
    socket = new WebSocket(proto + '://' + location.host + '/live-auction/ws');

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
        state = { auction: msg.auction || null, auctionHistory: msg.auctionHistory || [] };
        emit('state', state);
        return;
      }
      if (msg.requestId && pendingResolvers[msg.requestId]) {
        pendingResolvers[msg.requestId](msg);
        delete pendingResolvers[msg.requestId];
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

  var IMAGE_SIZE = 540;

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

  window.LiveAuctionClient = {
    connect: connect,
    on: on,
    isConnected: function () {
      return connected;
    },
    getState: function () {
      return state;
    },
    startAuction: function (itemName, pictureUrl, startingPrice, durationMinutes, entryFee) {
      return request('start_auction', {
        itemName: itemName,
        pictureUrl: pictureUrl,
        startingPrice: startingPrice,
        durationMinutes: durationMinutes,
        entryFee: entryFee != null ? entryFee : 0,
      });
    },
    closeAuctionNow: function () {
      return request('close_auction_now', {});
    },
    IMAGE_SIZE: IMAGE_SIZE,
    fileToSquareImageUrl: fileToSquareImageUrl,
  };
})();
