// Bulk delete (the Drafts page's "select several -> Remove"): it used to read and delete the listings ONE BY ONE (two database round trips each), so
// thousands took minutes. Now ONE query finds them and ONE command removes every listing that has no eBay offer. A listing with an eBay offer still has
// the offer ended first (and stays when eBay refuses), an unknown id is reported, and one bad id never stops the rest.
// This calls the route handler directly (no HTTP server) with the real models stood in for.
const assert = require('assert');
const Module = require('module');

const rows = {
  d1: { id: 'd1', title: 'Draft one', ebay_offer_id: null, ebay_account_id: null },
  d2: { id: 'd2', title: 'Draft two', ebay_offer_id: null, ebay_account_id: null },
  d3: { id: 'd3', title: 'Draft three', ebay_offer_id: null, ebay_account_id: 'acc1' }, // a store but no offer: still a plain draft
  live1: { id: 'live1', title: 'Live one', ebay_offer_id: 'offer-1', ebay_account_id: 'acc1' },
  live2: { id: 'live2', title: 'Live two', ebay_offer_id: 'offer-2', ebay_account_id: 'acc2' },
};
const lookups = [];
const removeCalls = [];
const offerCalls = [];
const tokenCalls = [];
let failOffer = null; // offer id whose eBay delete fails
let noTokenFor = null;

const fakes = {
  '../models/listingsModel': {
    listListings: async () => [], listListingsByStatuses: async () => [], countListingsByStatus: async () => 0,
    getListingById: async () => { throw new Error('the slow one-by-one read must not be used'); },
    getListingsForDelete: async (_u, ids) => { lookups.push(ids); return ids.filter((id) => rows[id]).map((id) => rows[id]); },
    deleteListingsMany: async (_u, ids) => { removeCalls.push(ids); return ids.filter((id) => rows[id]).length; },
    claimListingForPublishing: async () => null, markPublished: async () => null, markError: async () => null,
    markPaused: async () => null, resetErrorToDraft: async () => null,
    deleteListing: async () => { throw new Error('the slow one-by-one delete must not be used'); },
    scheduleListing: async () => null, unscheduleListing: async () => null,
    updateListingSettings: async () => null, updateListingStats: async () => null,
  },
  '../services/ebayListingService': {
    deleteOffer: async (token, offerId) => { offerCalls.push(offerId); if (offerId === failOffer) throw new Error('eBay rejected the delete.'); },
  },
  '../models/ebayAccountsModel': { getEbayAccountRefreshToken: async (_u, accountId) => { tokenCalls.push(accountId); return accountId === noTokenFor ? null : 'tok'; } },
};

const origLoad = Module._load;
Module._load = function (request, parent) {
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
const reset = () => { lookups.length = 0; removeCalls.length = 0; offerCalls.length = 0; tokenCalls.length = 0; failOffer = null; noTokenFor = null; };

(async () => {
  const handler = findHandler('post', '/bulk-delete');

  // empty ids -> 400, too many -> 400, nothing touched
  let res = fakeRes();
  await handler({ userId: 'u1', body: { ids: [] } }, res);
  assert.strictEqual(res.statusCode, 400); assert.strictEqual(res.body.success, false);
  res = fakeRes();
  await handler({ userId: 'u1', body: { ids: Array.from({ length: 5001 }, (_, i) => 'x' + i) } }, res);
  assert.strictEqual(res.statusCode, 400); assert.match(res.body.error, /at most 5000/); assert.strictEqual(lookups.length, 0);

  // plain drafts: ONE query and ONE delete for all of them, whatever their number
  reset();
  const many = Array.from({ length: 3000 }, (_, i) => 'k' + i);
  many.forEach((id) => { rows[id] = { id, title: id, ebay_offer_id: null, ebay_account_id: null }; });
  res = fakeRes();
  await handler({ userId: 'u1', body: { ids: [...many, 'd1', 'd3', 'd1'] } }, res); // d1 twice: counted once
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.deletedCount, 3002);
  assert.strictEqual(res.body.errors, undefined);
  assert.strictEqual(lookups.length, 1, 'one query to find them'); assert.strictEqual(removeCalls.length, 1, 'one command to remove them all');
  assert.strictEqual(removeCalls[0].length, 3002); assert.strictEqual(offerCalls.length, 0); assert.strictEqual(tokenCalls.length, 0, 'no eBay work for plain drafts');
  many.forEach((id) => delete rows[id]);

  // mixed batch: two real drafts, one unknown id, one live listing whose eBay delete fails, one live listing that works, a store without a token
  reset(); failOffer = 'offer-1';
  res = fakeRes();
  await handler({ userId: 'u1', body: { ids: ['d1', 'd2', 'missing', 'live1', 'live2'] } }, res);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.deletedCount, 3, 'the two drafts and the live one that eBay accepted');
  assert.deepStrictEqual(removeCalls[0].sort(), ['d1', 'd2'], 'drafts first, in one command');
  assert.deepStrictEqual(removeCalls.slice(1), [['live2']], 'the live listing is removed only after eBay ended its offer');
  assert.ok(res.body.errors.some((e) => e.includes('missing') && /not found/.test(e)), 'reports the unknown id');
  assert.ok(res.body.errors.some((e) => e.includes('Live one') && e.includes('eBay rejected')), 'reports the eBay failure without crashing the whole batch');
  assert.strictEqual(res.body.errors.length, 2);
  assert.deepStrictEqual(offerCalls.sort(), ['offer-1', 'offer-2']);

  // a store with no token: its listing stays, the others go
  reset(); noTokenFor = 'acc2';
  res = fakeRes();
  await handler({ userId: 'u1', body: { ids: ['d1', 'live2'] } }, res);
  assert.strictEqual(res.body.deletedCount, 1); assert.ok(res.body.errors[0].includes('missing a refresh token')); assert.deepStrictEqual(offerCalls, []);

  // eBay works: the live listing goes through too, its store's token is read once per store
  reset();
  res = fakeRes();
  await handler({ userId: 'u1', body: { ids: ['live1', 'live1', 'live2'] } }, res);
  assert.strictEqual(res.body.deletedCount, 2); assert.strictEqual(res.body.errors, undefined);
  assert.deepStrictEqual(tokenCalls.sort(), ['acc1', 'acc2']);

  console.log('listings bulk-delete tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
