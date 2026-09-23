// POST /api/listings/:id/publish must not charge a credit itself (processOneQueuedListing already does,
// and refunds it on failure - charging in both places took two credits, one never refunded) and must
// answer with an error when the publish failed, instead of success:true.
const assert = require('assert');
const Module = require('module');

let credits = { spend: 0, refund: 0 };
let processResult = { id: 'l1', status: 'published' };
const fakes = {
  '../models/listingsModel': {
    listListings: async () => [], listListingsByStatuses: async () => [], countListingsByStatus: async () => 0,
    getListingById: async (_u, id) => ({ id, status: 'draft' }),
    claimListingForPublishing: async (_u, id) => ({ id }), markPublished: async () => null, markError: async () => null,
    markPaused: async () => null, resetErrorToDraft: async () => null, deleteListing: async () => null,
    scheduleListing: async () => null, unscheduleListing: async () => null, updateListingSettings: async () => null, updateListingStats: async () => null,
  },
  '../services/publishQueueService': { processOneQueuedListing: async () => processResult },
  '../models/usersModel': {
    hasCredits: async () => true,
    spendCredit: async () => { credits.spend += 1; return true; },
    refundCredit: async () => { credits.refund += 1; },
  },
};
const origLoad = Module._load;
Module._load = function (request, parent) {
  if (fakes[request] && parent && /routes.listings.js$/.test(parent.filename)) return fakes[request];
  return origLoad.apply(this, arguments);
};
const router = require('../routes/listings');
Module._load = origLoad;

const layer = router.stack.find((l) => l.route && l.route.path === '/:id/publish' && l.route.methods.post);
const handler = layer.route.stack[layer.route.stack.length - 1].handle;
const fakeRes = () => { const r = { statusCode: 200 }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };

(async () => {
  let res = fakeRes();
  await handler({ userId: 'u1', params: { id: 'l1' }, body: {} }, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.success, true);
  assert.deepStrictEqual(credits, { spend: 0, refund: 0 }, 'the route itself never charges');

  processResult = { id: 'l1', status: 'error', error_message: 'Item specifics: Brand is missing' };
  res = fakeRes();
  await handler({ userId: 'u1', params: { id: 'l1' }, body: {} }, res);
  assert.strictEqual(res.statusCode, 502);
  assert.strictEqual(res.body.success, false);
  assert.match(res.body.error, /Brand is missing/);
  console.log('instant publish tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
