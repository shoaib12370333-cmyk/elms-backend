// Live listings -> Change price: the price of many LIVE listings is worked out by the pricing rule and put on eBay 25 per call (several calls at
// once); anything unusual in eBay's answer sends that listing the ordinary way; ELMS keeps a copy only of what eBay took. The real service and route
// run here; the database, the exchange rates and eBay are stand-ins.
const assert = require('assert');
const path = require('path');
const Module = require('module');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

stub('services/currencyService', { convertAmount: async (a, from, to) => { if (from === to) return { amount: a, rate: 1 }; if (from === 'USD' && to === 'GBP') return { amount: Number((a * 0.8).toFixed(2)), rate: 0.8 }; throw new Error('No exchange rate for ' + from + ' to ' + to + '.'); } });
let saved = null;
stub('models/usersModel', { getPricingRule: async () => saved, hasCredits: async () => true, spendCredit: async () => true, refundCredit: async () => {} });

const S = require('../services/liveBulkPriceService');
const { validateChanges } = require('../services/bulkEditService');
const P = require('../services/pricingService');

const RULE = { enabled: true, currency: 'GBP', feePercent: 13, feeFixed: 0.3, profitPercent: 30, profitFixed: 0, minProfit: 0, shipping: 0, centsEnding: null, tiers: [] };
const priceOf = (cost) => P.computePrice(cost, RULE).price;

let rows = {};
const writes = [];
const calls = [];
const singles = [];
let bulkFail = null; // a path fragment that throws
let refuse = new Set(); // offer ids eBay refuses in the bulk answer
let dropOffer = new Set(); // offer ids missing from the answer
let singleFail = new Set(); // offer ids the ordinary path refuses
let tokens = { A1: 'tok1', A2: 'tok2', A3: null };
const COLUMN = { sellPrice: 'sell_price', markupPercent: 'markup_percent', marginAmount: 'margin_amount', pricingRule: 'pricing_rule', amazonPrice: 'amazon_price', lastRepricedAt: 'last_repriced_at', markDraftCustomized: 'mark_draft_customized' };

S.deps.request = async (token, method, p, body, options) => {
  calls.push({ token, method, path: p, n: body.requests.length, options, body });
  if (bulkFail && p.includes(bulkFail)) throw Object.assign(new Error('eBay is down'), { statusCode: 503 });
  await new Promise((r) => setTimeout(r, 5));
  return { responses: body.requests.map((r) => ({ sku: r.sku, offers: r.offers.filter((o) => !dropOffer.has(o.offerId)).map((o) => (refuse.has(o.offerId) ? { offerId: o.offerId, statusCode: 400, errors: [{ message: 'Offer is not published' }] } : { offerId: o.offerId, statusCode: 200 })) })) };
};
S.deps.single = async (token, offerId, price) => { singles.push({ token, offerId, price }); if (singleFail.has(offerId)) throw new Error('Offer is not published (eBay error 25001)'); return { offerId }; };

const live = (n, over = {}) => ({ id: 'L' + n, title: 'Kettle ' + n, sku: 'B0' + n, status: 'published', ebay_offer_id: 'O' + n, ebay_account_id: 'A1', marketplace_id: 'EBAY_GB', currency: 'GBP', amazon_url: 'https://www.amazon.co.uk/dp/B0' + n, amazon_price: 10, sell_price: 10, pricing_rule: null, import_id: null, ...over });
const reset = (count = 3) => {
  rows = {}; for (let i = 1; i <= count; i++) rows['L' + i] = live(i);
  writes.length = 0; calls.length = 0; singles.length = 0; bulkFail = null; refuse = new Set(); dropOffer = new Set(); singleFail = new Set(); tokens = { A1: 'tok1', A2: 'tok2', A3: null }; saved = null;
};
const deps = {
  getListingsByIds: async (u, ids) => new Map(ids.filter((id) => rows[id]).map((id) => [id, JSON.parse(JSON.stringify(rows[id]))])),
  updateListing: async (u, id, fields) => { writes.push({ id, fields }); for (const [k, v] of Object.entries(fields)) { assert.ok(COLUMN[k], 'a field the model knows: ' + k); rows[id][COLUMN[k]] = v; } },
  getImportById: async () => null,
  getRefreshToken: async (u, account) => tokens[account],
};
const changesOf = (raw) => validateChanges({ price: raw }, { userId: 'u1', getSavedRule: async () => saved });
const run = async (ids, raw = { mode: 'custom', rule: RULE }) => S.bulkLivePrice({ userId: 'u1', ids, changes: await changesOf(raw) }, deps);
const bulkCalls = () => calls.filter((c) => c.path.endsWith('/bulk_update_price_quantity'));

(async () => {
  // ---------- one call for a few listings; the price is the rule's; ELMS keeps a copy with the rule ----------
  reset(3);
  let out = await run(['L1', 'L2', 'L3']);
  assert.deepStrictEqual(out.summary, { changed: 3, unchanged: 0, skipped: 0 });
  assert.strictEqual(bulkCalls().length, 1); assert.strictEqual(bulkCalls()[0].n, 3); assert.strictEqual(singles.length, 0);
  const c0 = bulkCalls()[0];
  assert.strictEqual(c0.token, 'tok1'); assert.strictEqual(c0.options.marketplaceId, 'EBAY_GB'); assert.strictEqual(c0.method, 'POST');
  assert.deepStrictEqual(c0.body.requests[0], { sku: 'B01', offers: [{ offerId: 'O1', price: { value: priceOf(10).toFixed(2), currency: 'GBP' } }] });
  assert.strictEqual(rows.L1.sell_price, priceOf(10)); assert.ok(rows.L1.pricing_rule && rows.L1.pricing_rule.profitPercent === 30, 'the rule stays with the listing');
  assert.ok(out.results.every((r) => r.status === 'changed' && r.diff[0].field === 'Price' && r.diff[0].to === priceOf(10)));
  // the same again changes nothing and calls nothing
  calls.length = 0; writes.length = 0;
  out = await run(['L1', 'L2', 'L3']);
  assert.deepStrictEqual(out.summary, { changed: 0, unchanged: 3, skipped: 0 }); assert.strictEqual(calls.length, 0); assert.strictEqual(writes.length, 0);

  // ---------- 60 listings: 25 + 25 + 10, three calls, in the order asked ----------
  reset(60);
  out = await run(Object.keys(rows).map((k) => k));
  assert.strictEqual(out.summary.changed, 60);
  assert.deepStrictEqual(bulkCalls().map((c) => c.n).sort((a, b) => b - a), [25, 25, 10]);
  assert.deepStrictEqual(out.results.map((r) => r.id), Object.keys(rows));

  // ---------- two stores are never mixed in one call; a store with no connection is skipped with the reason ----------
  reset(4); rows.L2.ebay_account_id = 'A2'; rows.L3.ebay_account_id = 'A3';
  out = await run(['L1', 'L2', 'L3', 'L4']);
  assert.deepStrictEqual(out.results.map((r) => r.status), ['changed', 'changed', 'skipped', 'changed']);
  assert.match(out.results[2].reason, /Reconnect/);
  assert.deepStrictEqual(bulkCalls().map((c) => c.token + ':' + c.n).sort(), ['tok1:2', 'tok2:1']);
  assert.strictEqual(rows.L3.sell_price, 10, 'a skipped listing is not touched');

  // ---------- which listings are changed ----------
  reset(6); rows.L1.status = 'draft'; rows.L2.ebay_offer_id = null; rows.L3.amazon_price = null; rows.L4.status = 'ended';
  out = await run(['L1', 'L2', 'L3', 'L4', 'L5', 'NOPE']);
  assert.deepStrictEqual(out.results.map((r) => r.status), ['skipped', 'skipped', 'skipped', 'skipped', 'changed', 'skipped']);
  assert.match(out.results[0].reason, /Only live listings/); assert.match(out.results[1].reason, /no eBay offer/); assert.match(out.results[2].reason, /No Amazon price/); assert.match(out.results[5].reason, /Not found/);
  assert.strictEqual(bulkCalls()[0].n, 1);

  // ---------- eBay refuses one offer: it goes the ordinary way, which gives eBay's words; the others are done ----------
  reset(3); refuse = new Set(['O2']); singleFail = new Set(['O2']);
  out = await run(['L1', 'L2', 'L3']);
  assert.deepStrictEqual(out.results.map((r) => r.status), ['changed', 'skipped', 'changed']);
  assert.match(out.results[1].reason, /eBay did not take the new price: Offer is not published/);
  assert.strictEqual(rows.L2.sell_price, 10, 'ELMS keeps the old price for a price eBay did not take');
  assert.deepStrictEqual(singles.map((x) => x.offerId), ['O2']);
  // refused in bulk, but the ordinary path accepts it
  reset(2); refuse = new Set(['O1']);
  out = await run(['L1', 'L2']);
  assert.deepStrictEqual(out.summary, { changed: 2, unchanged: 0, skipped: 0 }); assert.deepStrictEqual(singles.map((x) => x.offerId), ['O1']); assert.strictEqual(singles[0].price, priceOf(10));
  // missing from the answer -> ordinary path
  reset(2); dropOffer = new Set(['O2']);
  out = await run(['L1', 'L2']);
  assert.strictEqual(out.summary.changed, 2); assert.deepStrictEqual(singles.map((x) => x.offerId), ['O2']);

  // ---------- the whole bulk call fails: every listing goes the ordinary way, none is lost ----------
  reset(3); bulkFail = '/bulk_update_price_quantity';
  out = await run(['L1', 'L2', 'L3']);
  assert.strictEqual(out.summary.changed, 3); assert.deepStrictEqual(singles.map((x) => x.offerId).sort(), ['O1', 'O2', 'O3']);

  // ---------- currency: an Amazon US price in a UK store is converted; without a rate the listing is skipped ----------
  reset(2); rows.L1.currency = 'USD'; rows.L1.amazon_url = 'https://www.amazon.com/dp/B01'; rows.L2.currency = 'AUD'; rows.L2.amazon_url = 'https://www.amazon.com.au/dp/B02';
  out = await run(['L1', 'L2'], { mode: 'custom', rule: { ...RULE, currency: 'USD' } });
  assert.deepStrictEqual(out.results.map((r) => r.status), ['changed', 'skipped']);
  assert.match(out.results[1].reason, /exchange rate/);
  const usd = P.computePrice(10, { ...RULE, currency: 'USD' }).price;
  assert.strictEqual(rows.L1.sell_price, usd, 'ELMS keeps the price in the listing currency');
  assert.strictEqual(bulkCalls()[0].body.requests[0].offers[0].price.value, (usd * 0.8).toFixed(2), 'eBay gets the store currency');

  // ---------- the saved rule ----------
  reset(2); saved = { ...RULE, profitPercent: 50 };
  out = await run(['L1', 'L2'], { mode: 'saved' });
  assert.strictEqual(rows.L1.sell_price, P.computePrice(10, { ...RULE, profitPercent: 50 }).price);

  // ---------- the route: only the price is ever changed, at most 500, nothing saved on a bad request ----------
  reset(3);
  const noop = async () => null;
  const fakes = {
    '../models/listingsModel': { listListings: noop, getListingById: noop, getListingsByIds: deps.getListingsByIds, updateListing: deps.updateListing, updateListingStats: noop, updateListingSettings: noop },
    '../services/ebayStatsService': { fetchItemTraffic: noop },
    '../services/listingStatsService': { syncStatsForAccount: noop },
    '../services/ebayListingService': { reviseActiveListing: noop, fetchLiveListing: noop, createOrGetCustomLocation: noop, publishListing: noop, publishExistingOffer: noop, deleteOffer: noop, withdrawListing: noop },
    '../services/publishQueueService': { processOneQueuedListing: noop },
    '../models/ebayAccountsModel': { listEbayAccounts: noop, getEbayAccountById: noop, getEbayAccountRefreshToken: async (u, a) => tokens[a] },
    '../models/importsModel': { getImportById: deps.getImportById },
    '../services/publishPreflightService': { checkAspects: noop },
    '../middleware/requireAuth': { requireAuth: (req, res, next) => next() },
    '../services/publishRunner': { enqueuePublish: noop },
    '../models/usersModel': { hasCredits: noop, spendCredit: noop, refundCredit: noop, getPricingRule: async () => saved },
  };
  const orig = Module._load;
  Module._load = function (request, parent) { if (fakes[request] && parent && /routes[\\/]listings\.js$/.test(parent.filename)) return fakes[request]; return orig.apply(this, arguments); };
  const router = require('../routes/listings');
  Module._load = orig;
  const h = (() => { const l = router.stack.find((x) => x.route && x.route.path === '/bulk-live-price' && x.route.methods.post); return l.route.stack[l.route.stack.length - 1].handle; })();
  const call = async (body) => { const res = { statusCode: 200 }; res.status = (c) => { res.statusCode = c; return res; }; res.json = (b) => { res.body = b; return res; }; await h({ userId: 'u1', body }, res); return res; };
  let res = await call({ ids: [], changes: { price: { mode: 'saved' } } });
  assert.strictEqual(res.statusCode, 400);
  res = await call({ ids: Array.from({ length: 501 }, (_, i) => 'X' + i), changes: { price: { mode: 'saved' } } });
  assert.strictEqual(res.statusCode, 400); assert.match(res.body.error, /at most 500/);
  res = await call({ ids: ['L1'], changes: { quantity: 9 } });
  assert.strictEqual(res.statusCode, 400); assert.match(res.body.error, /at least one thing/); assert.strictEqual(writes.length, 0, 'another field is never changed here');
  res = await call({ ids: ['L1'], changes: { price: { mode: 'saved' } } });
  assert.strictEqual(res.statusCode, 400); assert.match(res.body.error, /no saved pricing rule/);
  res = await call({ ids: ['L1', 'L1', 'L2'], changes: { price: { mode: 'custom', rule: RULE }, title: { op: 'case', case: 'upper' } } });
  assert.deepStrictEqual([res.statusCode, res.body.success, res.body.results.length, res.body.summary.changed], [200, true, 2, 2], 'the same id twice is one listing');
  assert.strictEqual(rows.L1.title, 'Kettle 1', 'the title in the request is ignored');

  console.log('live bulk price: all good');
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
