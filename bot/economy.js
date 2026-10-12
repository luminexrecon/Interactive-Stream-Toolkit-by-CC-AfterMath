/* Thin wrapper around wsClients.connectEconomy() -- gives bot.js's command
 * handlers friendlier, task-shaped function names (earnIfEligible,
 * tryDeduct, findUserByNameOrAlias, ...) instead of calling the raw
 * request/reply client directly everywhere.
 */

var wsClients = require('./wsClients');

var SERVER_PORT = process.env.PORT || 3000;
var ECONOMY_WS_URL = 'ws://127.0.0.1:' + SERVER_PORT + '/economy/ws';

var client = wsClients.connectEconomy(ECONOMY_WS_URL);

function getUser(channelId) {
  return client.getBalance(channelId).then(function (r) {
    return r.user;
  });
}

function ensureUser(channelId, displayName) {
  return client.ensureUser(channelId, displayName).then(function (r) {
    return r.user;
  });
}

/** Sets/overwrites the alias registered via `!register`. Returns the
 * updated user record, or null if the user doesn't exist yet. */
function setAlias(channelId, alias) {
  return client.setAlias(channelId, alias).then(function (r) {
    return r.ok ? r.user : null;
  });
}

/** The name to show anywhere a viewer's identity is displayed (spin
 * history, overlay, chat replies): their registered alias if they have
 * one, otherwise their current YouTube display name. */
function getDisplayLabel(channelId, fallbackDisplayName) {
  return getUser(channelId).then(function (u) {
    if (u && u.alias) return u.alias;
    return (u && u.displayName) || fallbackDisplayName;
  });
}

/** Awards `amount` if this user's earn cooldown has elapsed (server-side,
 * atomic). Resolves `{ok, balance, reason?:'cooldown'}`. */
function earnIfEligible(channelId, displayName, amount, cooldownSeconds) {
  return client.earn(channelId, displayName, amount, cooldownSeconds);
}

/** Adds `amount` back to balance without touching displayName -- used to
 * refund a spin that couldn't actually happen, and by `!addpoints`.
 * Deliberately separate from earning so a refund/mod-adjustment never
 * overwrites displayName with whatever label (possibly an alias) happened
 * to be passed around at that point. Returns the new balance. */
function refund(channelId, amount) {
  return client.adjust(channelId, amount).then(function (r) {
    return r.balance;
  });
}

/** Deducts `amount` if the user has enough balance. Resolves `false` (no
 * change made) if they don't. */
function tryDeduct(channelId, amount) {
  return client.spend(channelId, amount).then(function (r) {
    return r.ok;
  });
}

/** Sets balance to an exact value (floored at 0) -- used by !resetpoints. */
function setBalance(channelId, amount) {
  return client.setBalance(channelId, amount);
}

/** Looks up a known user by their current displayName OR their registered
 * alias (case-insensitive, leading "@" ignored) -- used to resolve the
 * <name> argument in moderator commands like !addpoints/!resetpoints/
 * !give. Only finds people who have chatted at least once (so a record
 * exists). Resolves `{ channelId, user }` or null. */
function findUserByNameOrAlias(query) {
  return client.findUser(query).then(function (r) {
    return r.found ? { channelId: r.channelId, user: r.user } : null;
  });
}

module.exports = {
  getUser: getUser,
  ensureUser: ensureUser,
  setAlias: setAlias,
  getDisplayLabel: getDisplayLabel,
  earnIfEligible: earnIfEligible,
  refund: refund,
  tryDeduct: tryDeduct,
  setBalance: setBalance,
  findUserByNameOrAlias: findUserByNameOrAlias,
};
