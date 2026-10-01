// Live Listings "Bulk edit" (services/liveBulkEditService.js): reuses bulkEditService.planDraft AS-IS (the real one
// runs here) to work out what changes, then pushes eBay-facing fields (title, brand, quantity, location, policies)
// to eBay with ONE reviseActiveListing call per listing before saving ELMS's own copy; ELMS-only fields (tags, note,
// monitoring) are saved with no eBay call at all. Price is refused here - it has its own page action/endpoint.
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

const revises = []; // { token, args }
let reviseFail = new Set(); // offer ids eBay refuses
let locationCalls = [];
let locationFail = false;
stub('services/ebayListingService', {
  reviseActiveListing: async (token, args) => {
    revises.push({ token, args });
    if (reviseFail.has(args.offerId)) throw new Error('eBay refused this change (error 21916984)');
    return { live: null };
  },
  createOrGetCustomLocation: async (token, country, postal) => {
    locationCalls.push({ token, country, postal });
    if (locationFail) throw new Error('Could not create the eBay location.');
    return 'elms-v2-' + country + '-' + postal;
  },
});

const { bulkLiveEdit } = require('../services/liveBulkEditService');

let rows = {};
let tokens = { A1: 'tok1', A2: null };
const updates = []; // { id, fields }

const live = (n, over = {}) => ({
  id: 'L' + n, title: 'Running Shoes ' + n, description: 'Comfortable shoes.',
  sku: 'B0' + n, status: 'published', ebay_offer_id: 'O' + n, ebay_account_id: 'A1',
  sell_price: 29.99, currency: 'USD', quantity: 3, category_id: '15709',
  ebay_aspects: { Brand: ['Acme'] }, tags: ['sport'], note: '', stock_monitoring: true, price_monitoring: true,
  country_location: null, location_city: null, postal_code: null,
  use_dynamic_policies: false, payment_policy_id: 'PAY1', fulfillment_policy_id: 'SHIP1', return_policy_id: 'RET1',
  ...over,
});
const reset = (count = 3) => {
  rows = {}; for (let i = 1; i <= count; i++) rows['L' + i] = live(i);
  revises.length = 0; reviseFail = new Set(); locationCalls = []; locationFail = false; tokens = { A1: 'tok1', A2: null }; updates.length = 0;
};
const deps = {
  getListingsByIds: async (u, ids) => new Map(ids.filter((id) => rows[id]).map((id) => [id, JSON.parse(JSON.stringify(rows[id]))])),
  updateListing: async (u, id, fields) => { updates.push({ id, fields }); if (rows[id]) Object.assign(rows[id], fields); return rows[id] || null; },
  getImportById: async () => null,
  getRefreshToken: async (u, account) => tokens[account],
};
const run = (ids, changes) => bulkLiveEdit({ userId: 'u1', ids, changes }, deps);

(async () => {
  // ---------- price is refused outright - it has its own page action ----------
  reset(1);
  await assert.rejects(() => run(['L1'], { price: { mode: 'saved' } }), (err) => { assert.strictEqual(err.statusCode, 400); assert.match(err.message, /Change price/); return true; });

  // ---------- brand: one eBay-facing field, one revise call, aspects merged and saved ----------
  reset(1);
  let out = await run(['L1'], { brand: 'Nike' });
  assert.deepStrictEqual(out.summary, { changed: 1, unchanged: 0, skipped: 0 });
  assert.strictEqual(revises.length, 1);
  assert.deepStrictEqual(revises[0].args.aspects, { Brand: ['Nike'] });
  assert.strictEqual(revises[0].args.quantity, 3, 'the listing\'s own current quantity is sent when quantity was not ticked');
  assert.strictEqual(updates.length, 1);
  assert.deepStrictEqual(updates[0].fields.ebayAspects, { Brand: ['Nike'] });

  // ---------- tags/note/monitoring: ELMS-only, no eBay call at all ----------
  reset(1);
  out = await run(['L1'], { tags: { mode: 'add', tags: ['clearance'] }, stockMonitoring: false });
  assert.deepStrictEqual(out.summary, { changed: 1, unchanged: 0, skipped: 0 });
  assert.strictEqual(revises.length, 0, 'nothing here needs eBay');
  assert.deepStrictEqual(updates[0].fields.tags.sort(), ['clearance', 'sport']);
  assert.strictEqual(updates[0].fields.stockMonitoring, false);

  // ---------- nothing actually changes: reported unchanged, no eBay call, no save ----------
  reset(1);
  out = await run(['L1'], { brand: 'Acme' }); // already the brand it has
  assert.deepStrictEqual(out.summary, { changed: 0, unchanged: 1, skipped: 0 });
  assert.strictEqual(revises.length, 0);
  assert.strictEqual(updates.length, 0);

  // ---------- location: creates (or reuses) one eBay location, sent as merchantLocationKey ----------
  reset(2);
  out = await run(['L1', 'L2'], { location: { countryLocation: 'GB', postalCode: 'SW1A1AA' } });
  assert.deepStrictEqual(out.summary, { changed: 2, unchanged: 0, skipped: 0 });
  assert.strictEqual(locationCalls.length, 1, 'the same new location is only created once, then reused');
  assert.ok(revises.every((r) => r.args.merchantLocationKey === 'elms-v2-GB-SW1A1AA'));
  assert.deepStrictEqual(updates.map((u) => u.fields.countryLocation), ['GB', 'GB']);

  // ---------- policies: "account default" sends none; chosen ids are sent and saved ----------
  reset(1);
  out = await run(['L1'], { policies: { useDynamicPolicies: true } });
  assert.strictEqual(revises[0].args.policies, undefined, 'account defaults: nothing explicit is sent, same as the single-listing editor');
  reset(1);
  out = await run(['L1'], { policies: { useDynamicPolicies: false, paymentPolicyId: 'PAY2' } });
  assert.deepStrictEqual(revises[0].args.policies, { paymentPolicyId: 'PAY2', fulfillmentPolicyId: undefined, returnPolicyId: undefined });
  assert.strictEqual(updates[0].fields.paymentPolicyId, 'PAY2');

  // ---------- chosen policies across different stores: refused before anything is touched ----------
  reset(2);
  rows.L2.ebay_account_id = 'A2';
  await assert.rejects(() => run(['L1', 'L2'], { policies: { useDynamicPolicies: false, paymentPolicyId: 'PAY2' } }), (err) => { assert.strictEqual(err.statusCode, 400); assert.match(err.message, /different stores/); return true; });
  assert.strictEqual(revises.length, 0);

  // ---------- which listings are skipped, and why (brand needs eBay, so a missing token matters here - tags/note/
  // monitoring would not even look at the account, since nothing is sent to eBay for those) ----------
  reset(5);
  rows.L1.status = 'draft';
  rows.L2.ebay_offer_id = null;
  rows.L3.ebay_account_id = 'A2'; tokens.A2 = null;
  rows.L4.status = 'sold'; // still live in principle - counts as changeable
  out = await run(['L1', 'L2', 'L3', 'L4', 'NOPE'], { brand: 'Puma' });
  assert.deepStrictEqual(out.results.map((r) => r.status), ['skipped', 'skipped', 'skipped', 'changed', 'skipped']);
  assert.match(out.results[0].reason, /Only a live/);
  assert.match(out.results[1].reason, /no eBay offer/);
  assert.match(out.results[2].reason, /Reconnect/);
  assert.match(out.results[4].reason, /Not found/);

  // ---------- an ELMS-only change never looks at the eBay connection: a disconnected account does not matter here ----------
  reset(1);
  rows.L1.ebay_account_id = 'A2'; tokens.A2 = null;
  out = await run(['L1'], { note: { mode: 'set', text: 'Reorder soon' } });
  assert.deepStrictEqual(out.summary, { changed: 1, unchanged: 0, skipped: 0 });
  assert.strictEqual(revises.length, 0);
  assert.strictEqual(updates[0].fields.note, 'Reorder soon');

  // ---------- eBay refuses the revise: skipped with its own words, ELMS is not touched ----------
  reset(1);
  reviseFail = new Set(['O1']);
  out = await run(['L1'], { brand: 'Puma' });
  assert.deepStrictEqual(out.results[0].status, 'skipped');
  assert.match(out.results[0].reason, /refused this change/);
  assert.strictEqual(updates.length, 0);

  // ---------- eBay refuses creating the location: skipped before any revise is attempted ----------
  reset(1);
  locationFail = true;
  out = await run(['L1'], { location: { countryLocation: 'GB', postalCode: 'SW1A1AA' } });
  assert.deepStrictEqual(out.results[0].status, 'skipped');
  assert.match(out.results[0].reason, /Could not create the eBay location/);
  assert.strictEqual(revises.length, 0);

  // ---------- the route: price is refused, at most 20 ids, the same id twice is one listing ----------
  reset(2);
  const Module = require('module');
  const noop = async () => null;
  const fakes = {
    '../models/listingsModel': { listListings: noop, getListingById: noop, getListingsByIds: deps.getListingsByIds, updateListing: deps.updateListing, updateListingStats: noop, updateListingSettings: noop, restockListing: noop },
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
  const h = (() => { const l = router.stack.find((x) => x.route && x.route.path === '/bulk-live-edit' && x.route.methods.post); return l.route.stack[l.route.stack.length - 1].handle; })();
  const call = async (body) => { const res = { statusCode: 200 }; res.status = (c) => { res.statusCode = c; return res; }; res.json = (b) => { res.body = b; return res; }; await h({ userId: 'u1', body }, res); return res; };

  let res = await call({ ids: [], changes: { brand: 'Puma' } });
  assert.strictEqual(res.statusCode, 400);
  res = await call({ ids: Array.from({ length: 21 }, (_, i) => 'X' + i), changes: { brand: 'Puma' } });
  assert.strictEqual(res.statusCode, 400); assert.match(res.body.error, /at most 20/);
  res = await call({ ids: ['L1'], changes: { price: { mode: 'saved' } } });
  assert.strictEqual(res.statusCode, 400); assert.match(res.body.error, /Change price/);
  res = await call({ ids: ['L1', 'L1', 'L2'], changes: { brand: 'Puma' } });
  assert.deepStrictEqual([res.statusCode, res.body.success, res.body.results.length, res.body.summary.changed], [200, true, 2, 2], 'the same id twice is one listing');

  console.log('live bulk edit service tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
