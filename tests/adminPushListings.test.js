// Admin -> Users -> "Push listings": pushes N random ready-to-list drafts straight into one user's Drafts, free, no
// Easyparser/Canopy call (services/listingCloneService.js). Also covers the "Buy Listings" tier CRUD the same tab manages.
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

stub('middleware/requireAuth', { requireAuth: (req, res, next) => next() });
stub('middleware/requireAdmin', { requireAdmin: (req, res, next) => next(), requireSuperAdmin: (req, res, next) => next() });

let users = {};
stub('models/schemas/User', {
  findById: (id) => ({ lean: async () => users[id] || null }),
  find: () => ({ lean: async () => [] }),
});

let pushCalls = [];
let pushResult = { requested: 0, poolSize: 0, pushed: 0 };
stub('services/listingCloneService', { pushRandomListings: async (args) => { pushCalls.push(args); return pushResult; } });

let tiers = [];
stub('models/listingPackTiersModel', {
  listAllTiers: async () => tiers,
  createTier: async ({ name, priceUsd, listingCount }) => { const t = { id: 't' + (tiers.length + 1), name, priceUsd, listingCount, active: true }; tiers.push(t); return t; },
  updateTier: async (id, fields) => { const t = tiers.find((x) => x.id === id); if (!t) return null; Object.assign(t, fields); return t; },
  deleteTier: async (id) => { const before = tiers.length; tiers = tiers.filter((x) => x.id !== id); return tiers.length < before; },
});

const router = require('../routes/admin');
const routeHandler = (methodPath, method) => {
  const l = router.stack.find((x) => x.route && x.route.path === methodPath && x.route.methods[method]);
  assert.ok(l, `route ${method.toUpperCase()} ${methodPath} exists`);
  return l.route.stack[l.route.stack.length - 1].handle;
};
const call = async (handler, { params = {}, body = {} } = {}) => {
  const out = { status: 200 };
  const res = { status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; } };
  await handler({ params, body }, res);
  return out;
};

(async () => {
  const ID = 'a'.repeat(24);
  users[ID] = { _id: ID };
  const pushHandler = routeHandler('/users/:id/push-listings', 'post');

  // ---- validation ----
  let out = await call(pushHandler, { params: { id: ID }, body: {} });
  assert.strictEqual(out.status, 400, 'no count: rejected');
  out = await call(pushHandler, { params: { id: ID }, body: { count: 0 } });
  assert.strictEqual(out.status, 400, 'zero: rejected');
  out = await call(pushHandler, { params: { id: ID }, body: { count: 5.5 } });
  assert.strictEqual(out.status, 400, 'not a whole number: rejected');
  out = await call(pushHandler, { params: { id: ID }, body: { count: 5001 } });
  assert.strictEqual(out.status, 400, 'over the 5,000 cap: rejected');
  out = await call(pushHandler, { params: { id: 'not-an-id' }, body: { count: 5 } });
  assert.strictEqual(out.status, 404, 'not a valid id');
  out = await call(pushHandler, { params: { id: 'b'.repeat(24) }, body: { count: 5 } });
  assert.strictEqual(out.status, 404, 'no such user');

  // ---- happy path: the count and target user id are passed straight through, the service's numbers come back to the admin ----
  pushResult = { requested: 500, poolSize: 4000, pushed: 480 };
  out = await call(pushHandler, { params: { id: ID }, body: { count: 500 } });
  assert.strictEqual(out.status, 200);
  assert.strictEqual(out.body.pushed, 480);
  assert.strictEqual(out.body.poolSize, 4000);
  assert.deepStrictEqual(pushCalls[pushCalls.length - 1], { targetUserId: ID, count: 500, sourceCountry: null }, 'no sourceCountry given: any Amazon site, as before');

  // ---- sourceCountry: narrows which Amazon site the pool is drawn from, so a UK-focused store is never pushed US products ----
  out = await call(pushHandler, { params: { id: ID }, body: { count: 5, sourceCountry: 'uk' } });
  assert.strictEqual(out.status, 200, 'lower-case is accepted');
  assert.deepStrictEqual(pushCalls[pushCalls.length - 1], { targetUserId: ID, count: 5, sourceCountry: 'UK' });
  out = await call(pushHandler, { params: { id: ID }, body: { count: 5, sourceCountry: 'FR' } });
  assert.deepStrictEqual(pushCalls[pushCalls.length - 1], { targetUserId: ID, count: 5, sourceCountry: 'FR' });
  out = await call(pushHandler, { params: { id: ID }, body: { count: 5, sourceCountry: 'Mars' } });
  assert.strictEqual(out.status, 400, 'not one of the known Amazon sites: rejected');

  // ---- Buy Listings tier CRUD (the same admin tab) ----
  const listHandler = routeHandler('/listing-pack-tiers', 'get');
  const createHandler = routeHandler('/listing-pack-tiers', 'post');
  const updateHandler = routeHandler('/listing-pack-tiers/:id', 'put');
  const deleteHandler = routeHandler('/listing-pack-tiers/:id', 'delete');

  out = await call(createHandler, { body: { name: '', priceUsd: 10, listingCount: 1000 } });
  assert.strictEqual(out.status, 400, 'a name is required');
  out = await call(createHandler, { body: { name: '1,000 listings', priceUsd: 0.1, listingCount: 1000 } });
  assert.strictEqual(out.status, 400, 'below the $0.50 CashTap minimum');

  out = await call(createHandler, { body: { name: '1,000 listings', priceUsd: 10, listingCount: 1000 } });
  assert.strictEqual(out.status, 200);
  assert.strictEqual(out.body.tier.listingCount, 1000);
  const tierId = out.body.tier.id;

  out = await call(listHandler);
  assert.strictEqual(out.body.tiers.length, 1);

  out = await call(updateHandler, { params: { id: tierId }, body: { active: false } });
  assert.strictEqual(out.status, 200);
  assert.strictEqual(out.body.tier.active, false);
  out = await call(updateHandler, { params: { id: 'missing' }, body: { active: true } });
  assert.strictEqual(out.status, 404);

  out = await call(deleteHandler, { params: { id: tierId } });
  assert.strictEqual(out.status, 200);
  out = await call(listHandler);
  assert.strictEqual(out.body.tiers.length, 0);
  out = await call(deleteHandler, { params: { id: tierId } });
  assert.strictEqual(out.status, 404, 'already deleted');

  console.log('admin push-listings + listing-pack tiers: all good');
})().catch((err) => { console.error(err); process.exit(1); });
