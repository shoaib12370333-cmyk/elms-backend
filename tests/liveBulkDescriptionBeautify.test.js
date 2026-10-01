// Live Listings "Beautify descriptions with AI" (services/descriptionBeautifyService.js beautifyLiveDescription): the
// same beautifyEbayDescription restructuring beautifyDraftDescription uses, but the new HTML is pushed to eBay with
// ONE reviseActiveListing call before ELMS's own copy is saved - unlike a draft, where nothing is live yet to push to.
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports, children: [], paths: [] }; };

const store = {};
const saved = {};
let balance = 100;
const spent = [];
const refunded = [];
let templates = {};
let aiAnswer = '<h2>Key Features</h2><ul><li>Black mesh</li></ul>';
let aiCalls = 0;
let aiFails = false;
let aiEnabled = true;
const revises = [];
let reviseFail = false;
let tokens = { A1: 'tok1', A2: null };

stub('models/listingsModel', {
  getListingById: async (u, id) => (u === 'u1' ? store[id] || null : null),
  updateListing: async (u, id, fields) => { saved[id] = { ...(saved[id] || {}), ...fields }; return {}; },
});
stub('models/ebayAccountsModel', { getEbayAccountRefreshToken: async (u, a) => tokens[a] });
stub('models/usersModel', {
  hasCredits: async (u, cost) => cost <= 0 || balance >= cost,
  spendCredit: async (u, cost) => { if (balance < cost) return false; balance -= cost; spent.push(cost); return true; },
  refundCredit: async (u, cost) => { balance += cost; refunded.push(cost); return true; },
  getDescriptionTemplate: async (u) => templates[u] || null,
  setDescriptionTemplate: async (u, t) => { templates[u] = t; return t; },
});
stub('models/schemas/AiUsage', { create: async () => ({}) });
stub('models/settingsModel', { getAiSettings: async () => ({ aiBeautifyDescriptionEnabled: aiEnabled, aiCustomInstructions: '' }) });
stub('services/aiService', { askClaude: async () => { aiCalls += 1; if (aiFails) throw new Error('AI is down'); return { text: aiAnswer, model: 'test', inputTokens: 1, outputTokens: 1 }; } });
// Keeps every real export; only overrides reviseActiveListing - routes/listings.js binds it straight off this module.
stub('services/ebayListingService', {
  ...require('../services/ebayListingService'),
  reviseActiveListing: async (token, args) => { revises.push({ token, args }); if (reviseFail) throw new Error('eBay refused this change.'); return { live: null }; },
});

const { ACTION_COSTS } = require('../config/actionCosts');
const { beautifyLiveDescription, beautifyManyLiveDescriptions } = require('../services/descriptionBeautifyService');
const router = require('../routes/listings');
const handler = (method, p) => { const l = router.stack.find((x) => x.route && x.route.path === p && x.route.methods[method]); assert.ok(l, method + ' ' + p); return l.route.stack[l.route.stack.length - 1].handle; };
const fakeRes = () => { const r = { statusCode: 200 }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
const call = async (method, p, body, userId = 'u1') => { const res = fakeRes(); await handler(method, p)({ userId, body }, res); return res; };

const deps = { getListingById: async (u, id) => store[id] || null, updateListing: async (u, id, fields) => { saved[id] = { ...(saved[id] || {}), ...fields }; return {}; }, reviseActiveListing: (...a) => require('../services/ebayListingService').reviseActiveListing(...a), getRefreshToken: async (u, a) => tokens[a] };
const live = (id, extra = {}) => ({ id, status: 'published', title: 'Acme Running Shoes ' + id, description: 'Black running shoes.', bullet_points: ['Black mesh'], specifications: [], images: ['https://a.com/1.jpg'], ebay_offer_id: 'O' + id, sku: 'B0' + id, ebay_account_id: 'A1', sell_price: 29.99, currency: 'USD', quantity: 3, category_id: '1', ...extra });
const reset = () => { for (const k of Object.keys(saved)) delete saved[k]; spent.length = 0; refunded.length = 0; aiCalls = 0; aiFails = false; revises.length = 0; reviseFail = false; tokens = { A1: 'tok1', A2: null }; };
const template = { templateId: 'bold', blocks: ['bullets'], branding: {}, sizeChartHtml: '', videoUrl: '', customHtml: '' };

(async () => {
  // ---------- one live listing: beautified, pushed to eBay, then saved ----------
  ACTION_COSTS.AI_DESCRIPTION_BEAUTIFY = 3;
  store.a = live('a');
  let r = await beautifyLiveDescription('u1', 'a', template, deps);
  assert.strictEqual(r.status, 'done');
  assert.strictEqual(r.creditsUsed, 3);
  assert.strictEqual(revises.length, 1);
  assert.strictEqual(revises[0].args.description, aiAnswer);
  assert.strictEqual(revises[0].args.categoryId, '1');
  assert.strictEqual(saved.a.description, aiAnswer);
  assert.deepStrictEqual(spent, [3]);

  // ---------- skip reasons ----------
  reset();
  store.b = live('b', { status: 'draft' });
  store.c = live('c', { ebay_offer_id: null });
  store.d = live('d', { ebay_account_id: null });
  store.e = live('e', { ebay_account_id: 'A2' }); tokens.A2 = null;
  for (const [id, why] of [['b', /Only a live/], ['c', /no eBay offer/], ['d', /No eBay account/], ['e', /Reconnect/], ['nope', /Not found/]]) {
    r = await beautifyLiveDescription('u1', id, template, deps);
    assert.strictEqual(r.status, 'skipped', id);
    assert.match(r.reason, why, id);
  }
  assert.strictEqual(aiCalls, 0);
  assert.deepStrictEqual(spent, []);

  // ---------- the AI is down: the credit comes back, nothing sent to eBay ----------
  reset(); balance = 100;
  aiFails = true;
  store.h = live('h');
  r = await beautifyLiveDescription('u1', 'h', template, deps);
  assert.strictEqual(r.status, 'failed');
  assert.deepStrictEqual(refunded, [3]);
  assert.strictEqual(revises.length, 0);
  aiFails = false;

  // ---------- eBay refuses the revise: the credit comes back, ELMS is not touched ----------
  reset(); balance = 100;
  reviseFail = true;
  store.i = live('i');
  r = await beautifyLiveDescription('u1', 'i', template, deps);
  assert.strictEqual(r.status, 'failed');
  assert.match(r.reason, /refused this change/);
  assert.deepStrictEqual(refunded, [3]);
  assert.ok(!saved.i);

  // ---------- the route ----------
  reset(); balance = 1000; ACTION_COSTS.AI_DESCRIPTION_BEAUTIFY = 3; templates.u1 = template;
  for (const id of ['r1', 'r2', 'r3']) store[id] = live(id);
  let res = await call('post', '/bulk-live-description-beautify', { ids: ['r1', 'r2', 'r3', 'r1'] });
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.results.length, 3, 'a listing twice is done once');
  assert.strictEqual(res.body.filled, 3);
  assert.strictEqual(res.body.creditsUsed, 9);
  res = await call('post', '/bulk-live-description-beautify', { ids: [] });
  assert.strictEqual(res.statusCode, 400);
  res = await call('post', '/bulk-live-description-beautify', { ids: Array.from({ length: 16 }, (_, i) => 'x' + i) });
  assert.strictEqual(res.statusCode, 400, 'at most 15 per request');
  aiEnabled = false;
  res = await call('post', '/bulk-live-description-beautify', { ids: ['r1'] });
  assert.strictEqual(res.statusCode, 403);
  aiEnabled = true;

  console.log('live bulk description beautify tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
