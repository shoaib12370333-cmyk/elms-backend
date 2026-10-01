// Live Listings "Fill specifics with AI" (services/listingAspectFillService.js fillLiveListingAspects): the same AI
// fill + eBay-value-check logic fillDraftAspects uses, but the result is pushed to eBay with ONE reviseActiveListing
// call before ELMS's own copy is saved - unlike a draft, where nothing is live yet to push to.
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports, children: [], paths: [] }; };

const store = {};
const saved = {};
let balance = 100;
const spent = [];
const refunded = [];
let aiAnswer = '{}';
let aiCalls = 0;
let aiFails = false;
let defs = [];
const revises = [];
let reviseFail = false;
let tokens = { A1: 'tok1', A2: null };

stub('models/listingsModel', {
  getListingById: async (u, id) => (u === 'u1' ? store[id] || null : null),
  updateListing: async (u, id, fields) => { saved[id] = { ...(saved[id] || {}), ...fields }; return {}; },
});
stub('models/importsModel', { getImportById: async () => null });
stub('models/ebayAccountsModel', { getEbayAccountById: async () => ({ marketplaceId: 'EBAY_GB' }), getEbayAccountRefreshToken: async (u, a) => tokens[a] });
stub('models/usersModel', {
  spendCredit: async (u, cost) => { if (balance < cost) return false; balance -= cost; spent.push(cost); return true; },
  refundCredit: async (u, cost) => { balance += cost; refunded.push(cost); return true; },
});
stub('models/schemas/AiUsage', { create: async () => ({}) });
let aiEnabled = true;
stub('models/settingsModel', { getAiSettings: async () => ({ aiAspectsEnabled: aiEnabled }) });
stub('services/aiService', { askClaude: async () => { aiCalls += 1; if (aiFails) throw new Error('AI is down'); return { text: aiAnswer, model: 'test', inputTokens: 1, outputTokens: 1 }; } });
stub('services/ebayTaxonomyService', {
  getItemAspectsForCategory: async (t, categoryId) => { if (categoryId === 'BAD') { const e = new Error('nope'); e.statusCode = 404; throw e; } return { aspects: defs }; },
  suggestCategories: async () => ({ topSuggestion: { categoryId: '777', categoryName: 'Sneakers' } }),
  getCategoryInfo: async () => ({ isLeaf: true }),
});
// Keeps every real export (checkAspects, used internally, needs the real buildAspects from this same module) and
// only overrides reviseActiveListing - unlike liveBulkVeroService.js's own deps.revise pattern, fillLiveListingAspects
// and routes/listings.js both bind reviseActiveListing straight off this module, not through an injectable field.
stub('services/ebayListingService', {
  ...require('../services/ebayListingService'),
  reviseActiveListing: async (token, args) => { revises.push({ token, args }); if (reviseFail) throw new Error('eBay refused this change.'); return { live: null }; },
});

const { ACTION_COSTS } = require('../config/actionCosts');
const { fillLiveListingAspects, fillManyLiveAspects } = require('../services/listingAspectFillService');
const router = require('../routes/listings');
const handler = (method, p) => { const l = router.stack.find((x) => x.route && x.route.path === p && x.route.methods[method]); assert.ok(l, method + ' ' + p); return l.route.stack[l.route.stack.length - 1].handle; };
const fakeRes = () => { const r = { statusCode: 200 }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
const call = async (method, p, body, userId = 'u1') => { const res = fakeRes(); await handler(method, p)({ userId, body }, res); return res; };

const deps = { getListingById: async (u, id) => store[id] || null, updateListing: async (u, id, fields) => { saved[id] = { ...(saved[id] || {}), ...fields }; return {}; }, reviseActiveListing: (...a) => require('../services/ebayListingService').reviseActiveListing(...a), getRefreshToken: async (u, a) => tokens[a] };
const live = (id, extra = {}) => ({ id, status: 'published', title: 'Acme Running Shoes ' + id, category_id: '1', ebay_aspects: {}, bullet_points: ['Black mesh'], specifications: [], ebay_offer_id: 'O' + id, sku: 'B0' + id, ebay_account_id: 'A1', sell_price: 29.99, currency: 'USD', quantity: 3, ...extra });
const reset = () => { for (const k of Object.keys(saved)) delete saved[k]; spent.length = 0; refunded.length = 0; aiCalls = 0; aiFails = false; revises.length = 0; reviseFail = false; tokens = { A1: 'tok1', A2: null }; };

(async () => {
  defs = [
    { name: 'Brand', required: true, usage: 'REQUIRED', cardinality: 'SINGLE', mode: 'FREE_TEXT', dataType: 'STRING', values: [] },
    { name: 'Colour', required: false, usage: 'RECOMMENDED', cardinality: 'SINGLE', mode: 'SELECTION_ONLY', dataType: 'STRING', values: ['Black', 'Blue'] },
  ];
  aiAnswer = '{"Brand":"Acme","Colour":"black"}';

  // ---------- one live listing: filled, pushed to eBay, then saved ----------
  ACTION_COSTS.AI_ASPECTS = 2;
  store.a = live('a');
  let r = await fillLiveListingAspects('u1', 'a', deps);
  assert.strictEqual(r.status, 'filled');
  assert.strictEqual(r.creditsUsed, 2);
  assert.strictEqual(revises.length, 1);
  assert.deepStrictEqual(revises[0].args.aspects, { Brand: ['Acme'], Colour: ['Black'] });
  assert.strictEqual(revises[0].args.categoryId, '1');
  assert.deepStrictEqual(saved.a.ebayAspects, { Brand: ['Acme'], Colour: ['Black'] });
  assert.deepStrictEqual(spent, [2]);

  // ---------- skip reasons: not live, no offer, no account, no token, no category, not found ----------
  reset();
  store.b = live('b', { status: 'draft' });
  store.c = live('c', { ebay_offer_id: null });
  store.d = live('d', { ebay_account_id: null });
  store.e = live('e', { ebay_account_id: 'A2' }); tokens.A2 = null;
  store.f = live('f', { category_id: null });
  for (const [id, why] of [['b', /Only a live/], ['c', /no eBay offer/], ['d', /No eBay account/], ['e', /Reconnect/], ['f', /no eBay category/], ['nope', /Not found/]]) {
    r = await fillLiveListingAspects('u1', id, deps);
    assert.strictEqual(r.status, 'skipped', id);
    assert.match(r.reason, why, id);
  }
  assert.strictEqual(aiCalls, 0);
  assert.deepStrictEqual(spent, []);

  // ---------- nothing new to add: no charge, no eBay call ----------
  reset(); balance = 100;
  store.g = live('g', { ebay_aspects: { Brand: ['Acme'], Colour: ['Black'] } });
  r = await fillLiveListingAspects('u1', 'g', deps);
  assert.strictEqual(r.status, 'nothing');
  assert.strictEqual(revises.length, 0);
  assert.strictEqual(balance, 100);

  // ---------- the AI is down: the credit comes back, nothing sent to eBay ----------
  reset(); balance = 100;
  aiFails = true;
  store.h = live('h');
  r = await fillLiveListingAspects('u1', 'h', deps);
  assert.strictEqual(r.status, 'failed');
  assert.deepStrictEqual(refunded, [2]);
  assert.strictEqual(revises.length, 0);
  aiFails = false;

  // ---------- eBay refuses the revise: the credit comes back, ELMS is not touched ----------
  reset(); balance = 100;
  reviseFail = true;
  store.i = live('i');
  r = await fillLiveListingAspects('u1', 'i', deps);
  assert.strictEqual(r.status, 'failed');
  assert.match(r.reason, /refused this change/);
  assert.deepStrictEqual(refunded, [2]);
  assert.ok(!saved.i);

  // ---------- the route ----------
  reset(); balance = 1000; ACTION_COSTS.AI_ASPECTS = 2;
  for (const id of ['r1', 'r2', 'r3']) store[id] = live(id);
  let res = await call('post', '/bulk-live-aspects', { ids: ['r1', 'r2', 'r3', 'r1'] });
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.results.length, 3, 'a listing twice is done once');
  assert.strictEqual(res.body.filled, 3);
  assert.strictEqual(res.body.creditsUsed, 6);
  res = await call('post', '/bulk-live-aspects', { ids: [] });
  assert.strictEqual(res.statusCode, 400);
  res = await call('post', '/bulk-live-aspects', { ids: Array.from({ length: 16 }, (_, i) => 'x' + i) });
  assert.strictEqual(res.statusCode, 400, 'at most 15 per request');
  aiEnabled = false;
  res = await call('post', '/bulk-live-aspects', { ids: ['r1'] });
  assert.strictEqual(res.statusCode, 403);
  aiEnabled = true;

  console.log('live bulk aspects tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
