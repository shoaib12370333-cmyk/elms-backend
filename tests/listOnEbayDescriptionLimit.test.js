// routes/listOnEbay.js PUT /:id: rejects a description over DESCRIPTION_WORD_LIMIT words BEFORE any real work
// happens (no eBay account lookup, no DB write) - the same cap the editor's own live counter enforces client-side,
// kept here too since that check is bypassable (a direct API call, or any other caller of this route).
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

stub('middleware/requireAuth', { requireAuth: (req, res, next) => next() });
stub('services/ebayListingService', {});
stub('services/publishQueueService', {});
stub('services/ebayTaxonomyService', {});
stub('models/ebayAccountsModel', {});
stub('models/usersModel', {});
stub('config/actionCosts', { ACTION_COSTS: {} });
stub('services/skuService', {});
stub('models/importsModel', {});
stub('services/imageStorageService', {});

let updateListingCalls = 0;
stub('models/listingsModel', { updateListing: async () => { updateListingCalls += 1; return { id: 'l1' }; }, createListing: async () => null, markPublished: async () => null, markError: async () => null, claimListingForPublishing: async () => null });

const router = require('../routes/listOnEbay');
const routeHandler = (p, method) => {
  const l = router.stack.find((x) => x.route && x.route.path === p && x.route.methods[method]);
  assert.ok(l, `route ${method.toUpperCase()} ${p} exists`);
  return l.route.stack[l.route.stack.length - 1].handle;
};
const call = async (handler, { params = {}, body = {} } = {}) => {
  const out = { status: 200 };
  const res = { status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; } };
  await handler({ params, body, userId: 'u1' }, res);
  return out;
};

(async () => {
  const handler = routeHandler('/:id', 'put');
  const words = (n) => Array.from({ length: n }, () => 'word').join(' ');

  // ---------- over the limit: rejected, nothing saved ----------
  updateListingCalls = 0;
  let out = await call(handler, { params: { id: 'l1' }, body: { description: words(4001) } });
  assert.strictEqual(out.status, 400);
  assert.match(out.body.error, /4001 words/);
  assert.strictEqual(updateListingCalls, 0, 'rejected before updateListing is ever called');

  // ---------- exactly at the limit: allowed through ----------
  out = await call(handler, { params: { id: 'l1' }, body: { description: words(4000) } });
  assert.strictEqual(out.status, 200);
  assert.strictEqual(updateListingCalls, 1);

  // ---------- draftProduct.description wins over the top-level description field, same as what actually gets saved ----------
  updateListingCalls = 0;
  out = await call(handler, { params: { id: 'l1' }, body: { description: 'short', draftProduct: { description: words(4001) } } });
  assert.strictEqual(out.status, 400, 'the draftProduct description is the one that would actually be saved, so it is the one checked');
  assert.strictEqual(updateListingCalls, 0);

  // ---------- no description in the request at all (e.g. only sellPrice changed): never rejected ----------
  updateListingCalls = 0;
  out = await call(handler, { params: { id: 'l1' }, body: { sellPrice: 19.99 } });
  assert.strictEqual(out.status, 200);
  assert.strictEqual(updateListingCalls, 1);

  console.log('list-on-ebay description limit tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
