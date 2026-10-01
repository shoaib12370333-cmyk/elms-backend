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
let storeListingsByAccount = {}; // accountId -> breakdown (the per-store call)
stub('models/listingsModel', {
  listingStatusBreakdown: async (userId, accountId) => (accountId ? (storeListingsByAccount[accountId] || null) : (listingsById[userId] || null)),
});

let ordersById = {};
let netProfitById = {};
let storeOrdersByAccount = {}; // accountId -> orders summary (the per-store call)
stub('models/ordersModel', {
  ordersSummary: async (userId, accountId) => (accountId ? (storeOrdersByAccount[accountId] || null) : (ordersById[userId] || null)),
  netProfitSummary: async (userId) => netProfitById[userId] || null,
});

let accountsByUser = {}; // userId -> [serialized eBay accounts] (as ebayAccountsModel.listEbayAccounts would return)
stub('models/ebayAccountsModel', { listEbayAccounts: async (userId) => accountsByUser[userId] || [] });

let ticketsByUser = {}; // userId -> [serialized tickets]
stub('models/supportTicketsModel', {
  listAllTickets: async () => [],
  resolveTicket: async () => null,
  listTicketsForUser: async (userId) => ticketsByUser[userId] || [],
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
  const ACC1 = 'b'.repeat(24);
  const ACC2 = 'c'.repeat(24);
  accountsByUser[ID] = [
    { id: ACC1, ebayUserId: 'seller_uk', username: 'seller_uk', storeName: 'UK Deals', label: 'UK Deals', marketplaceId: 'EBAY_GB', isActive: true, financesSyncError: null, connected: true, disconnectedAt: null, createdAt: '2026-09-01T00:00:00.000Z' },
    { id: ACC2, ebayUserId: 'seller_us', username: 'seller_us', storeName: '', label: 'seller_us', marketplaceId: 'EBAY_US', isActive: false, financesSyncError: 'Invalid marketplace id.', connected: false, disconnectedAt: '2026-09-15T00:00:00.000Z', createdAt: '2026-08-01T00:00:00.000Z' },
  ];
  storeListingsByAccount[ACC1] = { draft: 1, publishing: 0, scheduled: 0, published: 6, paused: 0, error: 0, ended: 0, sold: 2 };
  storeListingsByAccount[ACC2] = { draft: 2, publishing: 0, scheduled: 0, published: 4, paused: 1, error: 2, ended: 0, sold: 2 };
  storeOrdersByAccount[ACC1] = { orders: 25, currencies: [{ currency: 'GBP', orders: 25, revenue: 800, profit: 150, profit_orders: 25 }] };
  storeOrdersByAccount[ACC2] = { orders: 15, currencies: [{ currency: 'USD', orders: 15, revenue: 434.5, profit: 150.25, profit_orders: 15 }] };
  ticketsByUser[ID] = [{ id: 't1', status: 'open' }, { id: 't2', status: 'resolved' }, { id: 't3', status: 'open' }];

  out = await call(handler, { query: { email: '  Buyer@Example.com  ' } });
  assert.strictEqual(out.status, 200, 'email is trimmed and lower-cased before the lookup');
  assert.strictEqual(out.body.user.id, ID);
  assert.strictEqual(out.body.user.name, 'Buyer One');
  assert.deepStrictEqual(out.body.listings, listingsById[ID]);
  assert.deepStrictEqual(out.body.orders, ordersById[ID]);
  assert.deepStrictEqual(out.body.netProfit, netProfitById[ID]);
  assert.strictEqual(enrichCalls[enrichCalls.length - 1][0].id, ID, 'enrichUsers is given the same serialized shape as the Users tab');

  // ---- per-store breakdown: every eBay account this user ever connected, even a disconnected one, with its own
  // listings/orders figures (not just the user-wide totals above) ----
  assert.strictEqual(out.body.stores.length, 2);
  const [s1, s2] = out.body.stores;
  assert.strictEqual(s1.id, ACC1);
  assert.strictEqual(s1.label, 'UK Deals');
  assert.strictEqual(s1.marketplaceId, 'EBAY_GB');
  assert.strictEqual(s1.connected, true);
  assert.deepStrictEqual(s1.listings, storeListingsByAccount[ACC1]);
  assert.strictEqual(s1.liveListings, 6 + 0 + 2, 'published + paused + sold for this store only');
  assert.deepStrictEqual(s1.orders, storeOrdersByAccount[ACC1]);
  assert.strictEqual(s2.connected, false, 'a disconnected store is still listed, not dropped');
  assert.strictEqual(s2.financesSyncError, 'Invalid marketplace id.', 'carries the reconnect-warning reason through too');
  assert.deepStrictEqual(s2.orders, storeOrdersByAccount[ACC2]);

  // ---- support tickets: a simple total/open count, reusing the customer's own listTicketsForUser ----
  assert.deepStrictEqual(out.body.tickets, { total: 3, open: 2 });

  console.log('admin user lookup: all good');
})().catch((err) => { console.error(err); process.exit(1); });
