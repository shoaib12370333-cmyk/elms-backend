// POST /api/listings/:id/revise and GET /api/listings/:id/live: what goes to eBay, what ELMS keeps afterwards, and what is reported
// when eBay does not take a change. The real route handlers run; the eBay calls and the database are stubs.
const assert = require('assert');
const Module = require('module');
const clone = (o) => JSON.parse(JSON.stringify(o));

const saved = [];
const revises = [];
const locations = [];
let reviseImpl;
let liveImpl;
let listing;
let droppedByCheck = [];

const noop = async () => null;
const fakes = {
  '../models/listingsModel': { getListingById: async () => (listing ? clone(listing) : null), updateListing: async (userId, id, fields) => { saved.push(fields); return { id, ...fields }; } },
  '../services/ebayStatsService': { fetchItemTraffic: noop },
  '../services/ebayListingService': {
    reviseActiveListing: async (token, args) => { revises.push(args); return reviseImpl(args); },
    fetchLiveListing: async (token, args) => liveImpl(args),
    createOrGetCustomLocation: async (token, country, postal) => { locations.push([country, postal]); return 'loc-' + country + '-' + postal.replace(/\s/g, ''); },
    publishListing: noop, publishExistingOffer: noop, deleteOffer: noop, withdrawListing: noop,
  },
  '../services/publishQueueService': { processOneQueuedListing: noop },
  '../models/ebayAccountsModel': { listEbayAccounts: noop, getEbayAccountById: async () => ({ paymentPolicyId: 'DP', fulfillmentPolicyId: 'DF', returnPolicyId: 'DR' }), getEbayAccountRefreshToken: async () => 'rt' },
  '../models/importsModel': { getImportById: async () => ({ amazon_url: 'https://www.amazon.co.uk/dp/B0UKPRODUC' }) },
  '../services/publishPreflightService': {
    checkAspects: async ({ product }) => {
      const out = {};
      for (const [k, v] of Object.entries(product.ebayAspects)) if (!droppedByCheck.includes(k)) out[k] = [].concat(v);
      return { aspects: out, notes: droppedByCheck.map((n) => 'dropped "' + n + '"'), missing: [] };
    },
  },
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

const handlerOf = (method, path) => {
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  return layer.route.stack[layer.route.stack.length - 1].handle;
};
const call = async (handler, params, body) => {
  const out = {};
  const res = { status(c) { out.status = c; return this; }, json(b) { out.body = b; if (!out.status) out.status = 200; return this; } };
  await handler({ userId: 'u1', params, body: body || {}, query: {} }, res);
  return out;
};
const revise = handlerOf('post', '/:id/revise');
const liveGet = handlerOf('get', '/:id/live');

const baseListing = () => ({ id: 'L1', ebay_offer_id: 'O1', ebay_account_id: 'A1', sku: 'S1', sell_price: 19.99, amazon_price: 8, currency: 'GBP', quantity: 3, category_id: '15052', title: 'Old title', import_id: 'I1', ebay_aspects: { Brand: ['Nike'] }, marketplace_id: 'EBAY_GB' });
const liveOf = (over = {}) => ({ title: 'New title', description: '<p>x</p>', imageUrls: ['https://i/a.jpg'], aspects: { Brand: ['Adidas'], Color: ['Black'] }, price: 12, currency: 'GBP', quantity: 2, categoryId: '15052',
  policies: { paymentPolicyId: 'P2', fulfillmentPolicyId: 'F1', returnPolicyId: 'R1' }, merchantLocationKey: 'LOC1', epid: null, ...over });
const reset = () => { saved.length = 0; revises.length = 0; locations.length = 0; listing = baseListing(); droppedByCheck = []; reviseImpl = async (a) => ({ offerId: a.offerId, sku: a.sku, sellPrice: Number(a.sellPrice), pushedPrice: Number(a.sellPrice), quantity: Number(a.quantity), categoryId: a.categoryId, imageCount: (a.images || []).length, sentAspects: null, live: liveOf() }); };

(async () => {
  // ---------- 1. everything is taken: eBay gets it, ELMS keeps it, nothing is reported ----------
  reset();
  let out = await call(revise, { id: 'L1' }, { title: 'New title', sellPrice: 12, quantity: 2, aspects: { Brand: ['Adidas'] }, description: '<p>x</p>', images: ['https://i/a.jpg', 'https://i/a.jpg', 'ftp://no'], paymentPolicyId: 'P2', categoryId: '15052' });
  assert.strictEqual(out.status, 200); assert.strictEqual(out.body.success, true); assert.strictEqual(out.body.verified, true);
  assert.deepStrictEqual(out.body.notApplied, []);
  const sent = revises[0];
  assert.strictEqual(sent.offerId, 'O1'); assert.strictEqual(sent.sku, 'S1');
  assert.strictEqual(sent.description, '<p>x</p>'); assert.deepStrictEqual(sent.images, ['https://i/a.jpg']);
  assert.deepStrictEqual(sent.aspects, { Brand: ['Adidas'] });
  assert.strictEqual(sent.priceCurrency, 'GBP', "the price is in the Amazon site's currency (amazon.co.uk)");
  assert.deepStrictEqual(sent.policies, { paymentPolicyId: 'P2', fulfillmentPolicyId: undefined, returnPolicyId: undefined });
  assert.strictEqual(sent.title, 'New title');
  const s1 = saved[0];
  assert.strictEqual(s1.title, 'New title'); assert.strictEqual(s1.sellPrice, 12); assert.strictEqual(s1.marginAmount, 4, 'the margin follows the new price, so the stock monitor does not put the old price back');
  assert.strictEqual(s1.quantity, 2); assert.deepStrictEqual(s1.ebayAspects, { Brand: ['Adidas'], Color: ['Black'] }, "ELMS keeps eBay's item specifics");
  assert.strictEqual(s1.description, '<p>x</p>'); assert.deepStrictEqual(s1.images, ['https://i/a.jpg']);
  assert.strictEqual(s1.paymentPolicyId, 'P2'); assert.strictEqual(s1.markDraftCustomized, false);

  // ---------- 2. eBay keeps its own Brand and its own policy: it is reported and ELMS keeps eBay's value ----------
  reset();
  reviseImpl = async (a) => ({ offerId: 'O1', sku: 'S1', sellPrice: 12, pushedPrice: 12, quantity: 2, categoryId: '15052', imageCount: 0, sentAspects: null, live: liveOf({ aspects: { Brand: ['Nike'] }, epid: '99', policies: { paymentPolicyId: 'P1', fulfillmentPolicyId: 'F1', returnPolicyId: 'R1' } }) });
  out = await call(revise, { id: 'L1' }, { title: 'New title', sellPrice: 12, quantity: 2, aspects: { Brand: ['Adidas'] }, paymentPolicyId: 'P2' });
  assert.strictEqual(out.body.success, true);
  const fieldsNotTaken = out.body.notApplied.map((n) => n.field).sort();
  assert.deepStrictEqual(fieldsNotTaken, ['aspect:Brand', 'policy:paymentPolicyId']);
  const b = out.body.notApplied.find((n) => n.field === 'aspect:Brand');
  assert.strictEqual(b.sent, 'Adidas'); assert.strictEqual(b.ebay, 'Nike'); assert.ok(/catalog/.test(b.reason));
  assert.deepStrictEqual(saved[0].ebayAspects, { Brand: ['Nike'] }, 'ELMS shows what eBay holds, so a refresh shows the truth');
  assert.ok(!('paymentPolicyId' in saved[0]), 'a policy eBay did not take is not remembered as chosen');

  // ---------- 3. a value that is not one of eBay's allowed values is named ----------
  reset(); droppedByCheck = ['Color'];
  out = await call(revise, { id: 'L1' }, { title: 'New title', sellPrice: 12, quantity: 2, aspects: { Brand: ['Adidas'], Color: ['Sparkly'] } });
  assert.deepStrictEqual(revises[0].aspects, { Brand: ['Adidas'] });
  const dropped = out.body.notApplied.find((n) => n.field === 'aspect:Color');
  assert.ok(dropped && /allowed values/.test(dropped.reason) && dropped.sent === 'Sparkly');
  assert.ok(out.body.notes.length === 1);

  // ---------- 4. policies: blank = the account's default; dynamic policies push nothing ----------
  reset();
  await call(revise, { id: 'L1' }, { sellPrice: 12, quantity: 2, paymentPolicyId: '', fulfillmentPolicyId: 'F7', returnPolicyId: 'bad id!' });
  assert.deepStrictEqual(revises[0].policies, { paymentPolicyId: 'DP', fulfillmentPolicyId: 'F7', returnPolicyId: undefined }, 'blank -> account default; an invalid id is ignored');
  reset();
  await call(revise, { id: 'L1' }, { sellPrice: 12, quantity: 2, paymentPolicyId: 'P2', useDynamicPolicies: true });
  assert.strictEqual(revises[0].policies, undefined);
  reset();
  await call(revise, { id: 'L1' }, { sellPrice: 12, quantity: 2 });
  assert.strictEqual(revises[0].policies, undefined, 'no policy in the request: policies are left alone');

  // ---------- 5. item location ----------
  reset();
  reviseImpl = async (a) => ({ offerId: 'O1', sku: 'S1', sellPrice: 12, pushedPrice: 12, quantity: 2, categoryId: '15052', imageCount: 0, sentAspects: null, live: liveOf({ merchantLocationKey: 'loc-GB-SW1A1AA' }) });
  out = await call(revise, { id: 'L1' }, { sellPrice: 12, quantity: 2, countryLocation: 'UK', postalCode: 'SW1A 1AA', locationCity: 'London' });
  assert.deepStrictEqual(locations, [['GB', 'SW1A 1AA']], 'UK is written GB for eBay');
  assert.strictEqual(revises[0].merchantLocationKey, 'loc-GB-SW1A1AA');
  assert.strictEqual(saved[0].countryLocation, 'GB'); assert.strictEqual(saved[0].postalCode, 'SW1A 1AA'); assert.strictEqual(saved[0].locationCity, 'London');
  assert.deepStrictEqual(out.body.notApplied, []);

  // ---------- 6. eBay refuses the update: the error is passed on and ELMS keeps its copy ----------
  reset();
  reviseImpl = async () => { const e = new Error('eBay says: title too long (eBay error 25005)'); e.statusCode = 400; throw e; };
  out = await call(revise, { id: 'L1' }, { title: 'x', sellPrice: 12, quantity: 2 });
  assert.strictEqual(out.status, 400); assert.strictEqual(out.body.success, false); assert.ok(/title too long/.test(out.body.error));
  assert.strictEqual(saved.length, 0, 'nothing saved in ELMS when eBay refused');

  // ---------- 7. eBay took it but could not be read back: saved as sent, and said so ----------
  reset();
  reviseImpl = async () => ({ offerId: 'O1', sku: 'S1', sellPrice: 12, pushedPrice: 12, quantity: 2, categoryId: '15052', imageCount: 0, sentAspects: { Brand: ['Adidas'], Size: ['M'] }, live: null, liveError: 'timeout' });
  out = await call(revise, { id: 'L1' }, { title: 'New title', sellPrice: 12, quantity: 2, aspects: { Brand: ['Adidas'] } });
  assert.strictEqual(out.body.success, true); assert.strictEqual(out.body.verified, false); assert.deepStrictEqual(out.body.notApplied, []);
  assert.deepStrictEqual(saved[0].ebayAspects, { Brand: ['Adidas'], Size: ['M'] });
  assert.strictEqual(saved[0].title, 'New title');

  // ---------- 8. a listing that cannot be revised ----------
  reset(); listing = null;
  out = await call(revise, { id: 'L1' }, { sellPrice: 12, quantity: 2 }); assert.strictEqual(out.status, 404);
  reset(); listing.ebay_offer_id = null;
  out = await call(revise, { id: 'L1' }, { sellPrice: 12, quantity: 2 }); assert.strictEqual(out.status, 400); assert.ok(/offer ID/.test(out.body.error));
  reset(); listing.ebay_account_id = null;
  out = await call(revise, { id: 'L1' }, {}); assert.strictEqual(out.status, 400);
  assert.strictEqual(revises.length, 0);

  // ---------- 9. GET /live: eBay's data, ELMS brought in step (never the price) ----------
  reset();
  liveImpl = async () => liveOf({ title: 'Title on eBay', quantity: 9, categoryId: '111', price: 99 });
  out = await call(liveGet, { id: 'L1' });
  assert.strictEqual(out.body.success, true); assert.strictEqual(out.body.live.title, 'Title on eBay'); assert.strictEqual(out.body.live.price, 99);
  assert.deepStrictEqual(Object.keys(saved[0]).sort(), ['categoryId', 'ebayAspects', 'markDraftCustomized', 'quantity', 'title']);
  assert.ok(!('sellPrice' in saved[0]), "the price stays as ELMS keeps it (it may be in another currency)");
  assert.deepStrictEqual(saved[0].ebayAspects, { Brand: ['Adidas'], Color: ['Black'] });
  // nothing differs: nothing is written
  reset(); listing.title = 'New title'; listing.quantity = 2; listing.ebay_aspects = { Brand: ['Adidas'], Color: ['Black'] };
  liveImpl = async () => liveOf();
  out = await call(liveGet, { id: 'L1' });
  assert.strictEqual(saved.length, 0); assert.strictEqual(out.body.success, true);
  // eBay cannot be reached
  reset(); liveImpl = async () => { const e = new Error('eBay timed out'); e.statusCode = 504; throw e; };
  out = await call(liveGet, { id: 'L1' });
  assert.strictEqual(out.status, 504); assert.ok(/timed out/.test(out.body.error));
  reset(); listing = null; out = await call(liveGet, { id: 'L1' }); assert.strictEqual(out.status, 404);

  console.log('live listing route tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
