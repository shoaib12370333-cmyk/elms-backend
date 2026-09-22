// Regression test for a missing route: the frontend's "select several drafts -> Remove"
// button posted to /api/listings/bulk-delete, which didn't exist (404), so the frontend's
// res.json() failed trying to parse Express's HTML 404 page and showed a JSON-parse error
// instead of actually deleting anything. This calls the route handler directly (no HTTP
// server needed) with the real models mocked, and checks it deletes what it can, skips
// what it can't, and never throws even when eBay offer deletion fails for one item.
const assert = require('assert');
const Module = require('module');

const listingsById = {
  d1: { id: 'd1', title: 'Draft one', ebay_offer_id: null, ebay_account_id: null },
  d2: { id: 'd2', title: 'Draft two', ebay_offer_id: null, ebay_account_id: null },
  live1: { id: 'live1', title: 'Live one', ebay_offer_id: 'offer-1', ebay_account_id: 'acc1' },
};
const deleted = [];
let deleteOfferShouldFail = false;

const fakes = {
  '../models/listingsModel': {
    listListings: async () => [], listListingsByStatuses: async () => [], countListingsByStatus: async () => 0,
    getListingById: async (_u, id) => listingsById[id] || null,
    claimListingForPublishing: async () => null, markPublished: async () => null, markError: async () => null,
    markPaused: async () => null, resetErrorToDraft: async () => null,
    deleteListing: async (_u, id) => { deleted.push(id); return { id }; },
    scheduleListing: async () => null, unscheduleListing: async () => null,
    updateListingSettings: async () => null, updateListingStats: async () => null,
  },
  '../services/ebayListingService': {
    deleteOffer: async () => { if (deleteOfferShouldFail) throw new Error('eBay rejected the delete.'); },
  },
  '../models/ebayAccountsModel': { getEbayAccountRefreshToken: async () => 'tok' },
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (fakes[request] && parent && /routes[\\/]listings\.js/.test(parent.filename)) return fakes[request];
  return origLoad.apply(this, arguments);
};
const router = require('../routes/listings');
Module._load = origLoad;

function findHandler(method, path) {
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`No ${method.toUpperCase()} ${path} route registered.`);
  return layer.route.stack[layer.route.stack.length - 1].handle; // last middleware = the actual handler (after requireAuth)
}

function fakeRes() {
  const res = { statusCode: 200 };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

(async () => {
  const handler = findHandler('post', '/bulk-delete');

  // empty ids -> 400, nothing touched
  let res = fakeRes();
  await handler({ userId: 'u1', body: { ids: [] } }, res);
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.success, false);

  // mixed batch: two real drafts, one unknown id, one live listing whose eBay delete fails
  deleted.length = 0;
  deleteOfferShouldFail = true;
  res = fakeRes();
  await handler({ userId: 'u1', body: { ids: ['d1', 'd2', 'missing', 'live1'] } }, res);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.deletedCount, 2, 'the two plain drafts were deleted');
  assert.deepStrictEqual(deleted.sort(), ['d1', 'd2']);
  assert.ok(res.body.errors.some((e) => e.includes('missing')), 'reports the unknown id');
  assert.ok(res.body.errors.some((e) => e.includes('eBay rejected')), 'reports the eBay failure without crashing the whole batch');

  // now eBay delete succeeds - the live listing goes through too
  deleted.length = 0;
  deleteOfferShouldFail = false;
  res = fakeRes();
  await handler({ userId: 'u1', body: { ids: ['live1'] } }, res);
  assert.strictEqual(res.body.deletedCount, 1);
  assert.strictEqual(res.body.errors, undefined);

  console.log('listings bulk-delete tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
