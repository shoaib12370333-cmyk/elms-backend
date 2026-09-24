// Syncing messages / orders in the background: the button press answers at once (202), the page asks the status until the
// job is done, pressing again while it runs joins the running job, and a failed job says why.
const assert = require('assert');
const Module = require('module');
const { startJob, getJob } = require('../services/backgroundJobs');

const tick = () => new Promise((r) => setImmediate(r));

// ---- the runner ----
let release;
const gate = () => new Promise((resolve) => { release = resolve; });

// ---- the routes, with the slow work faked ----
let messageSyncs = 0;
let orderSyncs = [];
let orderSyncFails = false;
const query = (result) => { const q = { populate: () => q, select: () => q, lean: async () => result, catch: () => q, then: (f) => Promise.resolve(result).then(f) }; return q; };
const fakes = {
  '../models/conversationsModel': {
    listConversations: async () => [{ id: 'c1' }], countUnreadConversations: async () => 0, upsertConversation: async () => null, addInternalNote: async () => null,
    updateConversationState: async () => null, trashConversation: async () => null, restoreConversation: async () => null, getConversationById: async () => null,
    getConversationForThread: async () => null, markConversationRead: async () => null,
  },
  '../services/ebayBuyerProfileService': { PROFILE_TTL_MS: 1, ensureBuyerProfile: async () => null },
  '../services/messageAttachmentService': { saveMessageAttachment: async () => null, sanitizeAttachments: () => [] },
  '../models/schemas/EbayAccount': { findById: () => query(null) },
  '../models/messagesModel': { listMessages: async () => [], upsertMessages: async () => {} },
  '../models/ebayAccountsModel': {
    getEbayAccountRefreshToken: async () => 't',
    listEbayAccounts: async () => [{ id: 'a1', ebayUserId: 'store1' }, { id: 'a2', ebayUserId: 'store2' }],
    getEbayAccountById: async () => null,
  },
  '../services/ebayMessageService': { fetchConversationDetail: async () => ({}), sendMessage: async () => null, updateConversationStatus: async () => null },
  '../models/schemas/Order': { findOne: () => query(null) },
  '../models/schemas/Listing': { findOne: () => query(null) },
  '../jobs/conversationSync': { syncConversationsForUser: async () => { messageSyncs += 1; await gate(); return { synced: 3 }; } },
  '../models/ordersModel': { listOrders: async () => [{ id: 'o1' }], updateFulfillmentStatus: async () => null, upsertOrder: async () => null, getOrderById: async () => null, setTracking: async () => null, linkAmazonOrder: async () => null, setSellerNote: async () => null, setBuyPrice: async () => null, linkOrderToListing: async () => null },
  '../services/ebayOrdersService': { fetchOrderById: async () => null, normalizeOrderLineItems: () => [], createShippingFulfillment: async () => null },
  '../services/orderSyncService': { syncAccountOrders: async (userId, accountId, opts) => { orderSyncs.push([accountId, !!opts.full]); if (orderSyncFails && accountId === 'a2') throw new Error('eBay said no'); return { ordersFromEbay: 5, savedCount: 2 }; } },
  '../services/orderImageService': { backfillOrderImagesForUser: () => {}, fillMissingOrderImages: async () => {} },
  '../routes/fetchProduct': { fetchAndSaveDraft: async () => null },
  '../models/usersModel': { hasCredits: async () => true },
};
const origLoad = Module._load;
Module._load = function (request, parent) {
  if (fakes[request] && parent && /routes.(notifications|orders)\.js$/.test(parent.filename)) return fakes[request];
  return origLoad.apply(this, arguments);
};
const notifications = require('../routes/notifications');
const orders = require('../routes/orders');
Module._load = origLoad;

const handler = (router, method, p) => { const l = router.stack.find((x) => x.route && x.route.path === p && x.route.methods[method]); assert.ok(l, method + ' ' + p); return l.route.stack[l.route.stack.length - 1].handle; };
const fakeRes = () => { const r = { statusCode: 200 }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
const call = async (router, method, p, req) => { const res = fakeRes(); await handler(router, method, p)({ userId: 'u1', query: {}, body: {}, ...req }, res); return res; };

(async () => {
  // ---------- the runner ----------
  const g = gate();
  let r1 = startJob('k1', () => g.then(() => ({ n: 1 })));
  assert.strictEqual(r1.started, true);
  assert.strictEqual(r1.job.status, 'running');
  const r2 = startJob('k1', async () => ({ n: 2 }));
  assert.strictEqual(r2.started, false, 'the same job is joined, not started twice');
  assert.strictEqual(startJob('k2', async () => 'other').started, true, 'another key is another job');
  release();
  await tick(); await tick(); await tick();
  assert.deepStrictEqual({ status: getJob('k1').status, result: getJob('k1').result }, { status: 'done', result: { n: 1 } });
  assert.ok(getJob('k1').finishedAt >= getJob('k1').startedAt);
  assert.strictEqual(startJob('k1', async () => ({ n: 3 })).started, true, 'a finished job can be started again');
  await tick(); await tick(); await tick();
  assert.strictEqual(getJob('k1').result.n, 3);
  startJob('bad', async () => { throw new Error('eBay is down'); });
  await tick(); await tick(); await tick();
  assert.deepStrictEqual({ status: getJob('bad').status, error: getJob('bad').error }, { status: 'error', error: 'eBay is down' });
  assert.strictEqual(getJob('never started'), null);

  // ---------- messages ----------
  let res = await call(notifications, 'post', '/sync', { query: { background: '1' } });
  assert.strictEqual(res.statusCode, 202, 'answers at once, before the sync is done');
  assert.strictEqual(res.body.started, true);
  assert.strictEqual(res.body.job.status, 'running');
  res = await call(notifications, 'post', '/sync', { query: { background: '1' } });
  assert.strictEqual(res.body.started, false, 'pressing Sync again joins the running one');
  assert.strictEqual(messageSyncs, 1, 'one sync, not two');
  res = await call(notifications, 'get', '/sync-status', {});
  assert.strictEqual(res.body.job.status, 'running');
  release();
  await tick(); await tick(); await tick();
  res = await call(notifications, 'get', '/sync-status', {});
  assert.deepStrictEqual({ status: res.body.job.status, result: res.body.job.result }, { status: 'done', result: { synced: 3 } });
  res = await call(notifications, 'get', '/sync-status', { query: { accountId: 'a-other' } });
  assert.strictEqual(res.body.job, null, 'each store has its own job');
  res = await call(notifications, 'get', '/sync-status', { userId: 'someone-else' });
  assert.strictEqual(res.body.job, null, 'and each person');
  // without the flag it is the old, waiting kind
  messageSyncs = 0;
  const waiting = call(notifications, 'post', '/sync', {});
  await tick(); await tick();
  release();
  res = await waiting;
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.conversations.length, 1);
  // the status route is above GET /:id (or "sync-status" would be read as a conversation id)
  const nOrder = notifications.stack.filter((x) => x.route && x.route.methods.get).map((x) => x.route.path);
  assert.ok(nOrder.indexOf('/sync-status') < nOrder.indexOf('/:id'));

  // ---------- orders ----------
  res = await call(orders, 'post', '/sync', { query: { background: '1', full: '1' } });
  assert.strictEqual(res.statusCode, 202);
  await tick(); await tick(); await tick();
  assert.deepStrictEqual(orderSyncs, [['a1', true], ['a2', true]], 'every store, the full read when asked');
  res = await call(orders, 'get', '/sync-status', {});
  assert.deepStrictEqual(res.body.job.result, { syncedCount: 4, ordersFromEbay: 10, errors: [] });
  orderSyncs = []; orderSyncFails = true;
  await call(orders, 'post', '/sync', { query: { background: '1', accountId: 'a2' } });
  await tick(); await tick(); await tick();
  res = await call(orders, 'get', '/sync-status', { query: { accountId: 'a2' } });
  assert.strictEqual(res.body.job.status, 'done');
  assert.match(res.body.job.result.errors[0], /store2: eBay said no/, 'a store that failed is named');
  res = await call(orders, 'post', '/sync', { query: { background: '1', accountId: 'nope' } });
  assert.strictEqual(res.statusCode, 400, 'no such store: refused before anything starts');
  // the old way still answers with the orders
  orderSyncFails = false;
  res = await call(orders, 'post', '/sync', {});
  assert.strictEqual(res.body.success, true);
  assert.deepStrictEqual(res.body.orders, [{ id: 'o1' }]);
  const oOrder = orders.stack.filter((x) => x.route && x.route.methods.get).map((x) => x.route.path);
  assert.ok(oOrder.indexOf('/sync-status') < oOrder.indexOf('/:id'));

  console.log('background sync tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
