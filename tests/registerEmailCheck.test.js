// POST /api/auth/register refuses junk addresses BEFORE anything is created or mailed (no pending sign-up, no code mail), and lets a real
// address through to the confirmation step even when DNS is having a bad moment. The models are in-memory stand-ins; the route and the
// sign-up service are the real ones.
const assert = require('assert');
const path = require('path');
process.env.JWT_SECRET = 'test-secret';
process.env.ENCRYPTION_KEY = 'test-encryption-key-test-encryption-key';
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

const store = [];
class Doc { constructor(o) { Object.assign(this, o); } async save() { return this; } toObject() { const { save, toObject, ...rest } = this; return { ...rest }; } }
const matches = (u, q) => Object.entries(q).every(([k, v]) => u[k] === v);
stub('models/schemas/User.js', {
  findOne: async (q) => store.find((u) => matches(u, q)) || null,
  exists: async (q) => (store.find((u) => matches(u, q)) ? { _id: 1 } : null),
  findById: async (id) => store.find((u) => u._id === id) || null,
  updateOne: async () => ({}),
  create: async (o) => { const d = new Doc({ _id: 'u' + (store.length + 1), role: 'user', creditBalance: 0, ...o }); store.push(d); return d; },
});
let pendingCount = 0;
stub('models/schemas/PendingSignup.js', { create: async (o) => { pendingCount += 1; return { _id: 'p' + pendingCount, ...o }; }, countDocuments: async () => 0, deleteOne: async () => {} });
const codeMails = [];
stub('models/settingsModel.js', { getSettings: async () => ({ welcomeBonusEnabled: true, welcomeBonusCredits: 10 }) });
stub('models/ebayAccountsModel.js', {});
stub('services/signupBonusGuard.js', { emailKey: (e) => e, welcomeBonusDecision: async () => ({ allowed: true }) });
stub('services/passwordService.js', { hashPassword: async (p) => 'hash:' + p, verifyPassword: async () => true });
stub('services/sessionTracker.js', { endAllSessions: async () => 1, requestContext: () => ({ ip: '1.2.3.4', deviceId: 'd' }), startSession: async () => 'sid', recordFailedLogin: () => {} });
stub('services/emailService.js', {
  sendAdminAlert: async () => {}, sendPasswordResetOtp: async () => {}, sendPasswordChangedEmail: async () => {}, sendPasswordResetRequestedEmail: async () => {}, sendNewLoginEmail: async () => {},
  sendWelcomeEmail: async () => {}, sendSignupCodeEmail: async (m) => { codeMails.push(m); },
});
stub('services/googleAuthService.js', { verifyGoogleToken: async () => ({}) });
stub('services/accessGuard.js', { checkNewAccount: async () => null, blockedError: (d) => Object.assign(new Error('blocked'), { statusCode: 403, blocked: d }) });

const { setResolver } = require('../services/emailQualityService');
let dnsMode = 'ok';
setResolver({
  resolveMx: async () => {
    if (dnsMode === 'down') throw Object.assign(new Error('SERVFAIL'), { code: 'ESERVFAIL' });
    if (dnsMode === 'nxdomain') throw Object.assign(new Error('NXDOMAIN'), { code: 'ENOTFOUND' });
    return [{ exchange: 'mx.example-provider.net', priority: 10 }];
  },
  resolve4: async () => [], resolve6: async () => [],
});

const route = require('../routes/auth');
const handler = (method, p) => { const l = route.stack.find((x) => x.route && x.route.path === p && x.route.methods[method]); assert.ok(l, method + ' ' + p); return l.route.stack[l.route.stack.length - 1].handle; };
const fakeRes = () => { const r = { statusCode: 200 }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
const register = async (email, username = 'somebody') => { const res = fakeRes(); await handler('post', '/register')({ body: { username, email, password: 'a-long-password-1' }, headers: {}, ip: '1.2.3.4', socket: {} }, res); return res; };

(async () => {
  // the junk that was found on the live site, and its cousins: refused, nothing created, nothing mailed
  for (const [email, reason] of [['scan1790349045@example.com', 'reserved'], ['scan1790352722q@mailinator.com', 'disposable'], ['rao@gmial.com', 'typo'], ['a@foo.test', 'reserved']]) {
    const res = await register(email);
    assert.strictEqual(res.statusCode, 400, email);
    assert.strictEqual(res.body.success, false);
    assert.strictEqual(res.body.reason, reason, email);
    assert.ok(res.body.error && res.body.error.length > 10);
  }
  dnsMode = 'nxdomain';
  let res = await register('a@this-domain-does-not-exist.com');
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.reason, 'no_mail');
  assert.strictEqual(store.length, 0, 'no account for any of them');
  assert.strictEqual(pendingCount, 0, 'no pending sign-up');
  assert.strictEqual(codeMails.length, 0, 'and no code mail went out');

  // a real address is taken to the confirmation step (a code is mailed; the account comes when it is entered); a DNS outage does not stop it
  dnsMode = 'ok';
  res = await register('real.person@gmail.com', 'realperson');
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.needsConfirmation, true);
  assert.strictEqual(codeMails.at(-1).to, 'real.person@gmail.com');
  dnsMode = 'down';
  res = await register('another@somewhere-else.org', 'another');
  assert.strictEqual(res.statusCode, 200, 'a failing DNS lookup never blocks a real person');
  assert.strictEqual(res.body.needsConfirmation, true);
  assert.strictEqual(codeMails.length, 2);
  assert.strictEqual(store.length, 0, 'still no account before the code is entered');

  console.log('register email check tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
