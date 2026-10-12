/* YouTube live chat bot -- the piece that actually talks to YouTube.
 * Runs as its own Node process, on the SAME machine as server.js, and
 * connects to it over WebSocket exactly like a browser control panel
 * would (see wsClients.js).
 *
 * - Awards CURRENCY_NAME to everyone who chats, with a cooldown to
 *   prevent spam farming.
 * - Handles !balance, !register <alias>, and !spin (Point Spinner),
 *   !joinbid/!bid (Live Auction), !joinex/!bidex/!balancepremium
 *   (Exclusive Auction), and moderator-only !addpoints/!resetpoints/
 *   !setcost/!give. Once someone registers an alias, it's used
 *   everywhere their identity would otherwise show (chat replies, the
 *   overlay's participant name, spin/auction history) instead of their
 *   raw YouTube display name.
 * - Spins are queued and played one at a time so they never overlap on
 *   the overlay; !spin costs CURRENCY_NAME up front and refunds
 *   automatically if the spin can't actually happen (e.g. empty prize
 *   pool).
 * - Permission levels (everyone / moderator / owner), read straight off
 *   YouTube's own authorDetails.isChatModerator / isChatOwner -- no extra
 *   API call needed.
 *
 * Setup (see README.md and docs/SETUP.md for the full walkthrough):
 *   1. Fill in .env (YOUTUBE_CHANNEL_ID, currency names, ...).
 *   2. Put your Google Cloud OAuth client JSON at bot/client_secret.json.
 *   3. Run: node bot/authorize.js main
 *      Run: node bot/authorize.js bot
 *   4. Make sure server.js is already running (npm start).
 *   5. Run: node bot/bot.js
 */

require('dotenv').config();

var fs = require('fs');
var path = require('path');
var google = require('googleapis').google;
var economy = require('./economy');
var wsClients = require('./wsClients');

var TOKENS_DIR = path.resolve(__dirname, '..', process.env.YOUTUBE_TOKENS_DIR || './bot/tokens');
var CLIENT_SECRET_PATH = path.resolve(__dirname, '..', process.env.YOUTUBE_CLIENT_SECRET_PATH || './bot/client_secret.json');
var CHANNEL_ID = process.env.YOUTUBE_CHANNEL_ID || '';

var CURRENCY_NAME = process.env.CURRENCY_NAME || 'Points';
var EXCLUSIVE_CURRENCY_NAME = process.env.EXCLUSIVE_CURRENCY_NAME || 'Premium Points';

var SERVER_PORT = process.env.PORT || 3000;
var POINT_WS_URL = 'ws://127.0.0.1:' + SERVER_PORT + '/point-spinner/ws';
var LIVE_AUCTION_WS_URL = 'ws://127.0.0.1:' + SERVER_PORT + '/live-auction/ws';
var EXCLUSIVE_AUCTION_WS_URL = 'ws://127.0.0.1:' + SERVER_PORT + '/exclusive-auction/ws';

// Quota math (YouTube Data API default: 10,000 units/day):
//   liveBroadcasts.list = ~1-2 units/call (cheap, and NOT in the separate
//     "Search Queries per day" bucket -- that bucket defaults to a much
//     stricter 100 calls/day regardless of the general 10,000-unit budget,
//     which a search.list-based "find my live video" approach would hit
//     within hours of idle "waiting for live" polling, long before the
//     general quota was anywhere near exhausted)
//   liveChatMessages.list = 5 units/call, .insert = 50 units/call
// These intervals are deliberately conservative so a bot left running most
// of the day (plus a multi-hour stream) doesn't run out before the day is
// over.
var LIVE_VIDEO_RECHECK_MS = 5 * 60 * 1000; // liveBroadcasts.list only while NOT live yet
var CHAT_POLL_MIN_MS = 10000; // floor under YouTube's own suggested pollingIntervalMillis
// If a quota error hits mid-stream, back off this long before touching the
// API again (retrying the same liveChatId, NOT re-running findLiveChatId).
var QUOTA_BACKOFF_MS = 30 * 60 * 1000;
// Must stay >= the overlay's SPIN_DURATION_MS + REVEAL_HOLD_MS (see
// point-spinner/js/client.js TIMING) so one spin's animation always
// finishes before the next one starts.
var SPIN_QUEUE_GAP_MS = 12500;
var REPLY_THROTTLE_MS = 4000;

function isQuotaError(err) {
  var msg = (err && err.message) || '';
  return /quota/i.test(msg);
}

function log() {
  var args = Array.prototype.slice.call(arguments);
  console.log.apply(console, ['[' + new Date().toLocaleTimeString() + ']'].concat(args));
}

// ---- Config check ------------------------------------------------------

if (!CHANNEL_ID) {
  console.error('Set YOUTUBE_CHANNEL_ID in .env first (see docs/SETUP.md).');
  process.exit(1);
}

// ---- Bot account OAuth ---------------------------------------------------

function loadClientSecret() {
  if (!fs.existsSync(CLIENT_SECRET_PATH)) {
    console.error('Could not find ' + CLIENT_SECRET_PATH);
    console.error('Follow docs/SETUP.md first, then run bot/authorize.js.');
    process.exit(1);
  }
  var raw = fs.readFileSync(CLIENT_SECRET_PATH, 'utf8');
  var data = JSON.parse(raw);
  var creds = data.installed || data.web;
  return { client_id: creds.client_id, client_secret: creds.client_secret };
}

function createOAuthClient(which) {
  var creds = loadClientSecret();
  var tokenPath = path.join(TOKENS_DIR, which + '.json');
  if (!fs.existsSync(tokenPath)) {
    console.error('Token "' + which + '" not found yet. Run first: node bot/authorize.js ' + which);
    process.exit(1);
  }
  var tokens = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
  var client = new google.auth.OAuth2(creds.client_id, creds.client_secret);
  client.setCredentials(tokens);
  client.on('tokens', function (newTokens) {
    tokens = Object.assign({}, tokens, newTokens);
    try {
      fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));
    } catch (err) {}
  });
  return client;
}

var botAuth = createOAuthClient('bot');
var youtubeBot = google.youtube({ version: 'v3', auth: botAuth });
// Readonly scope, see bot/authorize.js -- used ONLY for
// liveBroadcasts.list(broadcastStatus: 'active') below, which finds OUR
// OWN currently-live broadcast without touching the Search quota bucket
// at all (unlike a search.list-based approach, which shares a much
// stricter separate 100-calls/day cap, hit far before the general
// 10,000-unit/day budget ever would).
var mainAuth = createOAuthClient('main');
var youtubeMain = google.youtube({ version: 'v3', auth: mainAuth });

var spinnerClient = wsClients.connectPointSpinner(POINT_WS_URL);
var liveAuctionClient = wsClients.connectLiveAuction(LIVE_AUCTION_WS_URL);
var exclusiveAuctionClient = wsClients.connectExclusiveAuction(EXCLUSIVE_AUCTION_WS_URL);

var liveChatId = null;
var nextPageToken = undefined;

// ---- Live chat discovery ----------------------------------------------------

// liveBroadcasts.list(broadcastStatus: 'active') asks "is the channel I'm
// authenticated as (youtubeMain, OAuth) currently live" directly -- one
// call, no separate videoId lookup needed, and (crucially) it's NOT a
// search.list call so it doesn't touch the Search quota bucket at all.
function findLiveChatId() {
  return youtubeMain.liveBroadcasts
    .list({ part: ['snippet'], broadcastStatus: 'active', broadcastType: 'all' })
    .then(function (res) {
      var items = res.data.items || [];
      if (!items.length) return null;
      return (items[0].snippet && items[0].snippet.liveChatId) || null;
    });
}

function ensureLiveChat() {
  if (liveChatId) return;
  findLiveChatId()
    .then(function (id) {
      if (id) {
        liveChatId = id;
        log('Live chat found, fast-forwarding to the current position (skipping old history)...');
        primeLiveChat();
      } else {
        setTimeout(ensureLiveChat, LIVE_VIDEO_RECHECK_MS);
      }
    })
    .catch(function (err) {
      if (isQuotaError(err)) {
        log('Daily API quota exhausted. Will check for a live stream again in', QUOTA_BACKOFF_MS / 60000, 'minutes.');
        setTimeout(ensureLiveChat, QUOTA_BACKOFF_MS);
        return;
      }
      log('Failed to look up a live video:', err.message);
      setTimeout(ensureLiveChat, LIVE_VIDEO_RECHECK_MS);
    });
}

/** The first `liveChatMessages.list` call on a fresh liveChatId (no
 * pageToken yet) returns a backlog of everything said so far, not just
 * new messages -- without this priming step, every bot (re)start would
 * replay the whole chat history, re-awarding currency and re-triggering
 * old !spin commands. This call captures `nextPageToken` (our "start
 * reading from here" bookmark) and deliberately throws its `items` away
 * instead of running them through processMessage(). */
function primeLiveChat() {
  youtubeBot.liveChatMessages
    .list({ liveChatId: liveChatId, part: ['snippet', 'authorDetails'] })
    .then(function (res) {
      nextPageToken = res.data.nextPageToken; // bookmark only -- res.data.items intentionally ignored
      log('Ready. Watching for new messages from now on.');
      var wait = Math.max(res.data.pollingIntervalMillis || 5000, CHAT_POLL_MIN_MS);
      setTimeout(pollChat, wait);
    })
    .catch(function (err) {
      if (isQuotaError(err)) {
        log('Daily API quota exhausted while priming. Retrying in', QUOTA_BACKOFF_MS / 60000, 'minutes.');
        setTimeout(primeLiveChat, QUOTA_BACKOFF_MS);
        return;
      }
      log('Failed to prime live chat position:', err.message);
      liveChatId = null;
      setTimeout(ensureLiveChat, LIVE_VIDEO_RECHECK_MS);
    });
}

function pollChat() {
  if (!liveChatId) return;
  youtubeBot.liveChatMessages
    .list({ liveChatId: liveChatId, part: ['snippet', 'authorDetails'], pageToken: nextPageToken })
    .then(async function (res) {
      nextPageToken = res.data.nextPageToken;
      // Sequential (not .forEach) -- economy calls are WS round-trips, and
      // messages must still be applied in the order they arrived.
      var items = res.data.items || [];
      for (var i = 0; i < items.length; i++) {
        await processMessage(items[i]);
      }
      var wait = Math.max(res.data.pollingIntervalMillis || 5000, CHAT_POLL_MIN_MS);
      setTimeout(pollChat, wait);
    })
    .catch(function (err) {
      if (isQuotaError(err)) {
        log('Daily API quota exhausted. Retrying in', QUOTA_BACKOFF_MS / 60000, 'minutes (not re-searching for the live video, to save quota).');
        setTimeout(pollChat, QUOTA_BACKOFF_MS);
        return;
      }
      log('Live chat stopped (stream probably ended):', err.message);
      liveChatId = null;
      nextPageToken = undefined;
      setTimeout(ensureLiveChat, LIVE_VIDEO_RECHECK_MS);
    });
}

// ---- Reply queue (throttled liveChatMessages.insert) -----------------------

var replyQueue = [];
var replyBusy = false;

function queueReply(text) {
  replyQueue.push(text);
  drainReplies();
}

function drainReplies() {
  if (replyBusy || !replyQueue.length || !liveChatId) return;
  replyBusy = true;
  var text = replyQueue.shift();
  log('Sending reply:', text);
  youtubeBot.liveChatMessages
    .insert({
      part: ['snippet'],
      requestBody: {
        snippet: {
          liveChatId: liveChatId,
          type: 'textMessageEvent',
          textMessageDetails: { messageText: text },
        },
      },
    })
    .then(
      function (res) {
        var sentId = (res && res.data && res.data.id) || '?';
        log('Reply accepted by the API (id ' + sentId + '):', text);
      },
      function (err) {
        log('Failed to send chat reply:', err.message, '-- text:', text);
      }
    )
    .then(function () {
      setTimeout(function () {
        replyBusy = false;
        drainReplies();
      }, REPLY_THROTTLE_MS);
    });
}

// ---- Spin queue (one at a time, matching the overlay's animation length) --

var spinQueue = [];
var spinInFlight = false;

function queueSpin(channelId, label, cost) {
  spinQueue.push({ channelId: channelId, label: label, cost: cost });
  drainSpinQueue();
}

function drainSpinQueue() {
  if (spinInFlight || !spinQueue.length) return;
  spinInFlight = true;
  var job = spinQueue.shift();

  spinnerClient.requestSpin(job.label).then(function (result) {
    if (!result.ok) {
      economy.refund(job.channelId, job.cost).then(function () {
        log('Spin for', job.label, 'failed:', result.reason, '- ' + CURRENCY_NAME + ' refunded.');
        queueReply('@' + job.label + ' spin failed (prize not ready), ' + job.cost + ' ' + CURRENCY_NAME + ' refunded.');
      });
    } else {
      log('Spin for', job.label, 'succeeded (spinId ' + result.spinId + ').');
    }
    setTimeout(function () {
      spinInFlight = false;
      drainSpinQueue();
    }, SPIN_QUEUE_GAP_MS);
  });
}

// ---- Permission levels -------------------------------------------------------
// YouTube already tells us this on every message (no extra API call
// needed): authorDetails.isChatOwner (the broadcaster) / isChatModerator
// (channel mods). "everyone" covers all other viewers.

var LEVEL_RANK = { everyone: 0, moderator: 1, owner: 2 };

function getPermissionLevel(author) {
  if (author.isChatOwner) return 'owner';
  if (author.isChatModerator) return 'moderator';
  return 'everyone';
}

function hasAtLeast(level, required) {
  return (LEVEL_RANK[level] || 0) >= (LEVEL_RANK[required] || 0);
}

// ---- Commands --------------------------------------------------------------

var MAX_ALIAS_LENGTH = 24;

async function handleCommand(channelId, displayName, text, level) {
  var trimmed = text.trim();
  var lower = trimmed.toLowerCase();
  var label = await economy.getDisplayLabel(channelId, displayName);

  if (lower === '!balance' || lower === '!saldo') {
    var u = await economy.getUser(channelId);
    var balance = u ? u.balance : 0;
    queueReply('@' + label + ' your ' + CURRENCY_NAME + ' balance: ' + balance);
    return true;
  }

  if (lower === '!balancepremium') {
    var exBalResult = await exclusiveAuctionClient.getBalance(channelId, label);
    var exBalance = exBalResult.ok ? exBalResult.balance : 0;
    queueReply('@' + label + ' your ' + EXCLUSIVE_CURRENCY_NAME + ' balance: ' + exBalance);
    return true;
  }

  if (lower.indexOf('!register') === 0) {
    var alias = trimmed.slice('!register'.length).trim();
    if (!alias) {
      queueReply('@' + label + ' usage: !register YourAliasHere');
      return true;
    }
    if (alias.length > MAX_ALIAS_LENGTH) alias = alias.slice(0, MAX_ALIAS_LENGTH);
    await economy.setAlias(channelId, alias);
    log('Alias registered:', channelId, '->', alias);
    queueReply('@' + displayName + ' done! From now on you\'ll show up as "' + alias + '" in spin/auction history.');
    return true;
  }

  if (lower.indexOf('!addpoints') === 0) {
    if (!hasAtLeast(level, 'moderator')) {
      queueReply('@' + label + ' this command is moderator-only.');
      return true;
    }
    var addArgs = trimmed.slice('!addpoints'.length).trim().split(/\s+/);
    var addTarget = addArgs[0];
    var addAmount = parseInt(addArgs[1], 10);
    if (!addTarget || !isFinite(addAmount)) {
      queueReply('Usage: !addpoints <name/alias> <amount>');
      return true;
    }
    var addFound = await economy.findUserByNameOrAlias(addTarget);
    if (!addFound) {
      queueReply('User "' + addTarget + '" not found yet (they need to have chatted at least once).');
      return true;
    }
    await economy.refund(addFound.channelId, addAmount);
    var addLabel = await economy.getDisplayLabel(addFound.channelId, addFound.user.displayName);
    queueReply('Added ' + addAmount + ' ' + CURRENCY_NAME + ' to ' + addLabel + '.');
    return true;
  }

  // EXCLUSIVE_CURRENCY_NAME is never earned automatically -- !give
  // (moderator-only) is the ONLY way it enters circulation. Resolves the
  // target via the EXISTING CURRENCY_NAME alias lookup (same one
  // !addpoints uses), then credits the exclusive currency (a fully
  // separate ledger, see server.js) for that resolved channelId. Nickname
  // supports quotes so it can contain spaces: !give "Long Name" 100.
  if (lower.indexOf('!give') === 0) {
    if (!hasAtLeast(level, 'moderator')) {
      queueReply('@' + label + ' this command is moderator-only.');
      return true;
    }
    var giveRest = trimmed.slice('!give'.length).trim();
    var giveMatch = giveRest.match(/^"([^"]+)"\s+"?(-?\d+)"?\s*$/) || giveRest.match(/^(\S+)\s+"?(-?\d+)"?\s*$/);
    if (!giveMatch) {
      queueReply('Usage: !give "registered nickname" <amount>');
      return true;
    }
    var giveTarget = giveMatch[1];
    var giveAmount = parseInt(giveMatch[2], 10);
    if (!isFinite(giveAmount) || giveAmount <= 0) {
      queueReply('The amount must be a positive number.');
      return true;
    }
    var giveFound = await economy.findUserByNameOrAlias(giveTarget);
    if (!giveFound) {
      queueReply('User "' + giveTarget + '" not found (they need to !register and have chatted at least once).');
      return true;
    }
    var giveResult = await exclusiveAuctionClient.giveCurrency(giveFound.channelId, giveFound.user.displayName, giveAmount);
    if (giveResult.ok) {
      queueReply('Gave ' + giveAmount + ' ' + EXCLUSIVE_CURRENCY_NAME + ' to ' + (giveFound.user.alias || giveFound.user.displayName) + '. New balance: ' + giveResult.balance + '.');
    } else {
      queueReply('Failed to give ' + EXCLUSIVE_CURRENCY_NAME + ' -- ' + (giveResult.reason || 'unknown') + '.');
    }
    return true;
  }

  if (lower.indexOf('!resetpoints') === 0) {
    if (!hasAtLeast(level, 'moderator')) {
      queueReply('@' + label + ' this command is moderator-only.');
      return true;
    }
    var resetTarget = trimmed.slice('!resetpoints'.length).trim();
    if (!resetTarget) {
      queueReply('Usage: !resetpoints <name/alias>');
      return true;
    }
    var resetFound = await economy.findUserByNameOrAlias(resetTarget);
    if (!resetFound) {
      queueReply('User "' + resetTarget + '" not found yet (they need to have chatted at least once).');
      return true;
    }
    await economy.setBalance(resetFound.channelId, 0);
    var resetLabel = await economy.getDisplayLabel(resetFound.channelId, resetFound.user.displayName);
    queueReply(resetLabel + '\'s ' + CURRENCY_NAME + ' balance was reset to 0.');
    return true;
  }

  if (lower.indexOf('!setcost') === 0) {
    if (!hasAtLeast(level, 'moderator')) {
      queueReply('@' + label + ' this command is moderator-only.');
      return true;
    }
    var newCost = parseInt(trimmed.slice('!setcost'.length).trim(), 10);
    if (!isFinite(newCost) || newCost < 1) {
      queueReply('Usage: !setcost <amount>');
      return true;
    }
    spinnerClient.updateSettings({ spinCost: newCost });
    queueReply('Spin cost changed to ' + newCost + ' ' + CURRENCY_NAME + '.');
    return true;
  }

  if (lower === '!spin') {
    var state = spinnerClient.getState();
    var settings = state.settings || {};
    var cost = settings.spinCost != null ? settings.spinCost : 10;
    var items = state.items || [];

    if (!items.length) {
      queueReply('@' + label + ' there are no prizes to spin right now.');
      return true;
    }

    // No client-side balance pre-check -- trust tryDeduct's own atomic
    // check as the single source of truth instead of reading a balance
    // that could be stale by the time the deduct actually happens.
    var deducted = await economy.tryDeduct(channelId, cost);
    if (!deducted) {
      var u2 = await economy.getUser(channelId);
      var balance2 = u2 ? u2.balance : 0;
      queueReply('@' + label + ' not enough ' + CURRENCY_NAME + ' (need ' + cost + ', you have ' + balance2 + ').');
      return true;
    }

    queueReply('@' + label + ' spin starting! (-' + cost + ' ' + CURRENCY_NAME + ')');
    queueSpin(channelId, label, cost);
    return true;
  }

  if (lower === '!joinbid') {
    var joinResult = await liveAuctionClient.joinBid(channelId, label);
    if (joinResult.ok) {
      queueReply(
        joinResult.fee > 0
          ? '@' + label + ' joined the auction! (-' + joinResult.fee + ' ' + CURRENCY_NAME + ', new balance ' + joinResult.balance + '). You can now !bid.'
          : '@' + label + ' joined the auction! You can now !bid.'
      );
    } else {
      var joinMessages = {
        no_active_auction: 'there is no active auction right now.',
        already_joined: 'you already joined this auction.',
        insufficient_funds: 'your ' + CURRENCY_NAME + ' balance is too low for the entry fee (' + joinResult.fee + ' ' + CURRENCY_NAME + ', you have ' + joinResult.balance + ').',
        not_connected: 'the server is not reachable right now, try again.',
        timeout: 'the server did not respond, try again.',
      };
      queueReply('@' + label + ' failed to join -- ' + (joinMessages[joinResult.reason] || joinResult.reason || 'unknown'));
    }
    return true;
  }

  if (lower === '!bid' || lower.indexOf('!bid ') === 0) {
    var bidArg = trimmed.slice('!bid'.length).trim();
    var bidNominal = bidArg ? parseInt(bidArg, 10) : null;
    if (bidArg && !isFinite(bidNominal)) {
      queueReply('@' + label + ' usage: !bid or !bid <amount>');
      return true;
    }

    var bidResult = await liveAuctionClient.bid(channelId, label, bidNominal);
    if (bidResult.ok) {
      queueReply('@' + label + ' bid of ' + bidResult.amount + ' ' + CURRENCY_NAME + ' accepted! You are now the highest bidder.');
    } else {
      var bidMessages = {
        no_active_auction: 'there is no active auction right now.',
        not_joined: 'you haven\'t joined this auction yet -- type !joinbid first' + (bidResult.entryFee > 0 ? ' (fee: ' + bidResult.entryFee + ' ' + CURRENCY_NAME + ')' : '') + '.',
        below_minimum: 'the minimum bid is ' + bidResult.minRequired + ' ' + CURRENCY_NAME + '.',
        insufficient_funds: 'your ' + CURRENCY_NAME + ' balance is too low (balance: ' + bidResult.balance + ').',
        not_connected: 'the server is not reachable right now, try again.',
        timeout: 'the server did not respond, try again.',
      };
      queueReply('@' + label + ' bid failed -- ' + (bidMessages[bidResult.reason] || bidResult.reason || 'unknown'));
    }
    return true;
  }

  if (lower === '!joinex') {
    var joinExResult = await exclusiveAuctionClient.joinBid(channelId, label);
    if (joinExResult.ok) {
      queueReply(
        joinExResult.fee > 0
          ? '@' + label + ' joined the exclusive auction! (-' + joinExResult.fee + ' ' + EXCLUSIVE_CURRENCY_NAME + ', new balance ' + joinExResult.balance + '). You can now !bidex.'
          : '@' + label + ' joined the exclusive auction! You can now !bidex.'
      );
    } else {
      var joinExMessages = {
        no_active_auction: 'there is no active exclusive auction right now.',
        already_joined: 'you already joined this exclusive auction.',
        insufficient_funds: 'your ' + EXCLUSIVE_CURRENCY_NAME + ' balance is too low for the entry fee (' + joinExResult.fee + ' ' + EXCLUSIVE_CURRENCY_NAME + ', you have ' + joinExResult.balance + ').',
        not_connected: 'the server is not reachable right now, try again.',
        timeout: 'the server did not respond, try again.',
      };
      queueReply('@' + label + ' failed to join -- ' + (joinExMessages[joinExResult.reason] || joinExResult.reason || 'unknown'));
    }
    return true;
  }

  if (lower === '!bidex' || lower.indexOf('!bidex ') === 0) {
    var bidExArg = trimmed.slice('!bidex'.length).trim();
    var bidExNominal = bidExArg ? parseInt(bidExArg, 10) : null;
    if (bidExArg && !isFinite(bidExNominal)) {
      queueReply('@' + label + ' usage: !bidex or !bidex <amount>');
      return true;
    }

    var bidExResult = await exclusiveAuctionClient.bid(channelId, label, bidExNominal);
    if (bidExResult.ok) {
      queueReply('@' + label + ' bid of ' + bidExResult.amount + ' ' + EXCLUSIVE_CURRENCY_NAME + ' accepted! You are now the highest bidder.');
    } else {
      var bidExMessages = {
        no_active_auction: 'there is no active exclusive auction right now.',
        not_joined: 'you haven\'t joined this exclusive auction yet -- type !joinex first' + (bidExResult.entryFee > 0 ? ' (fee: ' + bidExResult.entryFee + ' ' + EXCLUSIVE_CURRENCY_NAME + ')' : '') + '.',
        below_minimum: 'the minimum bid is ' + bidExResult.minRequired + ' ' + EXCLUSIVE_CURRENCY_NAME + '.',
        insufficient_funds: 'your ' + EXCLUSIVE_CURRENCY_NAME + ' balance is too low (balance: ' + bidExResult.balance + ').',
        not_connected: 'the server is not reachable right now, try again.',
        timeout: 'the server did not respond, try again.',
      };
      queueReply('@' + label + ' bid failed -- ' + (bidExMessages[bidExResult.reason] || bidExResult.reason || 'unknown'));
    }
    return true;
  }

  return false;
}

// ---- Message processing -----------------------------------------------------

async function processMessage(item) {
  var author = item.authorDetails || {};
  var channelId = author.channelId;
  var displayName = author.displayName || 'viewer';
  var text = (item.snippet && item.snippet.displayMessage) || '';
  if (!channelId || !text) return;

  await economy.ensureUser(channelId, displayName);

  var level = getPermissionLevel(author);
  var wasCommand = await handleCommand(channelId, displayName, text, level);
  if (wasCommand) return;

  var state = spinnerClient.getState();
  var settings = state.settings || {};
  var pointsPerMessage = settings.pointsPerMessage != null ? settings.pointsPerMessage : 1;
  var cooldownSeconds = settings.cooldownSeconds != null ? settings.cooldownSeconds : 15;

  await economy.earnIfEligible(channelId, displayName, pointsPerMessage, cooldownSeconds);
}

// ---- Startup -----------------------------------------------------------------

log('Starting bot...');
log('Target channel:', CHANNEL_ID);
log('Looking for a live stream in progress...');
ensureLiveChat();
