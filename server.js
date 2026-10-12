/* Stream Toolkit -- main server.
 *
 * Plain Node HTTP server (no framework, no build step) that:
 *   - serves the static control-panel / OBS overlay pages for the 3
 *     models below, plus handles image uploads (/api/upload)
 *   - runs 4 independent WebSocket namespaces, each its own in-memory
 *     state object backed by a local JSON file under data/ (no database):
 *       /point-spinner/ws      viewer-triggered prize spinner
 *       /economy/ws            balance ledger for the chat-earned
 *                               currency (CURRENCY_NAME, "Points" by
 *                               default) -- shared by point-spinner and
 *                               live-auction, consumed by bot/bot.js
 *       /live-auction/ws       CURRENCY_NAME-based live chat auction
 *       /exclusive-auction/ws  EXCLUSIVE_CURRENCY_NAME-based auction
 *                               ("Premium Points" by default), a second,
 *                               separate currency that is only ever
 *                               granted manually by a moderator (`!give`)
 *                               and depreciates monthly
 *
 * All state mutations below are plain synchronous JavaScript (mutate the
 * in-memory object, then fs.writeFileSync) -- with local JSON files there
 * is no `await` point between "read the current value" and "write the
 * new one", so two WS messages can never interleave mid-update the way
 * they could with a networked database. That's why there's no locking
 * anywhere in this file; see README.md for the bigger picture.
 *
 * Run with `npm start`. Configuration is read from environment variables
 * (see .env.example / docs/CONFIGURATION.md) via dotenv.
 */

require('dotenv').config();

var http = require('http');
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var WebSocketServer = require('ws').WebSocketServer;

var ROOT = __dirname;
var DATA_DIR = path.join(ROOT, 'data');
var UPLOADS_DIR = path.join(ROOT, 'uploads');
var PORT = process.env.PORT || 3000;
var UPLOAD_LIMIT_BYTES = 15 * 1024 * 1024;

var CURRENCY_NAME = process.env.CURRENCY_NAME || 'Points';
var CURRENCY_PER_MESSAGE_DEFAULT = Number(process.env.CURRENCY_PER_MESSAGE);
if (!isFinite(CURRENCY_PER_MESSAGE_DEFAULT) || CURRENCY_PER_MESSAGE_DEFAULT < 0) CURRENCY_PER_MESSAGE_DEFAULT = 1;
var CURRENCY_MESSAGE_COOLDOWN_SECONDS_DEFAULT = Number(process.env.CURRENCY_MESSAGE_COOLDOWN_SECONDS);
if (!isFinite(CURRENCY_MESSAGE_COOLDOWN_SECONDS_DEFAULT) || CURRENCY_MESSAGE_COOLDOWN_SECONDS_DEFAULT < 0) CURRENCY_MESSAGE_COOLDOWN_SECONDS_DEFAULT = 15;

var EXCLUSIVE_CURRENCY_NAME = process.env.EXCLUSIVE_CURRENCY_NAME || 'Premium Points';
var EXCLUSIVE_CURRENCY_DEPRECIATION_PERCENT = Number(process.env.EXCLUSIVE_CURRENCY_DEPRECIATION_PERCENT);
if (!isFinite(EXCLUSIVE_CURRENCY_DEPRECIATION_PERCENT) || EXCLUSIVE_CURRENCY_DEPRECIATION_PERCENT < 0) EXCLUSIVE_CURRENCY_DEPRECIATION_PERCENT = 5;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

function uid() {
  return Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}

/** Shared by every model's persist*() function below -- just the
 * writeFileSync + error log part, since the load/validate side differs
 * per model (different shapes, different default values). */
function writeJsonFile(filePath, data, label) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Failed to save ' + label + ' state:', err.message);
  }
}

function normalizeItem(item) {
  item = item || {};
  var qty = Number(item.qty);
  var weight = Number(item.weight);
  return {
    id: item.id || uid(),
    name: String(item.name || '').trim(),
    qty: isFinite(qty) && qty >= 0 ? qty : 1,
    qtyFormat: String(item.qtyFormat || 'pcs').trim() || 'pcs',
    weight: isFinite(weight) && weight > 0 ? weight : 1,
    imageUrl: item.imageUrl || null,
  };
}

function weightedPick(items) {
  var pool = items.filter(function (it) {
    return Number(it.weight) > 0;
  });
  if (!pool.length) return null;
  var total = 0;
  for (var i = 0; i < pool.length; i++) total += Number(pool[i].weight || 1);
  var roll = Math.random() * total;
  for (var j = 0; j < pool.length; j++) {
    roll -= Number(pool[j].weight || 1);
    if (roll <= 0) return pool[j];
  }
  return pool[pool.length - 1];
}

// ---- Static file serving ---------------------------------------------------

var MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.ico': 'image/x-icon',
};

function safeJoin(base, requestPath) {
  var decoded;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch (err) {
    return null;
  }
  var full = path.normalize(path.join(base, decoded));
  if (full !== base && full.indexOf(base + path.sep) !== 0) return null;
  return full;
}

function serveStatic(res, routedPath) {
  var filePath = safeJoin(ROOT, routedPath);
  if (!filePath) {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }
  fs.stat(filePath, function (err, stats) {
    if (err || !stats.isFile()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    var ext = path.extname(filePath).toLowerCase();
    var headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    // .html/.js/.css change often while you're setting things up -- force
    // the browser to revalidate with the server every time instead of
    // silently running a stale cached copy after you edit a file.
    if (ext === '.html' || ext === '.js' || ext === '.css') {
      headers['Cache-Control'] = 'no-cache';
    }
    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  });
}

function handleUpload(req, res) {
  var chunks = [];
  var size = 0;
  var tooBig = false;

  req.on('data', function (chunk) {
    if (tooBig) return;
    size += chunk.length;
    if (size > UPLOAD_LIMIT_BYTES) {
      tooBig = true;
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'File too large' }));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', function () {
    if (tooBig) return;
    var buffer = Buffer.concat(chunks);
    var filename = uid() + '.jpg';
    fs.writeFile(path.join(UPLOADS_DIR, filename), buffer, function (err) {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to save file' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ url: '/uploads/' + filename }));
    });
  });
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

var server = http.createServer(function (req, res) {
  var urlPath = req.url.split('?')[0];

  if (req.method === 'POST' && urlPath === '/api/upload') {
    handleUpload(req, res);
    return;
  }

  // No dedicated landing page -- Point Spinner's control panel is as good
  // a default as any. Bookmark whichever page you actually use.
  if (urlPath === '/') {
    redirect(res, '/point-spinner/control');
    return;
  }

  if (urlPath === '/point-spinner/control') {
    serveStatic(res, '/point-spinner/control.html');
    return;
  }
  if (urlPath === '/point-spinner/overlay') {
    serveStatic(res, '/point-spinner/overlay.html');
    return;
  }
  if (urlPath === '/point-spinner/winner') {
    serveStatic(res, '/point-spinner/winner.html');
    return;
  }
  if (urlPath === '/live-auction/control') {
    serveStatic(res, '/live-auction/control.html');
    return;
  }
  if (urlPath === '/live-auction/overlay') {
    serveStatic(res, '/live-auction/overlay.html');
    return;
  }
  if (urlPath === '/exclusive-auction/control') {
    serveStatic(res, '/exclusive-auction/control.html');
    return;
  }
  if (urlPath === '/exclusive-auction/overlay') {
    serveStatic(res, '/exclusive-auction/overlay.html');
    return;
  }
  if (urlPath === '/exclusive-auction/winner') {
    serveStatic(res, '/exclusive-auction/winner.html');
    return;
  }
  if (urlPath === '/exclusive-auction/test-panel') {
    serveStatic(res, '/exclusive-auction/test-panel.html');
    return;
  }
  serveStatic(res, urlPath);
});

// ---- WebSocket realtime sync -----------------------------------------------
// All namespaces use `noServer: true` and share one manual `upgrade`
// listener below -- attaching several `{ server, path }` WebSocketServers
// to the same http.Server isn't reliable (the first one registered can
// end up rejecting upgrade requests meant for another path), so routing
// is done by hand here instead.

var pointWss = new WebSocketServer({ noServer: true });
var economyWss = new WebSocketServer({ noServer: true });
var liveAuctionWss = new WebSocketServer({ noServer: true });
var exclusiveAuctionWss = new WebSocketServer({ noServer: true });

server.on('upgrade', function (request, socket, head) {
  var pathname = request.url.split('?')[0];
  var target =
    pathname === '/point-spinner/ws' ? pointWss :
    pathname === '/economy/ws' ? economyWss :
    pathname === '/live-auction/ws' ? liveAuctionWss :
    pathname === '/exclusive-auction/ws' ? exclusiveAuctionWss :
    null;
  if (!target) {
    socket.destroy();
    return;
  }
  target.handleUpgrade(request, socket, head, function (ws) {
    target.emit('connection', ws, request);
  });
});

// ---- Point Spinner: viewer-triggered spins via the YouTube bot ------------
// Each spin's "participant" is whatever name the caller passes in
// `participantName` (the bot, or a manual test click in the control panel).

var POINT_STATE_FILE = path.join(DATA_DIR, 'point-spinner-state.json');
var POINT_DEFAULT_STATE = {
  items: [],
  settings: {
    removeAfterWin: true,
    pointsPerMessage: CURRENCY_PER_MESSAGE_DEFAULT,
    cooldownSeconds: CURRENCY_MESSAGE_COOLDOWN_SECONDS_DEFAULT,
    spinCost: 10,
  },
  history: [],
};

function loadPointState() {
  try {
    var raw = fs.readFileSync(POINT_STATE_FILE, 'utf8');
    var parsed = JSON.parse(raw);
    return {
      items: Array.isArray(parsed.items) ? parsed.items : [],
      settings: Object.assign({}, POINT_DEFAULT_STATE.settings, parsed.settings || {}),
      history: Array.isArray(parsed.history) ? parsed.history : [],
    };
  } catch (err) {
    return JSON.parse(JSON.stringify(POINT_DEFAULT_STATE));
  }
}

var pointState = loadPointState();

function persistPoint() {
  writeJsonFile(POINT_STATE_FILE, pointState, 'point-spinner');
}

function pointBroadcast(obj) {
  var payload = JSON.stringify(obj);
  pointWss.clients.forEach(function (client) {
    if (client.readyState === 1) client.send(payload);
  });
}

function pointBroadcastState() {
  pointBroadcast({ type: 'state', items: pointState.items, settings: pointState.settings, history: pointState.history });
}

pointWss.on('connection', function (ws) {
  ws.send(JSON.stringify({ type: 'state', items: pointState.items, settings: pointState.settings, history: pointState.history }));

  ws.on('message', function (raw) {
    var msg;
    try {
      msg = JSON.parse(raw);
    } catch (err) {
      return;
    }

    switch (msg.type) {
      case 'add_item': {
        pointState.items.push(normalizeItem(Object.assign({}, msg.item, { id: msg.item && msg.item.id ? msg.item.id : uid() })));
        persistPoint();
        pointBroadcastState();
        break;
      }
      case 'update_item': {
        var updId = msg.item && msg.item.id;
        pointState.items = pointState.items.map(function (it) {
          return it.id === updId ? normalizeItem(msg.item) : it;
        });
        persistPoint();
        pointBroadcastState();
        break;
      }
      case 'delete_item': {
        pointState.items = pointState.items.filter(function (it) {
          return it.id !== msg.id;
        });
        persistPoint();
        pointBroadcastState();
        break;
      }
      case 'import_items': {
        (msg.items || []).forEach(function (item) {
          pointState.items.push(normalizeItem(Object.assign({}, item, { id: uid() })));
        });
        persistPoint();
        pointBroadcastState();
        break;
      }
      case 'set_settings': {
        pointState.settings = Object.assign({}, pointState.settings, msg.settings || {});
        persistPoint();
        pointBroadcastState();
        break;
      }
      case 'spin': {
        var winner = weightedPick(pointState.items);
        if (!winner) {
          ws.send(JSON.stringify({ type: 'spin_result', ok: false, reason: 'empty_pool', requestId: msg.requestId }));
          break;
        }
        var participantWinner = msg.participantName ? { id: uid(), name: String(msg.participantName).trim() } : null;
        var spinId = uid();
        pointState.history.unshift({
          id: uid(),
          timestamp: Date.now(),
          itemName: winner.name,
          qty: winner.qty,
          qtyFormat: winner.qtyFormat,
          participantName: participantWinner ? participantWinner.name : '',
          note: '',
        });
        if (pointState.history.length > 200) pointState.history = pointState.history.slice(0, 200);
        if (pointState.settings.removeAfterWin) {
          pointState.items = pointState.items.filter(function (it) {
            return it.id !== winner.id;
          });
        }
        persistPoint();
        pointBroadcast({
          type: 'spin_command',
          spinId: spinId,
          winner: winner,
          participantWinner: participantWinner,
          timestamp: Date.now(),
        });
        pointBroadcastState();
        ws.send(JSON.stringify({ type: 'spin_result', ok: true, spinId: spinId, requestId: msg.requestId }));
        break;
      }
      case 'update_history_note': {
        pointState.history = pointState.history.map(function (h) {
          return h.id === msg.id ? Object.assign({}, h, { note: msg.note }) : h;
        });
        persistPoint();
        pointBroadcastState();
        break;
      }
      case 'delete_history_entry': {
        pointState.history = pointState.history.filter(function (h) {
          return h.id !== msg.id;
        });
        persistPoint();
        pointBroadcastState();
        break;
      }
      case 'clear_history': {
        pointState.history = [];
        persistPoint();
        pointBroadcastState();
        break;
      }
    }
  });
});

// ---- Economy: balance ledger for CURRENCY_NAME -----------------------------
// Not read by any browser page -- only bot/bot.js connects here (as a WS
// client, same as it connects to the other 3 namespaces), to check/earn/
// spend balances on behalf of whoever just chatted. Shared by Point
// Spinner (`!spin` costs this currency) and Live Auction (bids are in
// this currency) -- see README.md for why this is a separate namespace
// from both.

var ECONOMY_STATE_FILE = path.join(DATA_DIR, 'economy-state.json');
var ECONOMY_DEFAULT_STATE = { users: {} }; // channelId -> { displayName, alias, balance, lastEarnAt }

function loadEconomyState() {
  try {
    var raw = fs.readFileSync(ECONOMY_STATE_FILE, 'utf8');
    var parsed = JSON.parse(raw);
    return { users: parsed.users && typeof parsed.users === 'object' ? parsed.users : {} };
  } catch (err) {
    return JSON.parse(JSON.stringify(ECONOMY_DEFAULT_STATE));
  }
}

var economyState = loadEconomyState();

function persistEconomy() {
  writeJsonFile(ECONOMY_STATE_FILE, economyState, 'economy');
}

function canEarn(lastEarnAt, cooldownSeconds) {
  return Date.now() - (lastEarnAt || 0) >= Number(cooldownSeconds || 0) * 1000;
}

/** Reads the user if they exist, creates them (balance 0) if they don't,
 * and refreshes displayName if it changed since last seen (YouTube
 * display names can change). Always persists on any actual change. */
function ensureEconomyUser(channelId, displayName) {
  var u = economyState.users[channelId];
  if (!u) {
    u = { displayName: displayName || channelId, alias: null, balance: 0, lastEarnAt: 0 };
    economyState.users[channelId] = u;
    persistEconomy();
    return u;
  }
  if (displayName && u.displayName !== displayName) {
    u.displayName = displayName;
    persistEconomy();
  }
  return u;
}

/** Looks up a known user by their current displayName OR their registered
 * alias (case-insensitive, leading "@" ignored). Only finds people who
 * have chatted/earned at least once (so a record exists). */
function findEconomyUserByQuery(query) {
  var q = String(query || '').trim().toLowerCase().replace(/^@/, '');
  var foundId = null;
  if (q) {
    Object.keys(economyState.users).some(function (channelId) {
      var u = economyState.users[channelId];
      var alias = String(u.alias || '').toLowerCase();
      var name = String(u.displayName || '').toLowerCase().replace(/^@/, '');
      if (alias === q || name === q) {
        foundId = channelId;
        return true;
      }
      return false;
    });
  }
  return foundId;
}

economyWss.on('connection', function (ws) {
  ws.on('message', function (raw) {
    var msg;
    try {
      msg = JSON.parse(raw);
    } catch (err) {
      return;
    }
    var requestId = msg.requestId;

    switch (msg.type) {
      case 'ensure_user': {
        var u1 = ensureEconomyUser(msg.channelId, msg.displayName);
        ws.send(JSON.stringify({ type: 'ensure_user_result', requestId: requestId, ok: true, user: u1 }));
        break;
      }

      case 'get_balance': {
        ws.send(JSON.stringify({ type: 'get_balance_result', requestId: requestId, ok: true, user: economyState.users[msg.channelId] || null }));
        break;
      }

      case 'earn': {
        var earning = ensureEconomyUser(msg.channelId, msg.displayName);
        if (!canEarn(earning.lastEarnAt, msg.cooldownSeconds)) {
          ws.send(JSON.stringify({ type: 'earn_result', requestId: requestId, ok: false, reason: 'cooldown', balance: earning.balance }));
          break;
        }
        earning.balance += Number(msg.amount) || 0;
        earning.lastEarnAt = Date.now();
        persistEconomy();
        ws.send(JSON.stringify({ type: 'earn_result', requestId: requestId, ok: true, balance: earning.balance }));
        break;
      }

      case 'spend': {
        var spending = economyState.users[msg.channelId];
        if (!spending || spending.balance < Number(msg.amount)) {
          ws.send(JSON.stringify({
            type: 'spend_result',
            requestId: requestId,
            ok: false,
            reason: spending ? 'insufficient_funds' : 'unknown_user',
            balance: spending ? spending.balance : 0,
          }));
          break;
        }
        spending.balance -= Number(msg.amount);
        persistEconomy();
        ws.send(JSON.stringify({ type: 'spend_result', requestId: requestId, ok: true, balance: spending.balance }));
        break;
      }

      case 'adjust': {
        var adjusting = ensureEconomyUser(msg.channelId, msg.displayName);
        adjusting.balance = Math.max(0, adjusting.balance + (Number(msg.amount) || 0));
        persistEconomy();
        ws.send(JSON.stringify({ type: 'adjust_result', requestId: requestId, ok: true, balance: adjusting.balance }));
        break;
      }

      case 'set_balance': {
        var setting = economyState.users[msg.channelId];
        if (!setting) {
          ws.send(JSON.stringify({ type: 'set_balance_result', requestId: requestId, ok: false, reason: 'unknown_user' }));
          break;
        }
        setting.balance = Math.max(0, Number(msg.amount) || 0);
        persistEconomy();
        ws.send(JSON.stringify({ type: 'set_balance_result', requestId: requestId, ok: true, balance: setting.balance }));
        break;
      }

      case 'set_alias': {
        var aliasing = economyState.users[msg.channelId];
        if (!aliasing) {
          ws.send(JSON.stringify({ type: 'set_alias_result', requestId: requestId, ok: false, reason: 'unknown_user' }));
          break;
        }
        aliasing.alias = msg.alias;
        persistEconomy();
        ws.send(JSON.stringify({ type: 'set_alias_result', requestId: requestId, ok: true, user: aliasing }));
        break;
      }

      case 'find_user': {
        var foundId = findEconomyUserByQuery(msg.query);
        ws.send(JSON.stringify({
          type: 'find_user_result',
          requestId: requestId,
          found: !!foundId,
          channelId: foundId,
          user: foundId ? economyState.users[foundId] : null,
        }));
        break;
      }
    }
  });
});

// ---- Live Auction: CURRENCY_NAME, via YouTube live chat --------------------
// Viewers bid straight from live chat (bot/bot.js's `!bid`), escrowed
// through the SAME balances as everything else in /economy/ws -- there's
// no separate ledger here. Only one auction can be active at a time.
// Being outbid refunds in FULL (no penalty kept). The "cost of
// participating" is a one-time, non-refundable entry fee paid via
// `!joinbid` before a channelId is allowed to `!bid` at all.

var LIVE_AUCTION_STATE_FILE = path.join(DATA_DIR, 'live-auction-state.json');
var LIVE_AUCTION_MIN_INCREMENT_PERCENT = 5;
var LIVE_AUCTION_SWEEP_MS = 5 * 1000;
var LIVE_AUCTION_BID_TIME_EXTENSION_MS = 30 * 1000;
var LIVE_AUCTION_HISTORY_LIMIT = 200;

function loadLiveAuctionState() {
  try {
    var raw = fs.readFileSync(LIVE_AUCTION_STATE_FILE, 'utf8');
    var parsed = JSON.parse(raw);
    return {
      auction: parsed.auction || null,
      auctionHistory: Array.isArray(parsed.auctionHistory) ? parsed.auctionHistory : [],
    };
  } catch (err) {
    return { auction: null, auctionHistory: [] };
  }
}

var liveAuctionState = loadLiveAuctionState();

function persistLiveAuction() {
  writeJsonFile(LIVE_AUCTION_STATE_FILE, liveAuctionState, 'live-auction');
}

function liveAuctionBroadcast(obj) {
  var payload = JSON.stringify(obj);
  liveAuctionWss.clients.forEach(function (client) {
    if (client.readyState === 1) client.send(payload);
  });
}
function liveAuctionBroadcastState() {
  liveAuctionBroadcast({ type: 'state', auction: liveAuctionState.auction, auctionHistory: liveAuctionState.auctionHistory });
}

function liveAuctionMinNextBid(auction) {
  if (auction.currentBid == null) return auction.startingPrice;
  return Math.ceil(auction.currentBid * (1 + LIVE_AUCTION_MIN_INCREMENT_PERCENT / 100));
}

// Only the final result gets kept (item, winner, final price) -- not a
// bid-by-bid log. Called from both the auto-close sweep and manual
// close-now so a history entry is always recorded the same way.
function closeLiveAuction(auction) {
  auction.status = 'closed';
  liveAuctionState.auctionHistory.unshift({
    itemName: auction.itemName,
    pictureUrl: auction.pictureUrl,
    startingPrice: auction.startingPrice,
    finalBid: auction.currentBid,
    winnerChannelId: auction.currentBidderChannelId,
    winnerName: auction.currentBidderName,
    closedAt: Date.now(),
  });
  if (liveAuctionState.auctionHistory.length > LIVE_AUCTION_HISTORY_LIMIT) {
    liveAuctionState.auctionHistory = liveAuctionState.auctionHistory.slice(0, LIVE_AUCTION_HISTORY_LIMIT);
  }
  persistLiveAuction();
}

setInterval(function () {
  var auction = liveAuctionState.auction;
  if (!auction || auction.status !== 'active' || Date.now() < auction.endsAt) return;
  closeLiveAuction(auction);
  liveAuctionBroadcastState();
}, LIVE_AUCTION_SWEEP_MS);

liveAuctionWss.on('connection', function (ws) {
  ws.send(JSON.stringify({ type: 'state', auction: liveAuctionState.auction, auctionHistory: liveAuctionState.auctionHistory }));

  ws.on('message', function (raw) {
    var msg;
    try {
      msg = JSON.parse(raw);
    } catch (err) {
      return;
    }
    var requestId = msg.requestId;

    switch (msg.type) {
      case 'start_auction': {
        var existing = liveAuctionState.auction;
        if (existing && existing.status === 'active' && Date.now() < existing.endsAt) {
          ws.send(JSON.stringify({ type: 'start_auction_result', requestId: requestId, ok: false, reason: 'already_active' }));
          break;
        }
        var itemName = String(msg.itemName || '').trim();
        var startingPrice = Number(msg.startingPrice);
        var durationMinutes = Number(msg.durationMinutes);
        var entryFee = msg.entryFee != null ? Number(msg.entryFee) : 0;
        if (!itemName || !isFinite(startingPrice) || startingPrice <= 0 || !isFinite(durationMinutes) || durationMinutes <= 0 || !isFinite(entryFee) || entryFee < 0) {
          ws.send(JSON.stringify({ type: 'start_auction_result', requestId: requestId, ok: false, reason: 'invalid_input' }));
          break;
        }
        var newAuction = {
          itemName: itemName,
          pictureUrl: msg.pictureUrl || null,
          startingPrice: startingPrice,
          entryFee: entryFee,
          joinedChannelIds: [],
          currentBid: null,
          currentBidderChannelId: null,
          currentBidderName: null,
          createdAt: Date.now(),
          endsAt: Date.now() + durationMinutes * 60 * 1000,
          status: 'active',
        };
        liveAuctionState.auction = newAuction;
        persistLiveAuction();
        liveAuctionBroadcastState();
        ws.send(JSON.stringify({ type: 'start_auction_result', requestId: requestId, ok: true, auction: newAuction }));
        break;
      }

      case 'close_auction_now': {
        var toClose = liveAuctionState.auction;
        if (!toClose || toClose.status !== 'active') {
          ws.send(JSON.stringify({ type: 'close_auction_now_result', requestId: requestId, ok: false, reason: 'no_active_auction' }));
          break;
        }
        closeLiveAuction(toClose);
        liveAuctionBroadcastState();
        ws.send(JSON.stringify({ type: 'close_auction_now_result', requestId: requestId, ok: true }));
        break;
      }

      case 'join_bid': {
        var joinAuction = liveAuctionState.auction;
        if (!joinAuction || joinAuction.status !== 'active' || Date.now() >= joinAuction.endsAt) {
          ws.send(JSON.stringify({ type: 'join_bid_result', requestId: requestId, ok: false, reason: 'no_active_auction' }));
          break;
        }
        if (joinAuction.joinedChannelIds.indexOf(msg.channelId) !== -1) {
          ws.send(JSON.stringify({ type: 'join_bid_result', requestId: requestId, ok: false, reason: 'already_joined' }));
          break;
        }
        var fee = joinAuction.entryFee || 0;
        var joiningUser = ensureEconomyUser(msg.channelId, msg.displayName);
        if (joiningUser.balance < fee) {
          ws.send(JSON.stringify({ type: 'join_bid_result', requestId: requestId, ok: false, reason: 'insufficient_funds', balance: joiningUser.balance, fee: fee }));
          break;
        }
        joinAuction.joinedChannelIds.push(msg.channelId);
        joiningUser.balance -= fee;
        persistLiveAuction();
        persistEconomy();
        liveAuctionBroadcastState();
        ws.send(JSON.stringify({ type: 'join_bid_result', requestId: requestId, ok: true, fee: fee, balance: joiningUser.balance }));
        break;
      }

      case 'bid': {
        var auction = liveAuctionState.auction;
        if (!auction || auction.status !== 'active' || Date.now() >= auction.endsAt) {
          ws.send(JSON.stringify({ type: 'bid_result', requestId: requestId, ok: false, reason: 'no_active_auction' }));
          break;
        }
        if (auction.joinedChannelIds.indexOf(msg.channelId) === -1) {
          ws.send(JSON.stringify({ type: 'bid_result', requestId: requestId, ok: false, reason: 'not_joined', entryFee: auction.entryFee || 0 }));
          break;
        }
        var minRequired = liveAuctionMinNextBid(auction);
        var amount = msg.nominal != null ? Number(msg.nominal) : minRequired;
        if (!isFinite(amount) || amount < minRequired) {
          ws.send(JSON.stringify({ type: 'bid_result', requestId: requestId, ok: false, reason: 'below_minimum', minRequired: minRequired }));
          break;
        }
        var bidderUser = ensureEconomyUser(msg.channelId, msg.displayName);
        if (bidderUser.balance < amount) {
          ws.send(JSON.stringify({ type: 'bid_result', requestId: requestId, ok: false, reason: 'insufficient_funds', balance: bidderUser.balance }));
          break;
        }

        // Escrow: refund the previous bidder IN FULL (if any), then charge
        // the new one. If the new bidder IS the previous bidder (re-bidding
        // over their own standing bid), the refund above already landed in
        // `bidderUser.balance` since it's the same object reference.
        var prevBidderChannelId = auction.currentBidderChannelId;
        var prevBidAmount = auction.currentBid;
        if (prevBidderChannelId) {
          var prevBidder = ensureEconomyUser(prevBidderChannelId, null);
          prevBidder.balance += prevBidAmount;
        }
        bidderUser.balance -= amount;

        auction.currentBid = amount;
        auction.currentBidderChannelId = msg.channelId;
        auction.currentBidderName = msg.displayName || bidderUser.displayName;
        auction.endsAt += LIVE_AUCTION_BID_TIME_EXTENSION_MS;

        persistLiveAuction();
        persistEconomy();
        liveAuctionBroadcastState();
        ws.send(JSON.stringify({ type: 'bid_result', requestId: requestId, ok: true, amount: amount, balance: bidderUser.balance, endsAt: auction.endsAt }));
        break;
      }
    }
  });
});

// ---- Exclusive Auction: EXCLUSIVE_CURRENCY_NAME, via YouTube live chat ----
// Structurally a parallel copy of Live Auction (same escrow/anti-snipe/
// entry-fee/history mechanics, same single-active-auction constraint)
// with its own, separate balance ledger -- kept as an independent
// implementation rather than sharing code with Live Auction, since the
// two currencies are meant to evolve independently (e.g. this one's
// monthly depreciation sweep has no equivalent on the other side).

var EXCLUSIVE_STATE_FILE = path.join(DATA_DIR, 'exclusive-auction-state.json');
var EXCLUSIVE_AUCTION_MIN_INCREMENT_PERCENT = 5;
var EXCLUSIVE_AUCTION_SWEEP_MS = 5 * 1000;
var EXCLUSIVE_AUCTION_BID_TIME_EXTENSION_MS = 30 * 1000;
var EXCLUSIVE_AUCTION_HISTORY_LIMIT = 200;

function loadExclusiveState() {
  try {
    var raw = fs.readFileSync(EXCLUSIVE_STATE_FILE, 'utf8');
    var parsed = JSON.parse(raw);
    return {
      meta: { lastDepreciationPeriod: (parsed.meta && parsed.meta.lastDepreciationPeriod) || null },
      users: parsed.users && typeof parsed.users === 'object' ? parsed.users : {}, // channelId -> { displayName, balance }
      auction: parsed.auction || null,
      auctionHistory: Array.isArray(parsed.auctionHistory) ? parsed.auctionHistory : [],
    };
  } catch (err) {
    return { meta: { lastDepreciationPeriod: null }, users: {}, auction: null, auctionHistory: [] };
  }
}

var exclusiveState = loadExclusiveState();

function persistExclusive() {
  writeJsonFile(EXCLUSIVE_STATE_FILE, exclusiveState, 'exclusive-auction');
}

function ensureExclusiveUser(channelId, displayName) {
  var u = exclusiveState.users[channelId];
  if (!u) {
    u = { displayName: displayName || channelId, balance: 0 };
    exclusiveState.users[channelId] = u;
    return u;
  }
  if (displayName && u.displayName !== displayName) u.displayName = displayName;
  return u;
}

function exclusiveAuctionBroadcast(obj) {
  var payload = JSON.stringify(obj);
  exclusiveAuctionWss.clients.forEach(function (client) {
    if (client.readyState === 1) client.send(payload);
  });
}
function exclusiveAuctionBroadcastState() {
  exclusiveAuctionBroadcast({ type: 'state', auction: exclusiveState.auction, auctionHistory: exclusiveState.auctionHistory });
}

function exclusiveAuctionMinNextBid(auction) {
  if (auction.currentBid == null) return auction.startingPrice;
  return Math.ceil(auction.currentBid * (1 + EXCLUSIVE_AUCTION_MIN_INCREMENT_PERCENT / 100));
}

function closeExclusiveAuction(auction) {
  auction.status = 'closed';
  exclusiveState.auctionHistory.unshift({
    itemName: auction.itemName,
    pictureUrl: auction.pictureUrl,
    startingPrice: auction.startingPrice,
    finalBid: auction.currentBid,
    winnerChannelId: auction.currentBidderChannelId,
    winnerName: auction.currentBidderName,
    closedAt: Date.now(),
  });
  if (exclusiveState.auctionHistory.length > EXCLUSIVE_AUCTION_HISTORY_LIMIT) {
    exclusiveState.auctionHistory = exclusiveState.auctionHistory.slice(0, EXCLUSIVE_AUCTION_HISTORY_LIMIT);
  }
  persistExclusive();
}

setInterval(function () {
  var auction = exclusiveState.auction;
  if (!auction || auction.status !== 'active' || Date.now() < auction.endsAt) return;
  closeExclusiveAuction(auction);
  exclusiveAuctionBroadcastState();
}, EXCLUSIVE_AUCTION_SWEEP_MS);

// ---- EXCLUSIVE_CURRENCY_NAME monthly depreciation --------------------------
// Unlike CURRENCY_NAME (which just sits there), this currency shrinks by
// EXCLUSIVE_CURRENCY_DEPRECIATION_PERCENT every calendar month -- checked
// hourly, applied once per completed month. On the very first run ever
// this deliberately does NOT depreciate retroactively, it just marks
// "caught up as of now".

function getLastCompletedMonthKey(now) {
  var month = now.getMonth() + 1;
  var year = now.getFullYear();
  month -= 1;
  if (month <= 0) {
    month = 12;
    year -= 1;
  }
  return year + '-' + (month < 10 ? '0' + month : String(month));
}

function sweepExclusiveDepreciation() {
  for (var channelId in exclusiveState.users) {
    var u = exclusiveState.users[channelId];
    if (u.balance > 0) {
      u.balance = Math.floor(u.balance * (1 - EXCLUSIVE_CURRENCY_DEPRECIATION_PERCENT / 100));
    }
  }
  persistExclusive();
}

function checkExclusiveDepreciation() {
  var periodKey = getLastCompletedMonthKey(new Date());
  if (exclusiveState.meta.lastDepreciationPeriod === null) {
    exclusiveState.meta.lastDepreciationPeriod = periodKey;
    persistExclusive();
    return;
  }
  if (exclusiveState.meta.lastDepreciationPeriod !== periodKey) {
    sweepExclusiveDepreciation();
    exclusiveState.meta.lastDepreciationPeriod = periodKey;
    persistExclusive();
    console.log('[exclusive-auction] ' + EXCLUSIVE_CURRENCY_DEPRECIATION_PERCENT + '% depreciation applied for period', periodKey);
  }
}

setInterval(checkExclusiveDepreciation, 60 * 60 * 1000);

exclusiveAuctionWss.on('connection', function (ws) {
  ws.send(JSON.stringify({ type: 'state', auction: exclusiveState.auction, auctionHistory: exclusiveState.auctionHistory }));

  ws.on('message', function (raw) {
    var msg;
    try {
      msg = JSON.parse(raw);
    } catch (err) {
      return;
    }
    var requestId = msg.requestId;

    switch (msg.type) {
      case 'get_balance': {
        var balChannelId = String(msg.channelId || '');
        var balUser = ensureExclusiveUser(balChannelId, msg.displayName);
        persistExclusive();
        ws.send(JSON.stringify({ type: 'get_balance_result', requestId: requestId, ok: true, balance: balUser.balance }));
        break;
      }

      // Read-only, for the control panel's "give currency to a user" form
      // -- joins the existing CURRENCY_NAME alias list (so it only lists
      // people who've actually run `!register`) with each one's current
      // EXCLUSIVE_CURRENCY_NAME balance.
      case 'list_registered_users': {
        var registeredUsers = Object.keys(economyState.users)
          .map(function (channelId) {
            var eu = economyState.users[channelId];
            return {
              channelId: channelId,
              alias: eu.alias,
              displayName: eu.displayName,
              balance: (exclusiveState.users[channelId] && exclusiveState.users[channelId].balance) || 0,
            };
          })
          .filter(function (entry) {
            return entry.alias;
          })
          .sort(function (a, b) {
            return a.alias.localeCompare(b.alias);
          });
        ws.send(JSON.stringify({ type: 'list_registered_users_result', requestId: requestId, ok: true, users: registeredUsers }));
        break;
      }

      case 'give_currency': {
        var giveChannelId = String(msg.channelId || '');
        var giveAmount = Number(msg.amount);
        if (!giveChannelId || !isFinite(giveAmount) || giveAmount <= 0) {
          ws.send(JSON.stringify({ type: 'give_currency_result', requestId: requestId, ok: false, reason: 'invalid_input' }));
          break;
        }
        var givenUser = ensureExclusiveUser(giveChannelId, msg.displayName);
        givenUser.balance += giveAmount;
        persistExclusive();
        ws.send(JSON.stringify({ type: 'give_currency_result', requestId: requestId, ok: true, balance: givenUser.balance }));
        break;
      }

      case 'start_auction': {
        var existingEx = exclusiveState.auction;
        if (existingEx && existingEx.status === 'active' && Date.now() < existingEx.endsAt) {
          ws.send(JSON.stringify({ type: 'start_auction_result', requestId: requestId, ok: false, reason: 'already_active' }));
          break;
        }
        var exItemName = String(msg.itemName || '').trim();
        var exStartingPrice = Number(msg.startingPrice);
        var exDurationMinutes = Number(msg.durationMinutes);
        var exEntryFee = msg.entryFee != null ? Number(msg.entryFee) : 0;
        if (!exItemName || !isFinite(exStartingPrice) || exStartingPrice <= 0 || !isFinite(exDurationMinutes) || exDurationMinutes <= 0 || !isFinite(exEntryFee) || exEntryFee < 0) {
          ws.send(JSON.stringify({ type: 'start_auction_result', requestId: requestId, ok: false, reason: 'invalid_input' }));
          break;
        }
        var newExAuction = {
          itemName: exItemName,
          pictureUrl: msg.pictureUrl || null,
          startingPrice: exStartingPrice,
          entryFee: exEntryFee,
          joinedChannelIds: [],
          currentBid: null,
          currentBidderChannelId: null,
          currentBidderName: null,
          createdAt: Date.now(),
          endsAt: Date.now() + exDurationMinutes * 60 * 1000,
          status: 'active',
        };
        exclusiveState.auction = newExAuction;
        persistExclusive();
        exclusiveAuctionBroadcastState();
        ws.send(JSON.stringify({ type: 'start_auction_result', requestId: requestId, ok: true, auction: newExAuction }));
        break;
      }

      case 'close_auction_now': {
        var exToClose = exclusiveState.auction;
        if (!exToClose || exToClose.status !== 'active') {
          ws.send(JSON.stringify({ type: 'close_auction_now_result', requestId: requestId, ok: false, reason: 'no_active_auction' }));
          break;
        }
        closeExclusiveAuction(exToClose);
        exclusiveAuctionBroadcastState();
        ws.send(JSON.stringify({ type: 'close_auction_now_result', requestId: requestId, ok: true }));
        break;
      }

      case 'join_bid': {
        var joinExAuction = exclusiveState.auction;
        if (!joinExAuction || joinExAuction.status !== 'active' || Date.now() >= joinExAuction.endsAt) {
          ws.send(JSON.stringify({ type: 'join_bid_result', requestId: requestId, ok: false, reason: 'no_active_auction' }));
          break;
        }
        if (joinExAuction.joinedChannelIds.indexOf(msg.channelId) !== -1) {
          ws.send(JSON.stringify({ type: 'join_bid_result', requestId: requestId, ok: false, reason: 'already_joined' }));
          break;
        }
        var exFee = joinExAuction.entryFee || 0;
        var joiningExUser = ensureExclusiveUser(msg.channelId, msg.displayName);
        if (joiningExUser.balance < exFee) {
          ws.send(JSON.stringify({ type: 'join_bid_result', requestId: requestId, ok: false, reason: 'insufficient_funds', balance: joiningExUser.balance, fee: exFee }));
          break;
        }
        joinExAuction.joinedChannelIds.push(msg.channelId);
        joiningExUser.balance -= exFee;
        persistExclusive();
        exclusiveAuctionBroadcastState();
        ws.send(JSON.stringify({ type: 'join_bid_result', requestId: requestId, ok: true, fee: exFee, balance: joiningExUser.balance }));
        break;
      }

      case 'bid': {
        var exAuction = exclusiveState.auction;
        if (!exAuction || exAuction.status !== 'active' || Date.now() >= exAuction.endsAt) {
          ws.send(JSON.stringify({ type: 'bid_result', requestId: requestId, ok: false, reason: 'no_active_auction' }));
          break;
        }
        if (exAuction.joinedChannelIds.indexOf(msg.channelId) === -1) {
          ws.send(JSON.stringify({ type: 'bid_result', requestId: requestId, ok: false, reason: 'not_joined', entryFee: exAuction.entryFee || 0 }));
          break;
        }
        var exMinRequired = exclusiveAuctionMinNextBid(exAuction);
        var exAmount = msg.nominal != null ? Number(msg.nominal) : exMinRequired;
        if (!isFinite(exAmount) || exAmount < exMinRequired) {
          ws.send(JSON.stringify({ type: 'bid_result', requestId: requestId, ok: false, reason: 'below_minimum', minRequired: exMinRequired }));
          break;
        }
        var exBidderUser = ensureExclusiveUser(msg.channelId, msg.displayName);
        if (exBidderUser.balance < exAmount) {
          ws.send(JSON.stringify({ type: 'bid_result', requestId: requestId, ok: false, reason: 'insufficient_funds', balance: exBidderUser.balance }));
          break;
        }

        var exPrevBidderChannelId = exAuction.currentBidderChannelId;
        var exPrevBidAmount = exAuction.currentBid;
        if (exPrevBidderChannelId) {
          var exPrevBidder = ensureExclusiveUser(exPrevBidderChannelId, null);
          exPrevBidder.balance += exPrevBidAmount;
        }
        exBidderUser.balance -= exAmount;

        exAuction.currentBid = exAmount;
        exAuction.currentBidderChannelId = msg.channelId;
        exAuction.currentBidderName = msg.displayName || exBidderUser.displayName;
        exAuction.endsAt += EXCLUSIVE_AUCTION_BID_TIME_EXTENSION_MS;

        persistExclusive();
        exclusiveAuctionBroadcastState();
        ws.send(JSON.stringify({ type: 'bid_result', requestId: requestId, ok: true, amount: exAmount, balance: exBidderUser.balance, endsAt: exAuction.endsAt }));
        break;
      }
    }
  });
});

// ---- Startup -----------------------------------------------------------------

server.listen(PORT, function () {
  console.log('Stream Toolkit server running at http://localhost:' + PORT);
  console.log('  Currency            : ' + CURRENCY_NAME + ' (' + Object.keys(economyState.users).length + ' known users)');
  console.log('  Exclusive currency  : ' + EXCLUSIVE_CURRENCY_NAME + ' (' + EXCLUSIVE_CURRENCY_DEPRECIATION_PERCENT + '%/month depreciation, ' + Object.keys(exclusiveState.users).length + ' known users)');
  console.log('  [Point Spinner]     Control: http://localhost:' + PORT + '/point-spinner/control');
  console.log('  [Point Spinner]     Overlay: http://localhost:' + PORT + '/point-spinner/overlay');
  console.log('  [Point Spinner]     Winner : http://localhost:' + PORT + '/point-spinner/winner');
  console.log('  [Live Auction]      Control: http://localhost:' + PORT + '/live-auction/control');
  console.log('  [Live Auction]      Overlay: http://localhost:' + PORT + '/live-auction/overlay');
  console.log('  [Exclusive Auction] Control: http://localhost:' + PORT + '/exclusive-auction/control');
  console.log('  [Exclusive Auction] Overlay: http://localhost:' + PORT + '/exclusive-auction/overlay');
  console.log('  [Exclusive Auction] Winner : http://localhost:' + PORT + '/exclusive-auction/winner');
  console.log('  [Exclusive Auction] Test panel (no live chat needed): http://localhost:' + PORT + '/exclusive-auction/test-panel');
});
