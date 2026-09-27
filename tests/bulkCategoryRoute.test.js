// POST /api/listings/bulk-category and GET /api/listings/bulk-category/cost: an empty or too big selection is refused, the admin's switch is respected,
// the answer carries what happened to each draft, how many were filled and the credits used, and a crash gives a clear error, not a stack trace.
// The route handlers are called directly with the models stood in for (the fake stays in place while they run: they load the fill code when called).
const assert = require('assert');
const Module = require('module');

let switchOn = true;
let fill = async (u, ids) => ids.map((id) => ({ id, title: 'T' + id, status: 'filled', categoryId: '222', categoryPath: 'A > B', creditsUsed: 3 }));
const filled = [];
const fakes = {
  '../models/listingsModel': {
    listListings: async () => [], listListingsByStatuses: async () => [], countListingsByStatus: async () => 0, getListingById: async () => null,
    claimListingForPublishing: async () => null, markPublished: async () => null, markError: async () => null, markPaused: async () => null, resetErrorToDraft: async () => null,
    deleteListing: async () => null, scheduleListing: async () => null, unscheduleListing: async () => null, updateListingSettings: async () => null, updateListingStats: async () => null,
  },
  '../services/ebayListingService': { deleteOffer: async () => {} },
  '../models/ebayAccountsModel': { getEbayAccountRefreshToken: async () => 'tok' },
  '../models/settingsModel': { getAiSettings: async () => ({ aiCategoryEnabled: switchOn }) },
  '../services/categoryFillService': { fillManyDraftCategories: async (u, ids) => { filled.push({ u, ids }); return fill(u, ids); } },
};
const origLoad = Module._load;
Module._load = function (request, parent) {
  if (fakes[request] && parent && /routes[\\/]listings\.js/.test(parent.filename)) return fakes[request];
  return origLoad.apply(this, arguments);
};
const router = require('../routes/listings');
const { ACTION_COSTS } = require('../config/actionCosts');

const handler = (method, p) => { const l = router.stack.find((x) => x.route && x.route.path === p && x.route.methods[method]); if (!l) throw new Error('no route ' + method + ' ' + p); return l.route.stack[l.route.stack.length - 1].handle; };
const fakeRes = () => { const res = { statusCode: 200 }; res.status = (c) => { res.statusCode = c; return res; }; res.json = (b) => { res.body = b; return res; }; return res; };

(async () => {
  ACTION_COSTS.AI_CATEGORY = 3;
  let res = fakeRes(); handler('get', '/bulk-category/cost')({ userId: 'u1' }, res);
  assert.deepStrictEqual(res.body, { success: true, cost: 3 }, 'the admin-set price');

  const post = handler('post', '/bulk-category');
  res = fakeRes(); await post({ userId: 'u1', body: { ids: [] } }, res);
  assert.strictEqual(res.statusCode, 400);
  res = fakeRes(); await post({ userId: 'u1', body: { ids: Array.from({ length: 21 }, (_, i) => 'd' + i) } }, res);
  assert.strictEqual(res.statusCode, 400); assert.match(res.body.error, /at most 20/); assert.strictEqual(filled.length, 0);

  res = fakeRes(); await post({ userId: 'u1', body: { ids: ['d1', 'd2', 'd1', ' '] } }, res);
  assert.strictEqual(res.body.success, true);
  assert.deepStrictEqual(filled[0], { u: 'u1', ids: ['d1', 'd2'] }, 'each draft once');
  assert.deepStrictEqual([res.body.filled, res.body.creditsUsed, res.body.cost, res.body.results.length], [2, 6, 3, 2]);

  // a mix of what can happen: only the drafts that really got a category count, and only they are charged
  fill = async (u, ids) => [
    { id: ids[0], title: 'A', status: 'filled', categoryId: '222', creditsUsed: 3 },
    { id: ids[1], title: 'B', status: 'has_category', creditsUsed: 0 },
    { id: 'x', title: 'C', status: 'skipped', reason: 'No category list is uploaded for ebay.de', creditsUsed: 0 },
    { id: 'y', title: 'D', status: 'failed', reason: 'boom', creditsUsed: 0 },
  ];
  res = fakeRes(); await post({ userId: 'u1', body: { ids: ['d1', 'd2'] } }, res);
  assert.deepStrictEqual([res.body.filled, res.body.creditsUsed], [1, 3]);

  // the admin switched it off
  switchOn = false; filled.length = 0;
  res = fakeRes(); await post({ userId: 'u1', body: { ids: ['d1'] } }, res);
  assert.strictEqual(res.statusCode, 403); assert.match(res.body.error, /turned off by the administrator/); assert.strictEqual(filled.length, 0, 'nothing was tried');

  // a crash: a clear message
  switchOn = true; fill = async () => { throw new Error('database down'); };
  const log = console.error; console.error = () => {};
  res = fakeRes(); await post({ userId: 'u1', body: { ids: ['d1'] } }, res);
  console.error = log;
  assert.strictEqual(res.statusCode, 500); assert.strictEqual(res.body.error, 'Could not fill the categories. Please try again.');

  Module._load = origLoad;
  console.log('bulk category route tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
