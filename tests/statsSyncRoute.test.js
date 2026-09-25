// POST /api/listings/stats/sync (opening the Live listings page, the "Sync" button): one bulk read per store, at most every 2 minutes,
// and the answer keeps the shape the page already reads. The real route handler runs; the eBay read and the database are stubs.
const assert = require('assert');
const Module = require('module');

const noop = async () => null;
const syncCalls = [];
let syncImpl;
let liveRows = [];
let accounts = [];
const fakes = {
  '../models/listingsModel': { listListings: async (userId, status, accountId) => liveRows.filter((l) => !accountId || l.ebay_account_id === accountId), getListingById: noop, updateListing: noop, updateListingStats: noop },
  '../services/ebayStatsService': { fetchItemTraffic: noop },
  '../services/listingStatsService': { syncStatsForAccount: async (userId, accountId, opts) => { syncCalls.push({ userId, accountId, opts }); return syncImpl(accountId); } },
  '../services/ebayListingService': { reviseActiveListing: noop, fetchLiveListing: noop, createOrGetCustomLocation: noop, publishListing: noop, publishExistingOffer: noop, deleteOffer: noop, withdrawListing: noop },
  '../services/publishQueueService': { processOneQueuedListing: noop },
  '../models/ebayAccountsModel': { listEbayAccounts: async () => accounts, getEbayAccountById: noop, getEbayAccountRefreshToken: async () => 'rt' },
  '../models/importsModel': { getImportById: noop },
  '../services/publishPreflightService': { checkAspects: noop },
  '../middleware/requireAuth': { requireAuth: (req, res, next) => next() },
  '../services/publishRunner': { enqueuePublish: noop },
  '../models/usersModel': { hasCredits: noop, spendCredit: noop, refundCredit: noop },
};
const origLoad = Module._load;
Module._load = function (request, parent) {
  if (fakes[request] && parent && /routes[\\/]listings\.js$/.test(parent.filename)) return fakes[request];
  return origLoad.apply(this, arguments);
};
const router = require('../routes/listings');
Module._load = origLoad;

const handler = (() => {
  const layer = router.stack.find((l) => l.route && l.route.path === '/stats/sync' && l.route.methods.post);
  return layer.route.stack[layer.route.stack.length - 1].handle;
})();
const call = async (body) => {
  const out = {};
  const res = { status(c) { out.status = c; return this; }, json(b) { out.body = b; if (!out.status) out.status = 200; return this; } };
  await handler({ userId: 'u1', params: {}, body: body || {}, query: {} }, res);
  return out;
};
const live = (id, account, over = {}) => ({ id, ebay_listing_id: '10' + id, ebay_account_id: account, views: 5, watchers: 1, stats_synced_at: '2026-09-26T10:00:00.000Z', ...over });
const reset = () => { syncCalls.length = 0; syncImpl = async () => ({ synced: 0, failed: 0, error: null, calls: 1, fresh: false, limited: false }); liveRows = []; accounts = []; };

(async () => {
  // ---------- the page asks for the store it shows ----------
  reset();
  liveRows = [live('1', 'A1'), live('2', 'A1'), live('3', 'A2')];
  syncImpl = async () => ({ synced: 2, failed: 0, error: null, calls: 1, fresh: false, limited: false });
  let out = await call({ accountId: 'A1' });
  assert.strictEqual(out.status, 200); assert.strictEqual(out.body.success, true);
  assert.deepStrictEqual(syncCalls.map((c) => c.accountId), ['A1'], 'one store, one bulk read');
  assert.strictEqual(syncCalls[0].opts.minAgeMs, 120000, 'a store refreshed in the last 2 minutes is not asked from eBay again');
  assert.strictEqual(syncCalls[0].opts.viewsFallback, 10);
  assert.deepStrictEqual(out.body.listings.map((l) => l.id), ['1', '2'], 'only that store\'s listings come back');
  assert.deepStrictEqual(Object.keys(out.body.listings[0]).sort(), ['id', 'stats_synced_at', 'views', 'watchers'], 'the shape the page reads');
  assert.deepStrictEqual([out.body.synced, out.body.failed, out.body.error], [2, 0, null]);
  assert.ok(out.body.syncedAt);

  // ---------- no store chosen: every store of the seller, one read each ----------
  reset();
  accounts = [{ id: 'A1' }, { _id: 'A2' }, { id: 'A3' }];
  liveRows = [live('1', 'A1'), live('3', 'A2')];
  syncImpl = async () => ({ synced: 1, failed: 0, error: null, calls: 1, fresh: false, limited: false });
  out = await call({});
  assert.deepStrictEqual(syncCalls.map((c) => c.accountId), ['A1', 'A2', 'A3']);
  assert.strictEqual(out.body.synced, 3);
  assert.strictEqual(out.body.listings.length, 2);

  // ---------- a store that was refreshed a moment ago counts as synced without asking eBay ----------
  reset();
  liveRows = [live('1', 'A1'), live('2', 'A1'), live('3', 'A1')];
  syncImpl = async () => ({ synced: 0, failed: 0, error: null, calls: 0, fresh: true, limited: false });
  out = await call({ accountId: 'A1' });
  assert.deepStrictEqual([out.body.synced, out.body.failed, out.body.listings.length], [3, 0, 3]);

  // ---------- the day's eBay allowance is used up: the last numbers stay, the page is told ----------
  reset();
  liveRows = [live('1', 'A1'), live('2', 'A1')];
  syncImpl = async () => ({ synced: 0, failed: 2, error: null, calls: 0, fresh: false, limited: true });
  out = await call({ accountId: 'A1' });
  assert.strictEqual(out.status, 200);
  assert.match(out.body.error, /daily call allowance/);
  assert.deepStrictEqual([out.body.synced, out.body.failed, out.body.listings.length], [0, 2, 2], 'the old numbers are still shown');

  // ---------- eBay trouble and a disconnected store ----------
  reset();
  liveRows = [live('1', 'A1')];
  syncImpl = async () => ({ synced: 0, failed: 1, error: 'Could not reach eBay to read listing traffic.', calls: 1, fresh: false, limited: false });
  out = await call({ accountId: 'A1' });
  assert.strictEqual(out.body.error, 'Could not reach eBay to read listing traffic.');
  syncImpl = async () => ({ synced: 0, failed: 1, error: 'account_disconnected', calls: 0, fresh: false, limited: false });
  out = await call({ accountId: 'A1' });
  assert.strictEqual(out.body.error, null, 'an internal reason is not shown to the seller');
  syncImpl = async () => { throw new Error('database down'); };
  out = await call({ accountId: 'A1' });
  assert.deepStrictEqual([out.status, out.body.error, out.body.failed], [200, 'database down', 1], 'one store failing does not break the answer');

  // ---------- a huge store: the answer is capped, the rest is reported as skipped ----------
  reset();
  liveRows = Array.from({ length: 1200 }, (_, i) => live(String(i), 'A1'));
  out = await call({ accountId: 'A1' });
  assert.deepStrictEqual([out.body.listings.length, out.body.skipped], [1000, 200]);

  console.log('stats sync route: all good');
})().catch((err) => { console.error(err); process.exit(1); });
