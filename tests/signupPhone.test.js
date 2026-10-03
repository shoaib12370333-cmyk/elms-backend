// The phone number at sign-up: required on the sign-up form and checked (services/phoneService.js), kept with the pending sign-up until the
// email code is entered, saved on the new account and shown to the person as THEIR number; an account made without one (Google sign-in) must
// add one, an old account is asked but may skip; PUT /api/auth/phone saves it. Real route, services and usersModel on in-memory stand-ins.
const assert = require('assert');
const path = require('path');
process.env.JWT_SECRET = 'test-secret';
process.env.ENCRYPTION_KEY = 'test-encryption-key-test-encryption-key';
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

// ---- users
const users = [];
class Doc { constructor(o) { Object.assign(this, o); } async save() { return this; } toObject() { const { save, toObject, ...rest } = this; return { ...rest, _id: this._id }; } }
const eq = (u, q) => Object.entries(q).every(([k, v]) => u[k] === v);
stub('models/schemas/User.js', {
  findOne: async (q) => users.find((u) => eq(u, q)) || null,
  exists: async (q) => (users.find((u) => eq(u, q)) ? { _id: 1 } : null),
  findById: async (id) => users.find((u) => u._id === id) || null,
  updateOne: async () => ({}),
  findOneAndUpdate: async (q, update) => { const u = users.find((x) => eq(x, q)); if (!u) return null; Object.assign(u, update.$set || {}); return u; },
  create: async (o) => {
    if (users.some((u) => u.email === o.email || (o.username && u.username === o.username))) throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
    const d = new Doc({ _id: 'u' + (users.length + 1), role: 'user', creditBalance: 0, passwordHash: null, googleId: null, welcomePopupSeenAt: null, ...o });
    users.push(d);
    return d;
  },
});
let pending = [];
let pendingSeq = 0;
stub('models/schemas/PendingSignup.js', {
  create: async (o) => { const d = { _id: 'p' + (++pendingSeq), createdAt: new Date(), attempts: 0, sends: 1, ...o }; pending.push(d); return d; },
  findOne: async (q) => pending.find((p) => eq(p, q)) || null,
  countDocuments: async () => 0,
  updateOne: async () => ({ matchedCount: 1 }),
  deleteOne: async (q) => { pending = pending.filter((p) => p._id !== q._id); },
  deleteMany: async (q) => { pending = pending.filter((p) => p.email !== q.email); },
  findOneAndDelete: async (q) => { const d = pending.find((p) => p._id === q._id); if (d) pending = pending.filter((p) => p._id !== q._id); return d || null; },
});
const codeMails = [];
let googleProfile = { googleId: 'g1', email: 'g@x.com', name: 'Gee', picture: null };
stub('models/settingsModel.js', { getSettings: async () => ({ welcomeBonusEnabled: false, welcomeBonusCredits: 0 }) });
stub('models/ebayAccountsModel.js', {});
stub('services/signupBonusGuard.js', { emailKey: (e) => e, welcomeBonusDecision: async () => ({ allowed: true }) });
stub('services/passwordService.js', { hashPassword: async (p) => 'hash:' + p, verifyPassword: async () => true });
stub('services/emailQualityService.js', { checkEmailQuality: async () => ({ ok: true }) });
stub('services/sessionTracker.js', { endAllSessions: async () => 1, requestContext: () => ({ ip: '1.2.3.4', deviceId: 'd' }), startSession: async () => 'sid', recordFailedLogin: () => {} });
stub('services/emailService.js', {
  sendAdminAlert: async () => {}, sendPasswordResetOtp: async () => {}, sendPasswordChangedEmail: async () => {}, sendPasswordResetRequestedEmail: async () => {}, sendNewLoginEmail: async () => {},
  sendSignupCodeEmail: async (m) => { codeMails.push(m); },
  sendWelcomeEmail: async () => {},
});
stub('services/googleAuthService.js', { verifyGoogleToken: async () => googleProfile });
stub('services/accessGuard.js', { checkNewAccount: async () => null, blockedError: (d) => Object.assign(new Error('blocked'), { statusCode: 403, blocked: d }) });
stub('services/referralService.js', { attachReferral: async () => ({ applied: false }) });
stub('services/affiliateService.js', { attachAtSignup: async () => {} });

const route = require('../routes/auth');
const handler = (method, p) => { const l = route.stack.find((x) => x.route && x.route.path === p && x.route.methods[method]); assert.ok(l, method + ' ' + p); return l.route.stack[l.route.stack.length - 1].handle; };
const fakeRes = () => { const r = { statusCode: 200 }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
const call = async (method, p, req) => { const res = fakeRes(); await handler(method, p)({ headers: {}, ip: '1.2.3.4', socket: {}, ...req }, res); return res; };
const post = (p, body) => call('post', p, { body });
const GOOD = { username: 'newperson', email: 'New@Person.com', password: 'a-long-password-1', phoneCountry: 'PK', phone: '0300 1234567' };
const reset = () => { users.length = 0; pending = []; codeMails.length = 0; };

(async () => {
  // ---------- the phone is REQUIRED and checked before anything is created or mailed ----------
  reset();
  for (const [name, body, field, message] of [
    ['no country', { ...GOOD, phoneCountry: undefined }, 'phoneCountry', /choose the country/],
    ['a country that does not exist', { ...GOOD, phoneCountry: 'XX' }, 'phoneCountry', /choose the country/],
    ['no number', { ...GOOD, phone: '' }, 'phone', /enter your phone number/],
    ['a blank number', { ...GOOD, phone: '   ' }, 'phone', /enter your phone number/],
    ['junk digits', { ...GOOD, phone: '1111111111' }, 'phone', /valid phone number for Pakistan/],
    ['too short', { ...GOOD, phone: '123' }, 'phone', /valid phone number/],
    ['letters', { ...GOOD, phone: 'call me' }, 'phone', /only have digits/],
    ['a number sent as a number', { ...GOOD, phone: 3001234567 }, 'phone', /enter your phone number/],
    ['an object', { ...GOOD, phone: { a: 1 } }, 'phone', /enter your phone number/],
  ]) {
    const res = await post('/register', body);
    assert.strictEqual(res.statusCode, 400, name);
    assert.strictEqual(res.body.success, false, name);
    assert.strictEqual(res.body.field, field, name);
    assert.match(res.body.error, message, name);
  }
  // a sign-up form from before phone numbers existed (an old tab) sends neither field: it is told to reload, not asked for a field it lacks
  const oldTab = await post('/register', { ...GOOD, phoneCountry: undefined, phone: undefined });
  assert.strictEqual(oldTab.statusCode, 400);
  assert.strictEqual(oldTab.body.reload, true);
  assert.match(oldTab.body.error, /form was updated.*reload this page/i);
  // ...but a form that sends EMPTY fields is the new form with nothing chosen
  const emptyFields = await post('/register', { ...GOOD, phoneCountry: '', phone: '' });
  assert.deepStrictEqual([emptyFields.statusCode, emptyFields.body.field, emptyFields.body.reload], [400, 'phoneCountry', undefined]);
  assert.strictEqual(pending.length + users.length + codeMails.length, 0, 'nothing was created, nothing was mailed');

  // ---------- a good number: kept with the pending sign-up, saved on the account when the code is entered ----------
  let res = await post('/register', { ...GOOD, phone: '+92 (300) 123-4567' });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.needsConfirmation, true);
  assert.deepStrictEqual([pending[0].phone, pending[0].phoneCountry, pending[0].phoneDisplay], ['+923001234567', 'PK', '+92 300 1234567'], 'stored in one shape, whatever was typed');
  assert.strictEqual(users.length, 0, 'still no account');
  assert.strictEqual(res.body.phone, undefined, 'the number is not echoed in the answer');
  res = await post('/register/confirm', { pendingToken: res.body.pendingToken, code: codeMails[0].code });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual([users[0].phone, users[0].phoneCountry, users[0].phoneDisplay], ['+923001234567', 'PK', '+92 300 1234567']);
  assert.strictEqual(users[0].phoneRequired, undefined, 'an account made with a number is never asked again');
  // the person sees THEIR number, and is not asked for it
  assert.deepStrictEqual(
    [res.body.user.phone, res.body.user.phoneCountry, res.body.user.phoneDisplay, res.body.user.needsPhone, res.body.user.phoneRequired],
    ['+923001234567', 'PK', '+92 300 1234567', false, false],
  );
  assert.strictEqual(pending.length, 0);

  // another country, typed the national way
  reset();
  res = await post('/register', { ...GOOD, email: 'us@person.com', username: 'usperson', phoneCountry: 'US', phone: '(415) 555-2671' });
  assert.strictEqual(res.statusCode, 200);
  res = await post('/register/confirm', { pendingToken: res.body.pendingToken, code: codeMails[0].code });
  assert.deepStrictEqual([users[0].phone, users[0].phoneCountry], ['+14155552671', 'US']);

  // ---------- an account made without a number (Google sign-in skips the form) must add one ----------
  reset();
  res = await post('/google', { credential: 'x' });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(users[0].phoneRequired, true);
  assert.deepStrictEqual([res.body.user.needsPhone, res.body.user.phoneRequired, res.body.user.phone], [true, true, null], 'asked, and cannot skip');
  // signing in with Google again (an existing account) does not change that
  res = await post('/google', { credential: 'x' });
  assert.deepStrictEqual([res.body.user.needsPhone, res.body.user.phoneRequired], [true, true]);

  // ---------- an account from before phone numbers existed: asked, but may skip ----------
  reset();
  users.push(new Doc({ _id: 'old1', email: 'old@x.com', username: 'old', role: 'user', creditBalance: 5, googleId: null }));
  const { getUserById } = require('../models/usersModel');
  const old = await getUserById('old1');
  assert.deepStrictEqual([old.needsPhone, old.phoneRequired, old.phone, old.phoneCountry, old.phoneDisplay], [true, false, null, null, null]);

  // ---------- PUT /api/auth/phone: the person's own number, checked ----------
  res = await call('put', '/phone', { userId: 'old1', body: { phoneCountry: 'PK', phone: '0300 1234567' } });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual([res.body.user.phone, res.body.user.phoneCountry, res.body.user.phoneDisplay, res.body.user.needsPhone, res.body.user.phoneRequired], ['+923001234567', 'PK', '+92 300 1234567', false, false]);
  assert.strictEqual(users[0].phone, '+923001234567');
  // it can be replaced
  res = await call('put', '/phone', { userId: 'old1', body: { phoneCountry: 'GB', phone: '07911 123456' } });
  assert.deepStrictEqual([res.body.user.phone, res.body.user.phoneCountry], ['+447911123456', 'GB']);
  // bad numbers are refused and change nothing
  for (const body of [{}, { phoneCountry: 'GB' }, { phoneCountry: 'GB', phone: '123' }, { phoneCountry: 'XX', phone: '07911 123456' }, { phoneCountry: 'GB', phone: 'abc' }, undefined]) {
    res = await call('put', '/phone', { userId: 'old1', body });
    assert.strictEqual(res.statusCode, 400, JSON.stringify(body));
    assert.strictEqual(res.body.success, false);
  }
  assert.strictEqual(users[0].phone, '+447911123456', 'a refused number leaves the saved one alone');
  // only the signed-in person's own account is ever written
  users.push(new Doc({ _id: 'other', email: 'other@x.com', username: 'other', role: 'user', creditBalance: 0, googleId: null }));
  await call('put', '/phone', { userId: 'old1', body: { phoneCountry: 'PK', phone: '0300 1234567', userId: 'other', id: 'other' } });
  assert.strictEqual(users.find((u) => u._id === 'other').phone, undefined, 'a userId in the body is ignored');
  res = await call('put', '/phone', { userId: 'gone', body: { phoneCountry: 'PK', phone: '0300 1234567' } });
  assert.strictEqual(res.statusCode, 404);

  // ---------- a sign-up that was started BEFORE this existed (no phone fields) and is confirmed after: the account is made, and asks for a number ----------
  reset();
  res = await post('/register', GOOD);
  delete pending[0].phone; delete pending[0].phoneCountry; delete pending[0].phoneDisplay;
  res = await post('/register/confirm', { pendingToken: res.body.pendingToken, code: codeMails[0].code });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual([users[0].phone, users[0].phoneRequired, res.body.user.needsPhone, res.body.user.phoneRequired], [undefined, true, true, true]);

  // ---------- Google sign-in on an account that already exists (email + password sign-up, then Google): linked, never newly "required" ----------
  reset();
  users.push(new Doc({ _id: 'pw1', email: 'g@x.com', username: 'pw', role: 'user', creditBalance: 1, googleId: null, passwordHash: 'h', unverifiedPassword: false }));
  res = await post('/google', { credential: 'x' });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual([users.length, users[0].googleId, users[0].phoneRequired, res.body.user.needsPhone, res.body.user.phoneRequired], [1, 'g1', undefined, true, false], 'an old account stays skippable');
  users[0].phone = '+923001234567'; users[0].phoneCountry = 'PK'; users[0].phoneDisplay = '+92 300 1234567';
  users[0].googleId = null;
  res = await post('/google', { credential: 'x' });
  assert.deepStrictEqual([res.body.user.phone, res.body.user.needsPhone], ['+923001234567', false], 'a number already saved survives the link');

  // ---------- a Google sign-up that adds its number: no longer asked, whatever is stored ----------
  reset();
  res = await post('/google', { credential: 'x' });
  assert.strictEqual(users[0].phoneRequired, true);
  res = await call('put', '/phone', { userId: users[0]._id, body: { phoneCountry: 'PK', phone: '0300 1234567' } });
  assert.deepStrictEqual([res.body.user.needsPhone, res.body.user.phoneRequired], [false, false]);
  assert.strictEqual(users[0].phoneRequired, true, 'the stored flag stays; what is sent to the app is what matters');
  res = await post('/google', { credential: 'x' });
  assert.deepStrictEqual([res.body.user.needsPhone, res.body.user.phoneRequired, res.body.user.phone], [false, false, '+923001234567']);

  // ---------- an admin is asked but may always skip: the server never says "must add" for one ----------
  reset();
  users.push(new Doc({ _id: 'ad1', email: 'boss@x.com', username: 'boss', role: 'admin', creditBalance: 0, googleId: null, phoneRequired: true }));
  users.push(new Doc({ _id: 'us1', email: 'plain@x.com', username: 'plain', role: 'user', creditBalance: 0, googleId: null, phoneRequired: true }));
  const admin = await getUserById('ad1');
  const plain = await getUserById('us1');
  assert.deepStrictEqual([admin.needsPhone, admin.phoneRequired], [true, false]);
  assert.deepStrictEqual([plain.needsPhone, plain.phoneRequired], [true, true]);
  process.env.SUPER_ADMIN_EMAIL = 'owner@x.com';
  users.push(new Doc({ _id: 'so1', email: 'Owner@X.com', username: 'owner', role: 'user', creditBalance: 0, googleId: null, phoneRequired: true }));
  assert.deepStrictEqual([(await getUserById('so1')).needsPhone, (await getUserById('so1')).phoneRequired], [true, false], 'the super admin too');
  delete process.env.SUPER_ADMIN_EMAIL;

  // ---------- the route itself: only a signed-in person, and limited per ACCOUNT (many sellers share one address) ----------
  const layer = route.stack.find((x) => x.route && x.route.path === '/phone' && x.route.methods.put);
  const handlers = layer.route.stack.map((l) => l.handle);
  assert.strictEqual(handlers[0], require('../middleware/requireAuth').requireAuth, 'requireAuth runs first');
  assert.strictEqual(handlers.length, 3, 'requireAuth, the limiter, the handler');
  const limiter = handlers[1];
  const hit = async (userId) => {
    const out = { statusCode: 200, headers: {} };
    const resObj = { setHeader: (k, v) => { out.headers[k] = v; }, getHeader: (k) => out.headers[k], status(c) { out.statusCode = c; return resObj; }, json(b) { out.body = b; return resObj; }, send(b) { out.body = b; return resObj; }, end() { return resObj; }, headersSent: false };
    let passed = false;
    await new Promise((resolve) => { limiter({ ip: '9.9.9.9', userId, headers: {}, app: { get: () => false }, socket: {} }, resObj, () => { passed = true; resolve(); }); setTimeout(resolve, 60); });
    return passed;
  };
  for (let i = 0; i < 20; i += 1) assert.strictEqual(await hit('same-ip-user-a'), true, 'try ' + (i + 1));
  assert.strictEqual(await hit('same-ip-user-a'), false, 'the 21st try of one account is stopped');
  assert.strictEqual(await hit('same-ip-user-b'), true, 'another account on the SAME address is not');

  console.log('signup phone tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
