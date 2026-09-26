// Suspended accounts and blocked IPs: who is refused, who is let through (admins, accounts the admin chose to
// keep), how a block is created, and that a signed-in user is cut off on the next request.
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
process.env.JWT_SECRET = 'test-secret';

// ---- a tiny in-memory database for the calls the services make
const db = { users: new Map(), sessions: [], events: [], blocks: [], listings: [] };
const oid = (n) => 'aaaaaaaaaaaaaaaaaaaa000' + n; // 24-char ids
const lean = (v) => ({ lean: async () => v, sort() { return this; }, limit() { return this; } });

stub('models/schemas/User', {
  findById: (id) => lean(db.users.get(String(id)) || null),
  findOne: () => lean(null),
  find: (filter) => lean([...db.users.values()].filter((u) => {
    if (filter && filter.role) return u.role === filter.role;
    if (filter && filter._id && filter._id.$in) return filter._id.$in.map(String).includes(String(u._id));
    return true;
  })),
  updateOne: async ({ _id }, update) => { Object.assign(db.users.get(String(_id)) || {}, update.$set || {}); return { matchedCount: db.users.has(String(_id)) ? 1 : 0 }; },
  exists: async () => null,
});
stub('models/schemas/Session', {
  findOne: ({ sid }) => lean(db.sessions.find((s) => s.sid === sid) || null),
  find: (f) => lean(db.sessions.filter((s) => (!f.ip || s.ip === f.ip) && (f.revokedAt === undefined || s.revokedAt === f.revokedAt))),
  updateOne: async () => ({}),
  updateMany: async (f, update) => { db.sessions.filter((s) => String(s.userId) === String(f.userId) && !s.revokedAt && (!f.ip || s.ip === f.ip)).forEach((s) => Object.assign(s, update.$set)); },
  create: async (d) => { db.sessions.push(d); return d; },
});
require.cache[require.resolve('../models/schemas/Session')].exports.find = (f) => (f.deviceId !== undefined ? lean([]) : lean(db.sessions.filter((s) => (!f.ip || s.ip === f.ip) && (f.revokedAt === undefined || s.revokedAt === f.revokedAt))));
stub('models/schemas/LoginEvent', {
  exists: async () => null, create: async (d) => { db.events.push(d); return d; }, updateOne: async () => ({}),
  aggregate: async () => {
    const byUser = new Map();
    db.events.filter((e) => e.success !== false).forEach((e) => { const r = byUser.get(e.userId) || { _id: e.userId, lastAt: e.createdAt, logins: 0, deviceIds: [] }; r.logins += 1; byUser.set(e.userId, r); });
    return [...byUser.values()];
  },
  find: () => lean(db.events),
});
stub('models/schemas/Listing', { updateMany: async (f, u) => { db.listings.filter((l) => l.userId === f.userId && l.status === f.status).forEach((l) => Object.assign(l, u.$set)); } });
stub('models/systemNotificationsModel', { createSystemNotification: async () => ({}) });

const now = () => new Date();
const activeAt = (b, ip, device) => b.active && (!b.expiresAt || b.expiresAt > now()) && (b.ip === ip || (device && b.deviceIds.includes(device)));
stub('models/schemas/IpBlock', {
  findOne: (q) => {
    const or = q.$and[1].$or;
    const ip = (or.find((c) => c.ip) || {}).ip;
    const device = (or.find((c) => c.deviceIds) || {}).deviceIds;
    return lean(db.blocks.find((b) => activeAt(b, ip, device)) || null);
  },
  exists: async (q) => (db.blocks.find((b) => b.ip === q.ip && b.active) ? { _id: 1 } : null),
  create: async (d) => { const doc = { _id: 'blk' + (db.blocks.length + 1), active: true, ...d }; db.blocks.push(doc); return { ...doc, toObject: () => doc }; },
  updateOne: async ({ _id }, u) => { Object.assign(db.blocks.find((b) => b._id === _id), u.$set); },
  findOneAndUpdate: (q, u) => ({ lean: async () => { const b = db.blocks.find((x) => x._id === q._id && x.active); if (b) Object.assign(b, u.$set); return b || null; } }),
  find: () => lean(db.blocks.filter((b) => b.active)),
});

// suspending / reinstating also closes appeals and mails the person; both are covered in banAppeals.test.js
stub('models/schemas/SupportTicket', { updateMany: async () => ({}) });
stub('services/emailService', { sendAccountActionEmail: async () => ({}) });

const guard = require('../services/accessGuard');
const tracker = require('../services/sessionTracker');
const svc = require('../services/accessAdminService');

const ADMIN = oid(1); const FRAUD = oid(2); const REGULAR = oid(3); const NEWBIE = oid(4);
const seed = () => {
  db.users.clear(); db.sessions.length = 0; db.events.length = 0; db.blocks.length = 0; db.listings.length = 0;
  db.users.set(ADMIN, { _id: ADMIN, role: 'admin', email: 'admin@x.com' });
  db.users.set(FRAUD, { _id: FRAUD, role: 'user', email: 'fraud@x.com', createdAt: new Date() });
  db.users.set(REGULAR, { _id: REGULAR, role: 'user', email: 'regular@x.com', createdAt: new Date() });
  db.users.set(NEWBIE, { _id: NEWBIE, role: 'user', email: 'newbie@x.com', createdAt: new Date() });
  guard.invalidate();
};
const login = (userId, ip, deviceId = 'dev-' + userId.slice(-1) + '-abcdefgh') => db.events.push({ userId, ip, deviceId, success: true, createdAt: new Date() });

(async () => {
  // ---- addresses
  assert.strictEqual(svc.normalizeIp(' ::FFFF:8.8.8.8 '), '8.8.8.8');
  for (const bad of ['', 'abc', '999.1.1.1', '10.0.0.5', '192.168.1.1', '127.0.0.1', '::1']) assert.throws(() => svc.normalizeIp(bad), (e) => e.statusCode === 400, bad);
  assert.strictEqual(svc.normalizeIp('2001:db8::1'), '2001:db8::1');

  // ---- a suspended account is refused with the reason, an admin never is
  seed();
  db.users.get(FRAUD).suspendedAt = new Date(); db.users.get(FRAUD).suspendedReason = 'Fake orders.';
  let denied = await guard.checkAccess({ user: db.users.get(FRAUD), ip: '1.1.1.1' });
  assert.strictEqual(denied.kind, 'account');
  assert.match(denied.reason, /Fake orders\./);
  assert.match(denied.reason, /appeal/i);
  assert.strictEqual(await guard.checkAccess({ user: db.users.get(ADMIN), ip: '1.1.1.1' }), null);
  assert.strictEqual(await guard.checkAccess({ user: db.users.get(REGULAR), ip: '1.1.1.1' }), null);

  // ---- blocking an IP: the shared address does not ban the regular account
  seed();
  login(FRAUD, '5.5.5.5'); login(REGULAR, '5.5.5.5'); login(ADMIN, '5.5.5.5');
  db.sessions.push({ sid: 's-fraud', userId: FRAUD, ip: '5.5.5.5', revokedAt: null }, { sid: 's-reg', userId: REGULAR, ip: '5.5.5.5', revokedAt: null }, { sid: 's-adm', userId: ADMIN, ip: '5.5.5.5', revokedAt: null });
  db.listings.push({ userId: FRAUD, status: 'scheduled', scheduledAt: new Date() });
  const seen = await svc.accountsSeenOnIp('5.5.5.5');
  assert.deepStrictEqual(seen.map((a) => a.email).sort(), ['admin@x.com', 'fraud@x.com', 'regular@x.com']);

  await assert.rejects(() => svc.createIpBlock({ ip: '5.5.5.5', reason: 'x', adminId: ADMIN }), /reason/);
  await assert.rejects(() => svc.createIpBlock({ ip: '10.0.0.1', reason: 'Fraud ring', adminId: ADMIN }), /private/);
  const out = await svc.createIpBlock({ ip: '5.5.5.5', reason: 'Fraudulent orders from this connection.', note: 'seen 3 chargebacks', days: 7, suspendUserIds: [FRAUD], adminId: ADMIN });
  assert.strictEqual(out.suspended, 1);
  assert.strictEqual(out.allowed, 1, 'the regular account is let through');
  assert.strictEqual(out.signedOut, 0, 'the fraud account was already signed out by the suspension; the regular one and the admin stay');
  assert.ok(db.blocks[0].expiresAt > now());
  assert.strictEqual(db.sessions.find((s) => s.sid === 's-fraud').revokedAt instanceof Date, true);
  assert.strictEqual(db.sessions.find((s) => s.sid === 's-reg').revokedAt, null);
  assert.strictEqual(db.sessions.find((s) => s.sid === 's-adm').revokedAt, null);
  assert.strictEqual(db.listings[0].status, 'draft', 'scheduled listings of a suspended seller are unscheduled');
  assert.ok(db.users.get(FRAUD).suspendedAt);
  await assert.rejects(() => svc.createIpBlock({ ip: '5.5.5.5', reason: 'again', adminId: ADMIN }), (e) => e.statusCode === 409);

  guard.invalidate();
  // on that IP: the fraud account (suspended), a brand-new account, and the browser of a blocked device are refused; the regular account and the admin are not
  assert.strictEqual((await guard.checkAccess({ user: db.users.get(FRAUD), ip: '5.5.5.5' })).kind, 'account');
  const newbie = await guard.checkAccess({ user: db.users.get(NEWBIE), ip: '5.5.5.5' });
  assert.strictEqual(newbie.kind, 'ip');
  assert.match(newbie.reason, /Fraudulent orders/);
  assert.strictEqual(await guard.checkAccess({ user: db.users.get(REGULAR), ip: '5.5.5.5' }), null);
  assert.strictEqual(await guard.checkAccess({ user: db.users.get(ADMIN), ip: '5.5.5.5' }), null);
  assert.strictEqual(await guard.checkAccess({ user: db.users.get(NEWBIE), ip: '6.6.6.6' }), null, 'another address is fine');
  assert.strictEqual((await guard.checkNewAccount({ ip: '5.5.5.5' })).kind, 'ip', 'nobody new can register from it');
  assert.strictEqual(await guard.checkNewAccount({ ip: '6.6.6.6' }), null);

  // ---- sign-in and later requests
  const req = (ip, device) => ({ headers: { 'user-agent': 'Mozilla/5.0 Chrome/120', 'x-device-id': device || 'device-newbie-1234' }, ip });
  await assert.rejects(() => tracker.startSession(req('5.5.5.5'), NEWBIE), (e) => e.statusCode === 403 && e.blocked && e.blocked.kind === 'ip');
  await assert.rejects(() => tracker.startSession(req('5.5.5.5'), FRAUD), (e) => e.blocked && e.blocked.kind === 'account');
  assert.ok(await tracker.startSession(req('5.5.5.5'), REGULAR), 'the regular account can still sign in from that IP');
  assert.ok(await tracker.startSession(req('5.5.5.5'), ADMIN));
  assert.ok(await tracker.startSession(req('6.6.6.6'), NEWBIE), 'and the new account from another network');

  // an already signed-in user is cut off on their next request
  const t = Math.floor(Date.now() / 1000);
  db.sessions.push({ sid: 's-new', userId: NEWBIE, ip: '6.6.6.6', revokedAt: null });
  tracker.forgetCache(null, null);
  await tracker.assertSessionActive({ userId: NEWBIE, sid: 's-new', iat: t }, { ip: '6.6.6.6', deviceId: 'x' });
  await assert.rejects(() => tracker.assertSessionActive({ userId: NEWBIE, sid: 's-new', iat: t }, { ip: '5.5.5.5', deviceId: 'x' }), (e) => e.statusCode === 403 && e.blocked.kind === 'ip');
  db.users.get(NEWBIE).suspendedAt = new Date(); db.users.get(NEWBIE).suspendedReason = 'Abuse';
  tracker.forgetCache(null, null); guard.invalidate();
  await assert.rejects(() => tracker.assertSessionActive({ userId: NEWBIE, sid: 's-new', iat: t }, { ip: '6.6.6.6', deviceId: 'x' }), (e) => e.blocked.kind === 'account' && /Abuse/.test(e.message));

  // ---- lifting the block (and reinstating the suspended account)
  const id = db.blocks[0]._id;
  const lifted = await svc.liftIpBlock(id, { adminId: ADMIN, reinstate: true });
  assert.strictEqual(lifted.active, false);
  assert.strictEqual(db.users.get(FRAUD).suspendedAt, null);
  guard.invalidate();
  assert.strictEqual(await guard.checkAccess({ user: db.users.get(FRAUD), ip: '5.5.5.5' }), null);
  await assert.rejects(() => svc.liftIpBlock(id, { adminId: ADMIN }), (e) => e.statusCode === 404);

  // ---- a browser block follows the browser to another IP, but the shared fallback id never blocks anyone
  seed();
  db.blocks.push({ _id: 'b9', active: true, ip: '7.7.7.7', deviceIds: ['device-abuser-99'], reason: 'Same browser', exemptUserIds: [], expiresAt: null });
  guard.invalidate();
  assert.strictEqual((await guard.checkAccess({ user: db.users.get(NEWBIE), ip: '8.8.4.4', deviceId: 'device-abuser-99' })).kind, 'ip');
  assert.strictEqual(await guard.checkAccess({ user: db.users.get(NEWBIE), ip: '8.8.4.4', deviceId: 'device-other-12345' }), null);
  assert.strictEqual(guard.usableDeviceId('ua-abcdef123456'), null);

  // ---- an expired block does nothing
  seed();
  db.blocks.push({ _id: 'b10', active: true, ip: '9.9.9.9', deviceIds: [], reason: 'Old', exemptUserIds: [], expiresAt: new Date(Date.now() - 1000) });
  guard.invalidate();
  assert.strictEqual(await guard.checkAccess({ user: db.users.get(NEWBIE), ip: '9.9.9.9' }), null);

  // ---- an admin account cannot be suspended
  await assert.rejects(() => svc.suspendUser({ userId: ADMIN, reason: 'no way', adminId: ADMIN }), /admin account/i);
  console.log('access control tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
