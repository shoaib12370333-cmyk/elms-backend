// Live listings -> Sold tab -> "Restock": puts a fresh available quantity on eBay for every selected sold-out
// listing, then moves each one back to "Active" in ELMS with soldQuantity reset to 0. The real service and route run
// here; eBay and the database are stand-ins.
const assert = require('assert');
const path = require('path');
const Module = require('module');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

const S = require('../services/liveBulkRestockService');

let rows = {};
const restocked = []; // { id, quantity }
const singles = [];
let singleFail = new Set(); // offer ids eBay refuses
let tokens = { A1: 'tok1', A2: null };

S.deps.single = async (token, offerId, quantity) => { singles.push({ token, offerId, quantity }); if (singleFail.has(offerId)) throw new Error('Replace quantity is invalid (eBay error 25002)'); return { offerId, quantity }; };

const sold = (n, over = {}) => ({ id: 'L' + n, title: 'Kettle ' + n, sku: 'B0' + n, status: 'sold', ebay_offer_id: 'O' + n, ebay_account_id: 'A1', ...over });
const reset = (count = 3) => {
  rows = {}; for (let i = 1; i <= count; i++) rows['L' + i] = sold(i);
  restocked.length = 0; singles.length = 0; singleFail = new Set(); tokens = { A1: 'tok1', A2: null };
};
const deps = {
  getListingsByIds: async (u, ids) => new Map(ids.filter((id) => rows[id]).map((id) => [id, JSON.parse(JSON.stringify(rows[id]))])),
  restockListing: async (u, id, quantity) => { restocked.push({ id, quantity }); if (rows[id]) { rows[id].status = 'published'; rows[id].quantity = quantity; rows[id].sold_quantity = 0; } return rows[id] || null; },
  getRefreshToken: async (u, account) => tokens[account],
};
const run = async (ids, quantity = 2) => S.bulkRestock({ userId: 'u1', ids, quantity }, deps);

(async () => {
  // ---------- a few sold-out listings restocked at once ----------
  reset(3);
  let out = await run(['L1', 'L2', 'L3'], 5);
  assert.deepStrictEqual(out.summary, { changed: 3, skipped: 0 });
  assert.deepStrictEqual(singles.map((s) => s.offerId).sort(), ['O1', 'O2', 'O3']);
  assert.ok(singles.every((s) => s.quantity === 5 && s.token === 'tok1'));
  assert.strictEqual(restocked.length, 3);
  assert.ok(out.results.every((r) => r.status === 'changed'));
  assert.strictEqual(rows.L1.status, 'published'); assert.strictEqual(rows.L1.quantity, 5); assert.strictEqual(rows.L1.sold_quantity, 0);

  // ---------- which listings are skipped, and why ----------
  reset(4);
  rows.L1.status = 'published'; // already restocked / never was sold
  rows.L2.ebay_offer_id = null;
  rows.L3.ebay_account_id = 'A2'; tokens.A2 = null; // connected store missing its token
  out = await run(['L1', 'L2', 'L3', 'L4', 'NOPE'], 3);
  assert.deepStrictEqual(out.results.map((r) => r.status), ['skipped', 'skipped', 'skipped', 'changed', 'skipped']);
  assert.match(out.results[0].reason, /Only a sold-out listing/);
  assert.match(out.results[1].reason, /no eBay offer/);
  assert.match(out.results[2].reason, /Reconnect/);
  assert.match(out.results[4].reason, /Not found/);
  assert.strictEqual(restocked.length, 1, 'only the one that really changed is saved');

  // ---------- eBay refuses one offer: it is skipped with eBay's words, the others still go through ----------
  reset(3); singleFail = new Set(['O2']);
  out = await run(['L1', 'L2', 'L3'], 4);
  assert.deepStrictEqual(out.results.map((r) => r.status), ['changed', 'skipped', 'changed']);
  assert.match(out.results[1].reason, /Replace quantity is invalid/);
  assert.strictEqual(rows.L2.status, 'sold', 'ELMS is not touched when eBay refused the new quantity');

  // ---------- a bad quantity is refused before anything is touched ----------
  reset(2);
  for (const bad of [0, -1, 1.5, 'abc', undefined, null]) {
    await assert.rejects(() => S.bulkRestock({ userId: 'u1', ids: ['L1'], quantity: bad }, deps), (err) => { assert.strictEqual(err.statusCode, 400); return true; }, 'quantity ' + bad + ' should be refused');
  }
  assert.strictEqual(singles.length, 0, 'eBay is never called for an invalid quantity');

  // ---------- the route: at most 20 ids (each is up to ~6 real eBay round trips now - see MAX_RESTOCK_BATCH), a bad quantity refused with the same message, one id twice is one listing ----------
  reset(2);
  const noop = async () => null;
  const fakes = {
    '../models/listingsModel': { listListings: noop, getListingById: noop, getListingsByIds: deps.getListingsByIds, updateListing: noop, updateListingStats: noop, updateListingSettings: noop, restockListing: deps.restockListing },
    '../services/ebayStatsService': { fetchItemTraffic: noop },
    '../services/listingStatsService': { syncStatsForAccount: noop },
    '../services/ebayListingService': { reviseActiveListing: noop, fetchLiveListing: noop, createOrGetCustomLocation: noop, publishListing: noop, publishExistingOffer: noop, deleteOffer: noop, withdrawListing: noop },
    '../services/publishQueueService': { processOneQueuedListing: noop },
    '../models/ebayAccountsModel': { listEbayAccounts: noop, getEbayAccountById: noop, getEbayAccountRefreshToken: async (u, a) => tokens[a] },
    '../models/importsModel': { getImportById: noop },
    '../services/publishPreflightService': { checkAspects: noop },
    '../middleware/requireAuth': { requireAuth: (req, res, next) => next() },
    '../services/publishRunner': { enqueuePublish: noop },
    '../models/usersModel': { hasCredits: noop, spendCredit: noop, refundCredit: noop, getPricingRule: async () => null },
  };
  const orig = Module._load;
  Module._load = function (request, parent) { if (fakes[request] && parent && /routes[\\/]listings\.js$/.test(parent.filename)) return fakes[request]; return orig.apply(this, arguments); };
  const router = require('../routes/listings');
  Module._load = orig;
  const h = (() => { const l = router.stack.find((x) => x.route && x.route.path === '/bulk-restock' && x.route.methods.post); return l.route.stack[l.route.stack.length - 1].handle; })();
  const call = async (body) => { const res = { statusCode: 200 }; res.status = (c) => { res.statusCode = c; return res; }; res.json = (b) => { res.body = b; return res; }; await h({ userId: 'u1', body }, res); return res; };

  let res = await call({ ids: [], quantity: 3 });
  assert.strictEqual(res.statusCode, 400);
  res = await call({ ids: Array.from({ length: 21 }, (_, i) => 'X' + i), quantity: 3 });
  assert.strictEqual(res.statusCode, 400); assert.match(res.body.error, /at most 20/);
  res = await call({ ids: ['L1'], quantity: 0 });
  assert.strictEqual(res.statusCode, 400); assert.match(res.body.error, /at least 1/);
  res = await call({ ids: ['L1', 'L1', 'L2'], quantity: 6 });
  assert.deepStrictEqual([res.statusCode, res.body.success, res.body.results.length, res.body.summary.changed], [200, true, 2, 2], 'the same id twice is one listing');

  console.log('live bulk restock: all good');
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
