const ApiUsage = require('../models/schemas/ApiUsage');

/**
 * A daily budget for eBay's Trading API (GetItem, GetUser, GetMyeBaySelling).
 *
 * eBay allows a fixed number of Trading calls per DAY for the whole application (5,000 by default), no matter how many
 * stores or users share it. Views / watchers are the only thing that is read again and again, so they get a share
 * (70% by default) and can never eat the calls that order pictures, buyer profiles and the connect step need.
 * The count lives in MongoDB (one row per day), so it is right across restarts and more than one server.
 *
 * Bookkeeping never stops a feature: when the database misbehaves the call is allowed.
 */
const DEFAULT_DAILY_LIMIT = 5000;
const DEFAULT_STATS_SHARE = 0.7;
const KEEP_ROWS_MS = 3 * 24 * 60 * 60 * 1000;

function limits() {
  const limit = Math.max(1, Math.trunc(Number(process.env.EBAY_TRADING_DAILY_LIMIT)) || DEFAULT_DAILY_LIMIT);
  const shareRaw = Number(process.env.EBAY_TRADING_STATS_SHARE);
  const share = shareRaw > 0 && shareRaw <= 1 ? shareRaw : DEFAULT_STATS_SHARE;
  return { limit, statsLimit: Math.max(1, Math.floor(limit * share)) };
}

/** eBay counts its days in Pacific time; the row for "today" is named after that date. */
function dayKey(now = new Date()) {
  let day;
  try {
    day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch (_) {
    day = now.toISOString().slice(0, 10);
  }
  return 'trading:' + day;
}

const expireAtFor = (now = new Date()) => new Date(now.getTime() + KEEP_ROWS_MS);

/** What a new day row starts with, except the fields the same update already counts (MongoDB refuses both on one field). */
function onInsert(inc = {}) {
  const row = { expireAt: expireAtFor() };
  if (!('total' in inc)) row.total = 0;
  if (!('stats' in inc)) row.stats = 0;
  return row;
}

/**
 * Asks for `n` calls of a kind ('stats' = views / watchers, anything else = other reads). Returns false when today's
 * budget for that kind is used up (or eBay already said its limit is reached), true otherwise. Counts the calls it grants.
 */
async function reserve(kind, n = 1) {
  const { limit, statsLimit } = limits();
  const key = dayKey();
  const filter = { key, exhausted: { $ne: true }, total: { $lte: limit - n } };
  const inc = { total: n };
  if (kind === 'stats') { filter.stats = { $lte: statsLimit - n }; inc.stats = n; }
  try {
    const row = await ApiUsage.findOneAndUpdate(filter, { $inc: inc, $setOnInsert: onInsert(inc) }, { upsert: true, new: true });
    return !!row;
  } catch (err) {
    // The day's row exists but the limit (or the exhausted flag) kept this update from matching: the insert then hits the unique key.
    if (err && err.code === 11000) return false;
    console.warn('[ebay-budget] could not count a call, allowing it:', err.message);
    return true;
  }
}

/** Counts calls that must never be refused (connect step, order pictures, buyer profiles) so the stats share knows about them. */
async function record(kind, n = 1) {
  const inc = { total: n };
  if (kind === 'stats') inc.stats = n;
  try {
    await ApiUsage.updateOne({ key: dayKey() }, { $inc: inc, $setOnInsert: onInsert(inc) }, { upsert: true });
  } catch (err) {
    console.warn('[ebay-budget] could not count a call:', err.message);
  }
}

/** eBay itself answered "call limit reached": stop asking for today. */
async function markExhausted() {
  try {
    await ApiUsage.updateOne({ key: dayKey() }, { $set: { exhausted: true, exhaustedAt: new Date() }, $setOnInsert: onInsert() }, { upsert: true });
  } catch (err) {
    console.warn('[ebay-budget] could not save the exhausted flag:', err.message);
  }
}

/** Does this eBay Trading failure mean "your call allowance for today is used up"? */
function isLimitFailure(code, message) {
  if (String(code || '').trim() === '518') return true;
  return /(call|usage|api)\s+(usage\s+)?limit|limit\s+(has\s+been\s+)?(reached|exceeded)|exceeded\s+(its|the|your)\s+(daily\s+)?(call|usage)/i.test(String(message || ''));
}

/** Today's numbers, for the admin panel. */
async function snapshot() {
  const { limit, statsLimit } = limits();
  const key = dayKey();
  let row = null;
  try { row = await ApiUsage.findOne({ key }).lean(); } catch (_) { /* shown as zero */ }
  return { day: key.replace('trading:', ''), limit, statsLimit, total: row?.total || 0, stats: row?.stats || 0, exhausted: !!row?.exhausted };
}

module.exports = { reserve, record, markExhausted, isLimitFailure, snapshot, limits, dayKey };
