// Regression test for PUT /api/list-on-ebay/:id ("Save draft"): unlike every other route in
// this file, it had no try/catch at all, so any thrown error (e.g. a malformed accountId,
// which Mongoose's findOne({_id}) throws a CastError for) fell through to the server's
// global handler and showed the generic "Something went wrong on our end" instead of a real
// message. This calls the route handler directly (no HTTP server needed).
const assert = require('assert');
const Module = require('module');

let updateListingCalls = [];
// Indirection: routes/listOnEbay.js destructures `updateListing` once at its own require
// time, so reassigning fakes[...].updateListing afterwards would be a no-op on that already-
// captured reference - this stable wrapper instead reads the current updateListingImpl on
// every call, so the test can change behavior between cases.
let updateListingImpl = async (_u, id, fields) => { updateListingCalls.push(fields); return { id, import_id: null, ...fields }; };
const fakes = {
  '../models/listingsModel': {
    createListing: async () => null, updateListingSettings: async () => null,
    markPublished: async () => null, markError: async () => null, claimListingForPublishing: async () => null,
    updateListing: (...args) => updateListingImpl(...args),
  },
  '../models/ebayAccountsModel': {
    listEbayAccounts: async () => [], getActiveEbayAccount: async () => null, getEbayAccountRefreshToken: async () => null,
    getEbayAccountById: async (_u, id) => (id === '64b7f0c2a1b2c3d4e5f60718' ? { id: '64b7f0c2a1b2c3d4e5f60718', marketplaceId: 'EBAY_GB' } : null),
  },
  '../models/importsModel': { getImportById: async () => null, updateImportProduct: async () => null },
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (fakes[request] && parent && /routes[\\/]listOnEbay\.js/.test(parent.filename)) return fakes[request];
  return origLoad.apply(this, arguments);
};
const router = require('../routes/listOnEbay');
Module._load = origLoad;

function findHandler(method, path) {
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`No ${method.toUpperCase()} ${path} route registered.`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
function fakeRes() {
  const res = { statusCode: 200 };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

(async () => {
  const handler = findHandler('put', '/:id');

  // A malformed accountId used to crash all the way to the generic 500 - now a clean 400.
  let res = fakeRes();
  await handler({ userId: 'u1', params: { id: 'l1' }, body: { sellPrice: 10, categoryId: '9355', accountId: 'not-a-real-id' } }, res);
  assert.strictEqual(res.statusCode, 400);
  assert.ok(/valid eBay account/i.test(res.body.error));
  assert.strictEqual(updateListingCalls.length, 0, 'never reached updateListing');

  // A normal save (re-selecting the same UK category, valid account) still works.
  updateListingCalls = [];
  res = fakeRes();
  await handler({ userId: 'u1', params: { id: 'l1' }, body: { sellPrice: 10, categoryId: '9355', accountId: '64b7f0c2a1b2c3d4e5f60718' } }, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(updateListingCalls[0].categoryId, '9355');
  assert.strictEqual(updateListingCalls[0].marketplaceId, 'EBAY_GB');

  // The editor sends item specifics and bullets at the top level (no draftProduct). They used to be
  // dropped, so filled-in specifics were never saved and the publish then failed on "required specifics empty".
  updateListingCalls = [];
  res = fakeRes();
  await handler({ userId: 'u1', params: { id: 'l1' }, body: { title: 'T title', ebayAspects: { Color: ['Black'] }, bulletPoints: ['One', 'Two'], specifications: [{ name: 'A', value: 'b' }] } }, res);
  assert.strictEqual(res.body.success, true);
  assert.deepStrictEqual(updateListingCalls[0].ebayAspects, { Color: ['Black'] });
  assert.deepStrictEqual(updateListingCalls[0].bulletPoints, ['One', 'Two']);
  assert.deepStrictEqual(updateListingCalls[0].specifications, [{ name: 'A', value: 'b' }]);

  // The Price Calculator page saves a price with only the cost beside it: the margin is stored, nothing else is touched.
  updateListingCalls = [];
  res = fakeRes();
  await handler({ userId: 'u1', params: { id: 'l1' }, body: { sellPrice: 13.05, markupPercent: 63.13, amazonPrice: 8 } }, res);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(updateListingCalls[0].sellPrice, 13.05);
  assert.strictEqual(updateListingCalls[0].amazonPrice, 8);
  assert.strictEqual(updateListingCalls[0].marginAmount, 5.05);
  assert.strictEqual(updateListingCalls[0].title, undefined, 'title and the rest are left alone');
  res = fakeRes();
  await handler({ userId: 'u1', params: { id: 'l1' }, body: { sellPrice: 13.05, amazonPrice: -3 } }, res);
  assert.strictEqual(res.statusCode, 400);
  // A full save still takes the cost from the edited product
  updateListingCalls = [];
  res = fakeRes();
  await handler({ userId: 'u1', params: { id: 'l1' }, body: { sellPrice: 12, draftProduct: { price: 7.5, title: 'T' } } }, res);
  assert.strictEqual(updateListingCalls[0].marginAmount, 4.5);

  // The draft editor: a draft whose product has no price gets the cost typed in the editor, so its margin is stored too.
  updateListingCalls = [];
  res = fakeRes();
  await handler({ userId: 'u1', params: { id: 'l1' }, body: { sellPrice: 15.98, amazonPrice: 9.99, draftProduct: { price: null, title: 'T' } } }, res);
  assert.strictEqual(updateListingCalls[0].amazonPrice, 9.99);
  assert.strictEqual(updateListingCalls[0].marginAmount, 5.99);

  // An unrelated error thrown deeper (e.g. from updateListing) is now caught and reported
  // cleanly too, instead of the generic 500.
  updateListingImpl = async () => { throw new Error('eBay does not recognise category 9355 on EBAY_GB.'); };
  res = fakeRes();
  await handler({ userId: 'u1', params: { id: 'l1' }, body: { sellPrice: 10, categoryId: '9355', accountId: '64b7f0c2a1b2c3d4e5f60718' } }, res);
  assert.strictEqual(res.body.success, false);
  assert.ok(/does not recognise category/.test(res.body.error));

  console.log('draft save tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
