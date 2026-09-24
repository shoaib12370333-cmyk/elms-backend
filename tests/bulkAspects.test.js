// AI item specifics for drafts: filled and SAVED, checked the way publishing checks them, and paid per draft at the price the
// admin set (10 drafts x 2 credits = 20). Skipped drafts, failures and "nothing new" cost nothing.
const assert = require('assert');
const path = require('path');

const stub = (rel, exports) => {
  const file = require.resolve(path.join('..', rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports, children: [], paths: [] };
};

const store = {};
const saved = {};
let balance = 100;
const spent = [];
const refunded = [];
let aiAnswer = '{}';
let aiCalls = 0;
let aiFails = false;
let defs = [];

stub('models/listingsModel', {
  getListingById: async (u, id) => (u === 'u1' ? store[id] || null : null),
  updateListing: async (u, id, fields) => { saved[id] = { ...(saved[id] || {}), ...fields }; return {}; },
});
stub('models/importsModel', { getImportById: async () => null });
stub('models/ebayAccountsModel', { getEbayAccountById: async () => ({ marketplaceId: 'EBAY_GB' }) });
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

const { ACTION_COSTS } = require('../config/actionCosts');
const { fillDraftAspects, fillManyDraftAspects, fillEditorAspects } = require('../services/listingAspectFillService');
const router = require('../routes/listings');
const handler = (method, p) => { const l = router.stack.find((x) => x.route && x.route.path === p && x.route.methods[method]); assert.ok(l, method + ' ' + p); return l.route.stack[l.route.stack.length - 1].handle; };
const fakeRes = () => { const r = { statusCode: 200 }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
const call = async (method, p, body, userId = 'u1') => { const res = fakeRes(); await handler(method, p)({ userId, body }, res); return res; };

const draft = (id, extra = {}) => ({ id, status: 'draft', title: 'Acme Running Shoes ' + id, category_id: '1', ebay_aspects: {}, bullet_points: ['Black mesh'], specifications: [], ...extra });
const reset = () => { for (const k of Object.keys(saved)) delete saved[k]; spent.length = 0; refunded.length = 0; aiCalls = 0; aiFails = false; };

(async () => {
  defs = [
    { name: 'Brand', required: true, usage: 'REQUIRED', cardinality: 'SINGLE', mode: 'FREE_TEXT', dataType: 'STRING', values: [] },
    { name: 'Colour', required: false, usage: 'RECOMMENDED', cardinality: 'SINGLE', mode: 'SELECTION_ONLY', dataType: 'STRING', values: ['Black', 'Blue'] },
    { name: 'Pattern', required: true, usage: 'REQUIRED', cardinality: 'SINGLE', mode: 'FREE_TEXT', dataType: 'STRING', values: [] },
  ];
  aiAnswer = '{"Brand":"Acme","Colour":"black"}';

  // ---------- one draft: filled, checked and saved ----------
  ACTION_COSTS.AI_ASPECTS = 2;
  store.a = draft('a');
  let r = await fillDraftAspects('u1', 'a');
  assert.strictEqual(r.status, 'filled');
  assert.strictEqual(r.creditsUsed, 2);
  assert.deepStrictEqual(saved.a.ebayAspects, { Brand: ['Acme'], Colour: ['Black'], Pattern: ['Does not apply'] }, 'the required Pattern gets the value eBay accepts, so publishing does not stop on it');
  assert.deepStrictEqual(r.missing, []);
  assert.deepStrictEqual(spent, [2]);
  assert.strictEqual(saved.a.categoryId, undefined, 'the category it already had is left alone');

  // what the seller typed is never overwritten
  reset();
  store.b = draft('b', { ebay_aspects: { Brand: ['Mine'] } });
  r = await fillDraftAspects('u1', 'b');
  assert.strictEqual(saved.b.ebayAspects.Brand[0], 'Mine');

  // ---------- no category: eBay's top suggestion is used and saved ----------
  reset();
  store.c = draft('c', { category_id: null });
  r = await fillDraftAspects('u1', 'c');
  assert.strictEqual(r.status, 'filled');
  assert.strictEqual(saved.c.categoryId, '777');
  assert.strictEqual(r.categoryId, '777');

  // ---------- skipped: nothing charged, nothing asked of the AI ----------
  reset();
  store.d = draft('d', { status: 'published' });
  store.e = draft('e', { category_id: 'BAD' });
  for (const [id, why] of [['d', /Only drafts/], ['e', /does not know category/], ['nope', /Not found/]]) {
    r = await fillDraftAspects('u1', id);
    assert.strictEqual(r.status, 'skipped');
    assert.match(r.reason, why);
  }
  assert.strictEqual(aiCalls, 0);
  assert.deepStrictEqual(spent, []);
  r = await fillDraftAspects('someone-else', 'a');
  assert.strictEqual(r.status, 'skipped', 'another user\'s draft is never touched');

  // ---------- the AI is down: the credits come back ----------
  reset(); balance = 100;
  aiFails = true;
  r = await fillDraftAspects('u1', 'a');
  assert.strictEqual(r.status, 'failed');
  assert.deepStrictEqual(refunded, [2]);
  assert.strictEqual(balance, 100);
  aiFails = false;

  // ---------- nothing new to add: no charge ----------
  reset(); balance = 100;
  store.f = draft('f', { ebay_aspects: { Brand: ['Acme'], Colour: ['Black'], Pattern: ['Solid'] } });
  r = await fillDraftAspects('u1', 'f');
  assert.strictEqual(r.status, 'nothing');
  assert.strictEqual(balance, 100);
  assert.ok(!saved.f);

  // ---------- a required specific nothing can fill is named, not left for the publish to fail on ----------
  reset();
  defs = [...defs, { name: 'Number of Pieces', required: true, usage: 'REQUIRED', cardinality: 'SINGLE', mode: 'FREE_TEXT', dataType: 'NUMBER', values: [] }];
  store.g = draft('g');
  r = await fillDraftAspects('u1', 'g');
  assert.strictEqual(r.status, 'filled');
  assert.deepStrictEqual(r.missing, ['Number of Pieces (a number)']);
  assert.strictEqual(saved.g.ebayAspects.Brand[0], 'Acme', 'everything else is still saved');
  defs = defs.slice(0, 3);

  // ---------- the editor's Fill with AI button gets values eBay accepts ----------
  reset();
  const ed = await fillEditorAspects({ title: 'Acme Running Shoes', aspects: defs, existing: { Brand: [] }, categoryId: '1', marketplaceId: 'EBAY_GB' });
  assert.deepStrictEqual(ed.data.values, { Brand: ['Acme'], Colour: ['Black'], Pattern: ['Does not apply'] });
  assert.deepStrictEqual(ed.data.missing, []);
  const edKept = await fillEditorAspects({ title: 'Acme Running Shoes', aspects: defs, existing: { Brand: ['Mine'] }, categoryId: '1', marketplaceId: 'EBAY_GB' });
  assert.strictEqual(edKept.data.values.Brand, undefined, 'what the seller typed stays');
  const edPlain = await fillEditorAspects({ title: 'Acme Running Shoes', aspects: defs, existing: {} });
  assert.deepStrictEqual(edPlain.data.values, { Brand: ['Acme'], Colour: ['Black'] }, 'without a category it is the plain AI answer');

  // ---------- the route ----------
  reset(); balance = 100; ACTION_COSTS.AI_ASPECTS = 2;
  for (const id of ['r1', 'r2', 'r3']) store[id] = draft(id);
  let res = await call('post', '/bulk-aspects', { ids: ['r1', 'r2', 'r3', 'r1'] });
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.results.length, 3, 'a draft listed twice is done once');
  assert.strictEqual(res.body.filled, 3);
  assert.strictEqual(res.body.creditsUsed, 6);
  assert.strictEqual(res.body.cost, 2);
  res = await call('post', '/bulk-aspects', { ids: [] });
  assert.strictEqual(res.statusCode, 400);
  res = await call('post', '/bulk-aspects', { ids: Array.from({ length: 26 }, (_, i) => 'x' + i) });
  assert.strictEqual(res.statusCode, 400, 'at most 25 per request');
  aiEnabled = false;
  res = await call('post', '/bulk-aspects', { ids: ['r1'] });
  assert.strictEqual(res.statusCode, 403);
  aiEnabled = true;
  res = await call('get', '/bulk-aspects/cost');
  assert.deepStrictEqual(res.body, { success: true, cost: 2 });

  // ---------- many drafts: 10 x 2 credits = 20 ----------
  reset(); balance = 1000;
  const ids = [];
  for (let i = 0; i < 10; i++) { store['m' + i] = draft('m' + i); ids.push('m' + i); }
  let results = await fillManyDraftAspects('u1', ids);
  assert.strictEqual(results.filter((x) => x.status === 'filled').length, 10);
  assert.strictEqual(spent.reduce((a, b) => a + b, 0), 20, '10 drafts at 2 credits = 20 credits');
  assert.deepStrictEqual(results.map((x) => x.id), ids, 'results come back in the order asked');

  // ---------- the balance runs out half way: the rest are not attempted and cost nothing ----------
  ACTION_COSTS.AI_ASPECTS = 2;
  reset(); balance = 4;
  for (const id of ids) store[id] = draft(id);
  results = await fillManyDraftAspects('u1', ids, { concurrency: 1 });
  assert.strictEqual(results.filter((x) => x.status === 'filled').length, 2);
  assert.strictEqual(results.filter((x) => x.status === 'no_credits').length, 8);
  assert.strictEqual(balance, 0);
  assert.strictEqual(aiCalls, 2, 'the AI is never called for a draft that could not be paid for');

  // ---------- free when the admin sets 0 ----------
  ACTION_COSTS.AI_ASPECTS = 0;
  reset(); balance = 0;
  store.z = draft('z');
  r = await fillDraftAspects('u1', 'z');
  assert.strictEqual(r.status, 'filled');
  assert.strictEqual(r.creditsUsed, 0);

  console.log('bulk aspects tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
