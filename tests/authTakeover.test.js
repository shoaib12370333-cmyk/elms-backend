// Registering can no longer take over an existing account; a Google sign-in removes a password nobody proved; a password reset
// ends every session. The models are in-memory stand-ins, the code under test is the real usersModel and routes/auth.js.
const assert = require('assert');
const path = require('path');
const crypto = require('crypto');
process.env.JWT_SECRET = 'test-secret';
process.env.ENCRYPTION_KEY = 'test-encryption-key-test-encryption-key';
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

// ---- in-memory User collection (unique email / username like the real indexes)
const store = [];
class Doc {
  constructor(o) { Object.assign(this, o); }
  async save() { return this; }
  toObject() { const { save, toObject, ...rest } = this; return { ...rest }; }
}
const matches = (u, q) => Object.entries(q).every(([k, v]) => u[k] === v);
let failNextCreate = null;
const User = {
  findOne: async (q) => store.find((u) => matches(u, q)) || null,
  exists: async (q) => (store.find((u) => matches(u, q)) ? { _id: 1 } : null),
  findById: async (id) => store.find((u) => u._id === id) || null,
  updateOne: async () => ({}),
  create: async (o) => {
    if (failNextCreate) { const e = failNextCreate; failNextCreate = null; throw e; }
    if (store.some((u) => u.email === o.email || (o.username && u.username === o.username))) throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
    const d = new Doc({ _id: 'u' + (store.length + 1), role: 'user', creditBalance: 0, passwordHash: null, googleId: null, ...o });
    store.push(d);
    return d;
  },
};
stub('models/schemas/User.js', User);
stub('models/settingsModel.js', { getSettings: async () => ({ welcomeBonusEnabled: true, welcomeBonusCredits: 10 }) });
stub('models/ebayAccountsModel.js', {});

const ended = [];
const mails = { removed: [], alerts: [] };
stub('services/sessionTracker.js', {
  endAllSessions: async (id, reason) => { ended.push([id, reason]); return 1; },
  requestContext: () => ({ ip: '1.2.3.4', deviceId: 'd' }), startSession: async () => 'sid', recordFailedLogin: () => {},
});
stub('services/emailService.js', {
  sendAdminAlert: async (m) => { mails.alerts.push(m); },
  sendPasswordRemovedEmail: async (m) => { mails.removed.push(m); },
  sendPasswordResetOtp: async () => {}, sendPasswordChangedEmail: async () => {}, sendPasswordResetRequestedEmail: async () => {}, sendNewLoginEmail: async () => {},
});
stub('services/googleAuthService.js', { verifyGoogleToken: async () => ({}) });
stub('services/accessGuard.js', { checkNewAccount: async () => null, blockedError: (d) => Object.assign(new Error('blocked'), { statusCode: 403, blocked: d }) });

const users = require('../models/usersModel');

const fresh = () => { store.length = 0; ended.length = 0; mails.removed.length = 0; mails.alerts.length = 0; };
const seed = (o) => { const d = new Doc({ _id: 'u' + (store.length + 1), role: 'user', creditBalance: 500, passwordHash: null, googleId: null, ...o }); store.push(d); return d; };
const conflict = (p) => assert.rejects(p, (e) => e.statusCode === 409);

(async () => {
  // ---------- registering an address that already has an account changes nothing ----------
  fresh();
  const google = seed({ email: 'victim@gmail.com', googleId: 'g-1', name: 'Victim' });
  await conflict(users.registerWithPassword({ username: 'attacker', email: 'victim@gmail.com', password: 'attacker-pw-123' }));
  assert.strictEqual(google.passwordHash, null, 'no password was put on the Google account');
  assert.strictEqual(google.username, undefined);
  await assert.rejects(() => users.loginWithPassword({ email: 'victim@gmail.com', password: 'attacker-pw-123' }), /Invalid email or password/);

  fresh();
  const pw = seed({ email: 'has@pw.com', username: 'hasone', passwordHash: 'hash-of-the-owner' });
  await conflict(users.registerWithPassword({ username: 'other', email: 'has@pw.com', password: 'whatever-123' }));
  assert.strictEqual(pw.passwordHash, 'hash-of-the-owner', 'the owner\'s password was not replaced');

  fresh();
  seed({ email: 'a@b.com', username: 'taken' });
  await assert.rejects(() => users.registerWithPassword({ username: 'taken', email: 'new@b.com', password: 'whatever-123' }), /username is already taken/);

  // ---------- a new address still registers, with the welcome bonus, and its password is marked unproven ----------
  fresh();
  const made = await users.registerWithPassword({ username: 'newuser', email: 'new@x.com', password: 'a-good-password' });
  assert.strictEqual(made.email, 'new@x.com');
  assert.strictEqual(made.creditBalance, 10);
  assert.strictEqual(store[0].unverifiedPassword, true);
  assert.ok(store[0].passwordHash && store[0].passwordHash !== 'a-good-password', 'the password is stored hashed');
  assert.strictEqual((await users.loginWithPassword({ email: 'new@x.com', password: 'a-good-password' })).id, made.id);
  const noBonus = await users.registerWithPassword({ username: 'nobonus', email: 'nb@x.com', password: 'a-good-password' }, { welcomeBonus: false });
  assert.strictEqual(noBonus.creditBalance, 0);

  // two sign-ups for the same address at the same moment: the database refuses the second, the person gets a plain message
  failNextCreate = Object.assign(new Error('E11000 duplicate key error collection: users index: email_1'), { code: 11000 });
  const race = await users.registerWithPassword({ username: 'racer', email: 'race@x.com', password: 'a-good-password' }).then(() => null, (e) => e);
  assert.strictEqual(race.statusCode, 409);
  assert.ok(!/E11000/.test(race.message), 'no database error text reaches the person');

  // ---------- Google removes a password nobody proved (someone may have registered the address first) ----------
  fresh();
  const squatted = seed({ email: 'bob@gmail.com', username: 'squatter', passwordHash: 'squatter-hash', unverifiedPassword: true });
  const linked = await users.findOrCreateUser({ googleId: 'g-bob', email: 'bob@gmail.com', name: 'Bob', picture: null }, { welcomeBonus: false });
  assert.strictEqual(linked.id, squatted._id, 'same account: credits and data stay with the person');
  assert.strictEqual(squatted.googleId, 'g-bob');
  assert.strictEqual(squatted.passwordHash, null, 'the unproven password is gone');
  assert.strictEqual(squatted.unverifiedPassword, false);
  assert.deepStrictEqual(ended, [[squatted._id, 'password_removed']], 'sessions made with it end');
  assert.deepStrictEqual(mails.removed.map((m) => m.to), ['bob@gmail.com'], 'and the owner is told');
  await assert.rejects(() => users.loginWithPassword({ email: 'bob@gmail.com', password: 'anything' }), /Invalid email or password/);

  // the same when the Google identity is already linked (an account that was taken over before this fix)
  fresh();
  const returning = seed({ email: 'ret@gmail.com', googleId: 'g-ret', passwordHash: 'planted-hash', unverifiedPassword: true });
  await users.findOrCreateUser({ googleId: 'g-ret', email: 'ret@gmail.com', name: 'R', picture: null });
  assert.strictEqual(returning.passwordHash, null);
  assert.strictEqual(ended.length, 1);

  // a password that was proven (reset by mailed code) or that comes from before this existed is kept
  for (const flag of [false, undefined]) {
    fresh();
    const keep = seed({ email: 'keep@gmail.com', passwordHash: 'good-hash', unverifiedPassword: flag });
    await users.findOrCreateUser({ googleId: 'g-keep', email: 'keep@gmail.com', name: 'K', picture: null });
    assert.strictEqual(keep.passwordHash, 'good-hash', 'password kept when unverifiedPassword is ' + flag);
    assert.strictEqual(keep.googleId, 'g-keep');
    assert.strictEqual(ended.length, 0);
    assert.strictEqual(mails.removed.length, 0);
  }

  // a brand-new Google account is unaffected
  fresh();
  const newGoogle = await users.findOrCreateUser({ googleId: 'g-new', email: 'brand@new.com', name: 'N', picture: null }, { welcomeBonus: true });
  assert.strictEqual(newGoogle.creditBalance, 10);
  assert.strictEqual(ended.length, 0);

  // ---------- password reset: the mailed code proves the mailbox and every session ends ----------
  const db = { otp: null, deleted: 0 };
  stub('models/schemas/PasswordResetOtp.js', {
    findOne: () => ({ sort: async () => db.otp }),
    deleteMany: async () => { db.deleted += 1; },
    deleteOne: async () => {}, create: async () => ({}),
  });
  const authRoutes = require('../routes/auth');
  const handler = (method, p) => { const l = authRoutes.stack.find((x) => x.route && x.route.path === p && x.route.methods[method]); assert.ok(l, method + ' ' + p); return l.route.stack[l.route.stack.length - 1].handle; };
  const fakeRes = () => { const r = { statusCode: 200 }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
  const reset = async (body) => { const res = fakeRes(); await handler('post', '/forgot-password/reset')({ body, headers: {}, ip: '1.2.3.4' }, res); return res; };
  const codeHash = (email, code) => crypto.createHmac('sha256', process.env.JWT_SECRET).update(email + ':' + code).digest('hex');

  fresh();
  const victim = seed({ email: 'owner@gmail.com', googleId: 'g-o', passwordHash: 'attacker-planted-hash', unverifiedPassword: true });
  db.otp = { email: 'owner@gmail.com', codeHash: codeHash('owner@gmail.com', '123456'), expiresAt: new Date(Date.now() + 60000), attempts: 0, save: async () => {} };
  let res = await reset({ email: 'owner@gmail.com', code: '123456', newPassword: 'the-owners-new-password' });
  assert.strictEqual(res.body.success, true);
  assert.ok(victim.passwordHash && victim.passwordHash !== 'attacker-planted-hash', 'the password was replaced');
  assert.strictEqual(victim.unverifiedPassword, false, 'the code proved the mailbox');
  assert.deepStrictEqual(ended, [[victim._id, 'password_reset']], 'every session made before the reset ends');

  // a wrong code changes nothing and ends nothing
  fresh();
  const other = seed({ email: 'o2@gmail.com', passwordHash: 'old-hash', unverifiedPassword: true });
  db.otp = { email: 'o2@gmail.com', codeHash: codeHash('o2@gmail.com', '111111'), expiresAt: new Date(Date.now() + 60000), attempts: 0, save: async () => {} };
  res = await reset({ email: 'o2@gmail.com', code: '999999', newPassword: 'the-owners-new-password' });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(other.passwordHash, 'old-hash');
  assert.strictEqual(ended.length, 0);

  console.log('authTakeover tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
