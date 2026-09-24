// Drafts: one profit % for every selected draft (price = Amazon cost + N%), and one set of policies for all of them.
const assert = require('assert');
const Module = require('module');

const store = {
  a: { id: 'a', status: 'draft', title: 'Lamp', amazon_price: 20 },
  b: { id: 'b', status: 'error', title: 'Chair', amazon_price: 49.99 },
  c: { id: 'c', status: 'published', title: 'Live one', amazon_price: 10 },
  d: { id: 'd', status: 'draft', title: 'No price', amazon_price: null },
  e: { id: 'e', status: 'draft', title: 'Price only on import', amazon_price: null, import_id: 'imp1' },
  f: { id: 'f', status: 'draft', title: 'Import has product price', amazon_price: null, import_id: 'imp2' },
};
const imports = { imp1: { amazon_price: 30 }, imp2: { amazon_price: null, product: { price: 12.5 } } };
const saved = {};
const settingsCalls = [];
const fakes = {
  '../models/listingsModel': {
    listListings: async () => [], listListingsByStatuses: async () => [], countListingsByStatus: async () => 0,
    getListingById: async (u, id) => (u === 'u1' ? store[id] || null : null),
    updateListing: async (u, id, fields) => { saved[id] = fields; return {}; },
    updateListingSettings: async (u, id, fields) => { if (!store[id] || u !== 'u1') return null; settingsCalls.push([id, fields]); return store[id]; },
    claimListingForPublishing: async () => null, markPublished: async () => null, markError: async () => null, markPaused: async () => null,
    resetErrorToDraft: async () => null, deleteListing: async () => null, scheduleListing: async () => null, unscheduleListing: async () => null, updateListingStats: async () => null,
  },
  '../services/publishQueueService': { processOneQueuedListing: async () => ({}) },
  '../models/importsModel': { getImportById: async (u, id) => (u === 'u1' ? imports[id] || null : null) },
  '../models/usersModel': { hasCredits: async () => true, spendCredit: async () => true, refundCredit: async () => true },
};
const origLoad = Module._load;
Module._load = function (request, parent) {
  if (fakes[request] && parent && /routes.listings.js$/.test(parent.filename)) return fakes[request];
  return origLoad.apply(this, arguments);
};
const router = require('../routes/listings');
Module._load = origLoad;

const handler = (method, p) => { const l = router.stack.find((x) => x.route && x.route.path === p && x.route.methods[method]); assert.ok(l, method + ' ' + p); return l.route.stack[l.route.stack.length - 1].handle; };
const fakeRes = () => { const r = { statusCode: 200 }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
const call = async (method, p, body, userId = 'u1') => { const res = fakeRes(); await handler(method, p)({ userId, body }, res); return res; };

(async () => {
  // ---------- profit % ----------
  let res = await call('post', '/bulk-pricing', { ids: ['a', 'b', 'c', 'd', 'zzz', 'a'], profitPercent: 10 });
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.updated, 2, 'the draft and the failed draft; "a" listed twice counts once');
  assert.deepStrictEqual(saved.a, { sellPrice: 22, markupPercent: 10, marginAmount: 2 });
  assert.deepStrictEqual(saved.b, { sellPrice: 54.99, markupPercent: 10, marginAmount: 5 });
  assert.deepStrictEqual(res.body.prices, { a: 22, b: 54.99 });
  const why = Object.fromEntries(res.body.skipped.map((s) => [s.id, s.reason]));
  assert.match(why.c, /Only drafts/);
  assert.match(why.d, /No Amazon price/);
  assert.match(why.zzz, /Not found/);
  // the cost the draft screen shows can live on the Amazon import instead of the draft
  res = await call('post', '/bulk-pricing', { ids: ['e', 'f'], profitPercent: 10 });
  assert.strictEqual(res.body.updated, 2);
  assert.strictEqual(saved.e.sellPrice, 33);
  assert.strictEqual(saved.e.amazonPrice, 30);
  assert.strictEqual(saved.f.sellPrice, 13.75);
  assert.ok(!saved.a || saved.a.amazonPrice === undefined, 'a draft that has its own price is not rewritten');
  assert.ok(!saved.c && !saved.d, 'nothing written for the ones that were skipped');

  // a negative profit (selling below cost, e.g. a clearance) is allowed within limits; nonsense is refused
  res = await call('post', '/bulk-pricing', { ids: ['a'], profitPercent: -5 });
  assert.strictEqual(saved.a.sellPrice, 19);
  for (const bad of ['', null, undefined, 'abc', -100, 1001, Infinity]) {
    res = await call('post', '/bulk-pricing', { ids: ['a'], profitPercent: bad });
    assert.strictEqual(res.statusCode, 400, 'refused: ' + String(bad));
  }
  res = await call('post', '/bulk-pricing', { ids: [], profitPercent: 10 });
  assert.strictEqual(res.statusCode, 400);
  res = await call('post', '/bulk-pricing', { ids: Array.from({ length: 501 }, (_, i) => 'x' + i), profitPercent: 10 });
  assert.strictEqual(res.statusCode, 400, 'at most 500 at a time');
  res = await call('post', '/bulk-pricing', { ids: ['a'], profitPercent: 10 }, 'someone-else');
  assert.strictEqual(res.body.updated, 0, 'another user\'s drafts are never touched');

  // ---------- policies ----------
  res = await call('patch', '/bulk-settings', { ids: ['a', 'b', 'nope'], paymentPolicyId: 'PAY1', returnPolicyId: 'RET9', useDynamicPolicies: false, title: 'ignored' });
  assert.strictEqual(res.body.updated, 2);
  assert.deepStrictEqual(settingsCalls[0][1], { useDynamicPolicies: false, paymentPolicyId: 'PAY1', returnPolicyId: 'RET9' }, 'only the policy fields, only the ones sent');
  assert.strictEqual(res.body.skipped.length, 1);
  res = await call('patch', '/bulk-settings', { ids: ['a'] });
  assert.strictEqual(res.statusCode, 400, 'nothing to change');
  res = await call('patch', '/bulk-settings', { ids: [], paymentPolicyId: 'X' });
  assert.strictEqual(res.statusCode, 400);
  console.log('bulk pricing tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
