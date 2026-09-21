const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

// In-memory stand-ins for the three collections the session checks read.
const db = { users: new Map(), sessions: new Map(), events: [] };
const q = (v) => ({ lean: async () => v });
stub('models/schemas/User', { findById: (id) => q(db.users.get(String(id)) || null), findOne: () => q(null), updateOne: async () => ({}) });
stub('models/schemas/Session', {
  findOne: ({ sid }) => q(db.sessions.get(sid) || null),
  updateOne: async () => ({}), create: async (d) => { db.sessions.set(d.sid, d); return d; },
});
stub('models/schemas/LoginEvent', {
  exists: async (f) => db.events.some((e) => e.userId === f.userId && e.success === f.success && (!f.deviceId || e.deviceId === f.deviceId)),
  create: async (d) => { db.events.push(d); return d; }, updateOne: async () => ({}),
});
stub('models/systemNotificationsModel', { createSystemNotification: async () => ({}) });
process.env.JWT_SECRET = 'test-secret';

const tracker = require('../services/sessionTracker');
const { issueSessionToken, verifySessionPayload } = require('../services/sessionService');
const { parseUserAgent } = require('../services/deviceInfoService');

(async () => {
  // the token carries the session id
  const t = issueSessionToken('u1', 'sid-1');
  assert.strictEqual(verifySessionPayload(t).sid, 'sid-1');
  assert.strictEqual(verifySessionPayload(issueSessionToken('u1')).sid, null); // older tokens have none

  const now = Math.floor(Date.now() / 1000);
  db.users.set('u1', { sessionsValidFrom: null });
  db.sessions.set('sid-1', { sid: 'sid-1', revokedAt: null });

  await tracker.assertSessionActive({ userId: 'u1', sid: 'sid-1', iat: now }); // fine

  db.sessions.get('sid-1').revokedAt = new Date();
  tracker.forgetCache('sid-1', 'u1');
  await assert.rejects(() => tracker.assertSessionActive({ userId: 'u1', sid: 'sid-1', iat: now }), /signed out/);

  // "log out everywhere": every token issued before it stops working, newer ones work
  db.sessions.set('sid-2', { sid: 'sid-2', revokedAt: null });
  db.users.set('u1', { sessionsValidFrom: new Date((now + 10) * 1000) });
  tracker.forgetCache(null, 'u1');
  await assert.rejects(() => tracker.assertSessionActive({ userId: 'u1', sid: 'sid-2', iat: now }), /signed out/);
  await assert.rejects(() => tracker.assertSessionActive({ userId: 'u1', sid: null, iat: now }), /signed out/);
  await tracker.assertSessionActive({ userId: 'u1', sid: 'sid-2', iat: now + 30 });

  // unknown session id (e.g. expired and cleaned up) is rejected
  await assert.rejects(() => tracker.assertSessionActive({ userId: 'u1', sid: 'ghost', iat: now + 30 }), /signed out/);

  // new-device detection: first ever sign-in is not "new"; a second device is
  const req = (deviceId, ua) => ({ headers: { 'x-device-id': deviceId, 'user-agent': ua }, ip: '127.0.0.1' });
  const chrome = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0 Safari/537.36';
  await tracker.startSession(req('device-aaaaaaaa', chrome), 'u2', 'password');
  await tracker.startSession(req('device-aaaaaaaa', chrome), 'u2', 'password');
  await tracker.startSession(req('device-bbbbbbbb', chrome), 'u2', 'google');
  assert.deepStrictEqual(db.events.filter((e) => e.userId === 'u2').map((e) => e.isNewDevice), [false, false, true]);
  assert.strictEqual(parseUserAgent(chrome).os, 'Windows 10/11');
  console.log('session tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
