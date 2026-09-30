// Admin -> "User Lookup": one user's whole picture by email - profile, listing status counts, orders and net profit,
// reusing the same aggregates the seller's own Orders / Net Profit pages use.
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

stub('middleware/requireAuth', { requireAuth: (req, res, next) => next() });
stub('middleware/requireAdmin', { requireAdmin: (req, res, next) => next(), requireSuperAdmin: (req, res, next) => next() });

let users = {}; // email -> { _id }
stub('models/schemas/User', {
  findOne: (query) => ({ lean: async () => users[query.email] || null }),
  find: () => ({ lean: async () => [] }),
});

let byId = {}; // id -> serialized user (as usersModel.getUserById would return)
stub('models/usersModel', {
  listAllUsers: async () => [],
  getUserById: async (id) => byId[id] || null,
  setCreditBalance: async () => null,
  setStockCheckInterval: async () => null,
  setMaxEbayAccounts: async () => null,
});

let enrichCalls = [];
stub('services/adminUserStatsService', {
  enrichUsers: async (list) => { enrichCalls.push(list); return { users: list.map((u) => ({ ...u, online: false, plan: { paid: false }, ebay: { connected: false, stores: 0, marketplaces: [] } })), summary: {} }; },
});

let listingsById = {}; // id -> breakdown
stub('models/listingsModel', { listingStatusBreakdown: async (userId) => listingsById[userId] || null });

let ordersById = {};
let netProfitById = {};
stub('models/ordersModel', {
  ordersSummary: async (userId) => ordersById[userId] || null,
  netProfitSummary: async (userId) => netProfitById[userId] || null,
});

const router = require('../routes/admin');
const routeHandler = (p, method) => {
  const l = router.stack.find((x) => x.route && x.route.path === p && x.route.methods[method]);
  assert.ok(l, `route ${method.toUpperCase()} ${p} exists`);
  return l.route.stack[l.route.stack.length - 1].handle;
};
const call = async (handler, { query = {} } = {}) => {
  const out = { status: 200 };
  const res = { status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; } };
  await handler({ query }, res);
  return out;
};

(async () => {
  const handler = routeHandler('/user-lookup', 'get');

  // ---- validation ----
  let out = await call(handler, { query: {} });
  assert.strictEqual(out.status, 400, 'no email');
  out = await call(handler, { query: { email: 'not-an-email' } });
  assert.strictEqual(out.status, 400, 'not a valid email');
  out = await call(handler, { query: { email: 'nobody@example.com' } });
  assert.strictEqual(out.status, 404, 'no such user');

  // ---- happy path ----
  const ID = 'a'.repeat(24);
  users['buyer@example.com'] = { _id: ID };
  byId[ID] = { id: ID, name: 'Buyer One', email: 'buyer@example.com', creditBalance: 120, role: 'user' };
  listingsById[ID] = { draft: 3, publishing: 0, scheduled: 0, published: 10, paused: 1, error: 2, ended: 0, sold: 4 };
  ordersById[ID] = { orders: 40, currencies: [{ currency: 'USD', orders: 40, revenue: 1234.5, profit: 300.25, profit_orders: 40 }] };
  netProfitById[ID] = { currencies: [{ currency: 'USD', net_profit: 210.75, orders: 38 }], orders: 38, ordersTotal: 40 };

  out = await call(handler, { query: { email: '  Buyer@Example.com  ' } });
  assert.strictEqual(out.status, 200, 'email is trimmed and lower-cased before the lookup');
  assert.strictEqual(out.body.user.id, ID);
  assert.strictEqual(out.body.user.name, 'Buyer One');
  assert.deepStrictEqual(out.body.listings, listingsById[ID]);
  assert.deepStrictEqual(out.body.orders, ordersById[ID]);
  assert.deepStrictEqual(out.body.netProfit, netProfitById[ID]);
  assert.strictEqual(enrichCalls[enrichCalls.length - 1][0].id, ID, 'enrichUsers is given the same serialized shape as the Users tab');

  console.log('admin user lookup: all good');
})().catch((err) => { console.error(err); process.exit(1); });
