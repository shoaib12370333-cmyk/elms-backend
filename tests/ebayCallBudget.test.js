// eBay's Trading API allows a fixed number of calls a day for the whole application. The daily budget gives views / watchers a share,
// counts everything else without ever refusing it, stops when eBay says "limit reached", and never blocks a feature because of bookkeeping.
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

// A tiny stand-in for the ApiUsage collection with the parts of findOneAndUpdate / updateOne that the budget uses
// (an existing row that does not match the filter makes the upsert insert a second row: MongoDB's duplicate key error).
const rows = new Map();
let failWith = null;
const matches = (row, filter) => Object.entries(filter).every(([k, v]) => {
  if (v && typeof v === 'object' && '$ne' in v) return row[k] !== v.$ne;
  if (v && typeof v === 'object' && '$lte' in v) return row[k] !== undefined && row[k] <= v.$lte;
  return row[k] === v;
});
const apply = (row, update) => {
  for (const [k, n] of Object.entries(update.$inc || {})) row[k] = (row[k] || 0) + n;
  Object.assign(row, update.$set || {});
};
const upsert = (filter, update) => {
  if (failWith) throw failWith;
  const row = rows.get(filter.key);
  if (row && !matches(row, filter)) { const e = new Error('E11000 duplicate key'); e.code = 11000; throw e; }
  if (row) { apply(row, update); return row; }
  const fresh = { key: filter.key, ...(update.$setOnInsert || {}) };
  apply(fresh, update);
  rows.set(filter.key, fresh);
  return fresh;
};
stub('models/schemas/ApiUsage', {
  findOneAndUpdate: async (filter, update) => upsert(filter, update),
  updateOne: async (filter, update) => { upsert({ key: filter.key }, update); },
  findOne: (filter) => ({ lean: async () => rows.get(filter.key) || null }),
});

const budget = require('../services/ebayCallBudget');
const reset = () => { rows.clear(); failWith = null; delete process.env.EBAY_TRADING_DAILY_LIMIT; delete process.env.EBAY_TRADING_STATS_SHARE; };

(async () => {
  // ---------- limits ----------
  reset();
  assert.deepStrictEqual(budget.limits(), { limit: 5000, statsLimit: 3500 }, '5,000 a day, 70% of it for statistics');
  process.env.EBAY_TRADING_DAILY_LIMIT = '100'; process.env.EBAY_TRADING_STATS_SHARE = '0.5';
  assert.deepStrictEqual(budget.limits(), { limit: 100, statsLimit: 50 }, 'both can be changed with environment variables');
  process.env.EBAY_TRADING_STATS_SHARE = '7';
  assert.strictEqual(budget.limits().statsLimit, 70, 'a share above 1 is ignored: back to 70%');
  assert.match(budget.dayKey(new Date('2026-09-26T12:00:00Z')), /^trading:2026-09-26$/, 'the row is named after the (Pacific) day');
  assert.strictEqual(budget.dayKey(new Date('2026-09-26T03:00:00Z')), 'trading:2026-09-25', 'at 03:00 UTC it is still yesterday in eBay\'s time');

  // ---------- statistics get their share and no more ----------
  reset();
  process.env.EBAY_TRADING_DAILY_LIMIT = '10'; process.env.EBAY_TRADING_STATS_SHARE = '0.5'; // 5 for statistics
  let granted = 0;
  for (let i = 0; i < 8; i += 1) if (await budget.reserve('stats')) granted += 1;
  assert.strictEqual(granted, 5, 'statistics stop at their share');
  let snap = await budget.snapshot();
  assert.deepStrictEqual([snap.total, snap.stats, snap.limit, snap.statsLimit, snap.exhausted], [5, 5, 10, 5, false]);

  // the rest of the day is still there for the other calls, and those are never refused (they are only counted)
  assert.strictEqual(await budget.reserve('other'), true, 'another kind of call is still allowed');
  for (let i = 0; i < 6; i += 1) await budget.record('core');
  snap = await budget.snapshot();
  assert.strictEqual(snap.total, 12, 'recorded calls are counted even past the limit');
  assert.strictEqual(await budget.reserve('stats'), false, 'and statistics are still stopped');

  // ---------- a first call of the day that is only counted must not lock statistics out (a row without a "stats" field never matched) ----------
  reset();
  await budget.record('core');
  assert.strictEqual(await budget.reserve('stats'), true, 'statistics work after the first recorded call of the day');
  assert.strictEqual((await budget.snapshot()).stats, 1);

  // ---------- eBay says the limit is reached: everything stops for the day ----------
  reset();
  await budget.markExhausted();
  assert.strictEqual(await budget.reserve('stats'), false, 'statistics are stopped');
  assert.strictEqual(await budget.reserve('other'), false, 'and so is every other counted call');
  snap = await budget.snapshot();
  assert.strictEqual(snap.exhausted, true);
  rows.clear();
  await budget.reserve('stats');
  await budget.markExhausted();
  assert.strictEqual((await budget.snapshot()).stats, 1, 'the flag keeps the numbers');

  // ---------- a broken database never blocks a seller ----------
  reset();
  const warn = console.warn; console.warn = () => {};
  failWith = Object.assign(new Error('connection lost'), { code: 6 });
  assert.strictEqual(await budget.reserve('stats'), true, 'bookkeeping trouble lets the call through');
  await budget.record('core'); await budget.markExhausted(); // must not throw
  assert.strictEqual((await budget.snapshot()).total, 0, 'the snapshot shows zero instead of failing');
  console.warn = warn;

  // ---------- which eBay answers mean "the daily limit is used up" ----------
  assert.strictEqual(budget.isLimitFailure('518', 'anything'), true, 'error 518');
  assert.strictEqual(budget.isLimitFailure('', 'Call usage limit has been reached.'), true);
  assert.strictEqual(budget.isLimitFailure(null, 'You have exceeded the call limit for this application.'), true);
  assert.strictEqual(budget.isLimitFailure('17', 'The item cannot be accessed.'), false, 'an ordinary failure is not a limit');
  assert.strictEqual(budget.isLimitFailure(null, null), false);

  console.log('ebay call budget: all good');
})().catch((err) => { console.error(err); process.exit(1); });
