// Admin -> Users: who is online / when they left, paid or free plan, last IP. Plus the pop-up messages and the appeal form.
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
const minutes = (n) => new Date(Date.now() - n * 60000);

// ---- enrichUsers
stub('models/schemas/Session', { aggregate: async () => [{ _id: 'u1', lastSeenAt: minutes(0.5) }, { _id: 'u2', lastSeenAt: minutes(42) }] });
stub('models/schemas/Purchase', { aggregate: async () => [{ _id: 'u2', totalUsd: 29.999, purchases: 2, credits: 300, lastAt: minutes(60 * 24) }] });
stub('models/schemas/LoginEvent', { aggregate: async () => [{ _id: 'u1', ip: '8.8.8.8', city: 'Lahore', country: 'Pakistan', at: minutes(30) }, { _id: 'u3', ip: '1.2.3.4', city: null, country: null, at: minutes(300) }] });
stub('models/schemas/EbayAccount', { aggregate: async () => [{ _id: 'u1', stores: 2, marketplaces: ['EBAY_GB', 'EBAY_US'] }, { _id: 'u2', stores: 1, marketplaces: ['EBAY_US', null] }] });
const { enrichUsers } = require('../services/adminUserStatsService');

// ---- notices and appeals
const notices = [];
let ticketMade = null;
let alerted = null;
const objectId = '64b7f0c2a1b2c3d4e5f60718';
stub('middleware/requireAuth', { requireAuth: (req, res, next) => next() });
stub('models/schemas/AdminNotice', {
  find: () => ({ sort() { return this; }, limit() { return this; }, lean: async () => notices.filter((n) => !n.seenBy.includes('me') && (!n.userId || n.userId === 'me')) }),
  updateOne: async (f, u) => { const n = notices.find((x) => String(x._id) === objectId); if (n) n.seenBy.push('me'); },
});
stub('models/schemas/SupportTicket', { create: async (d) => { ticketMade = d; return { ...d, toObject: () => d }; } });
stub('models/schemas/User', { findOne: () => ({ lean: async () => ({ _id: 'u9', name: 'Kim', suspendedAt: new Date(), suspendedReason: 'Fake orders' }) }) });
stub('services/supportAssistantService', { alertAdmin: async (t, o) => { alerted = { t, o }; } });
stub('models/schemas/Session', { aggregate: async () => [], updateOne: async () => ({}) });

const handler = (router, method, p) => { const l = router.stack.find((x) => x.route && x.route.path === p && x.route.methods[method]); assert.ok(l, method + ' ' + p); return l.route.stack[l.route.stack.length - 1].handle; };
const fakeRes = () => { const r = { statusCode: 200 }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };

(async () => {
  // online = pinged within 2.5 minutes; "left N minutes ago" otherwise; paid = has a completed purchase
  const { users, summary } = await enrichUsers([{ id: 'u1', email: 'a@x.com' }, { id: 'u2', email: 'b@x.com' }, { id: 'u3', email: 'c@x.com', suspendedAt: new Date() }, { id: 'u4', email: 'd@x.com' }]);
  const by = Object.fromEntries(users.map((u) => [u.id, u]));
  assert.strictEqual(by.u1.online, true);
  assert.strictEqual(by.u2.online, false);
  assert.ok(by.u2.minutesAgo >= 41 && by.u2.minutesAgo <= 43);
  assert.strictEqual(by.u3.online, false, 'last seen only from the sign-in 5 hours ago');
  assert.strictEqual(by.u3.minutesAgo, 300);
  assert.strictEqual(by.u4.lastSeenAt, null);
  // who has connected an eBay store, and how many
  assert.deepStrictEqual(by.u1.ebay, { connected: true, stores: 2, marketplaces: ['EBAY_GB', 'EBAY_US'] });
  assert.deepStrictEqual(by.u2.ebay, { connected: true, stores: 1, marketplaces: ['EBAY_US'] }, 'a missing marketplace is left out');
  assert.deepStrictEqual(by.u3.ebay, { connected: false, stores: 0, marketplaces: [] });
  assert.deepStrictEqual(by.u4.ebay, { connected: false, stores: 0, marketplaces: [] });
  assert.strictEqual(summary.ebayConnected, 2);
  assert.strictEqual(summary.ebayNotConnected, 2);
  assert.deepStrictEqual(by.u2.plan, { paid: true, totalUsd: 30, purchases: 2, credits: 300, lastPurchaseAt: by.u2.plan.lastPurchaseAt });
  assert.deepStrictEqual(by.u1.plan, { paid: false });
  assert.deepStrictEqual({ ip: by.u1.lastLogin.ip, place: by.u1.lastLogin.place }, { ip: '8.8.8.8', place: 'Lahore, Pakistan' });
  assert.strictEqual(by.u3.suspended, true);
  assert.deepStrictEqual(summary, { total: 4, online: 1, paid: 1, free: 3, suspended: 1, ebayConnected: 2, ebayNotConnected: 2 });

  // pop-up messages: pending ones come back, OK marks it seen
  notices.push({ _id: objectId, kind: 'offer', title: 'Just for you', body: '20% more credits this week', createdAt: new Date(), userId: 'me', seenBy: [] });
  const noticesRouter = require('../routes/notices');
  let res = fakeRes();
  await handler(noticesRouter, 'get', '/pending')({ userId: 'me' }, res);
  assert.deepStrictEqual(res.body.notices.map((n) => n.title), ['Just for you']);
  res = fakeRes();
  await handler(noticesRouter, 'post', '/:id/seen')({ userId: 'me', params: { id: objectId } }, res);
  res = fakeRes();
  await handler(noticesRouter, 'get', '/pending')({ userId: 'me' }, res);
  assert.deepStrictEqual(res.body.notices, []);
  res = fakeRes();
  await handler(noticesRouter, 'post', '/:id/seen')({ userId: 'me', params: { id: 'nope' } }, res);
  assert.strictEqual(res.statusCode, 404);

  // appeal: needs an email and a message, becomes an urgent-looking escalated ticket, the admin is alerted, the assistant never answers it
  const appealRouter = require('../routes/appeals');
  const appeal = handler(appealRouter, 'post', '/');
  res = fakeRes();
  await appeal({ body: { email: 'not-an-email', message: 'please help me' }, headers: {}, ip: '5.5.5.5' }, res);
  assert.strictEqual(res.statusCode, 400);
  res = fakeRes();
  await appeal({ body: { email: 'kim@x.com', message: 'ok' }, headers: {}, ip: '5.5.5.5' }, res);
  assert.strictEqual(res.statusCode, 400);
  res = fakeRes();
  await appeal({ body: { email: 'Kim@X.com', message: 'I am not a fraud, my brother used the same wifi.' }, headers: {}, ip: '5.5.5.5' }, res);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(ticketMade.source, 'appeal');
  assert.strictEqual(ticketMade.fromEmail, 'kim@x.com');
  assert.strictEqual(ticketMade.escalated, true);
  assert.match(ticketMade.message, /5\.5\.5\.5/);
  assert.match(ticketMade.message, /Fake orders/);
  assert.ok(alerted && alerted.o.reason);
  console.log('admin overview tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
