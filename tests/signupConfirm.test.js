// Sign-up with an email confirmation code: nothing exists until the code that was mailed to the address is entered together with the
// pendingToken of the browser that started the sign-up. The real route, service and usersModel run on in-memory stand-ins.
const assert = require('assert');
const path = require('path');
process.env.JWT_SECRET = 'test-secret';
process.env.ENCRYPTION_KEY = 'test-encryption-key-test-encryption-key';
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

// ---- users (unique email / username like the real indexes)
const users = [];
class Doc { constructor(o) { Object.assign(this, o); } async save() { return this; } toObject() { const { save, toObject, ...rest } = this; return { ...rest }; } }
const eq = (u, q) => Object.entries(q).every(([k, v]) => u[k] === v);
stub('models/schemas/User.js', {
  findOne: async (q) => users.find((u) => eq(u, q)) || null,
  exists: async (q) => (users.find((u) => eq(u, q)) ? { _id: 1 } : null),
  findById: async (id) => users.find((u) => u._id === id) || null,
  updateOne: async () => ({}),
  create: async (o) => {
    if (users.some((u) => u.email === o.email || (o.username && u.username === o.username))) throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
    const d = new Doc({ _id: 'u' + (users.length + 1), role: 'user', creditBalance: 0, passwordHash: null, googleId: null, welcomePopupSeenAt: null, ...o });
    users.push(d);
    return d;
  },
});

// ---- pending sign-ups
let pending = [];
let pendingSeq = 0;
stub('models/schemas/PendingSignup.js', {
  create: async (o) => { const d = { _id: 'p' + (++pendingSeq), createdAt: new Date(), attempts: 0, sends: 1, ...o }; pending.push(d); return d; }, // the schema's defaults
  findOne: async (q) => pending.find((p) => eq(p, q)) || null,
  countDocuments: async (q) => pending.filter((p) => p.email === q.email && p.createdAt >= q.createdAt.$gte).length,
  updateOne: async (q, u) => { const d = pending.find((p) => p._id === q._id); if (!d) return { matchedCount: 0 }; Object.assign(d, u.$set || {}); for (const [k, v] of Object.entries(u.$inc || {})) d[k] = (d[k] || 0) + v; return { matchedCount: 1 }; },
  deleteOne: async (q) => { pending = pending.filter((p) => p._id !== q._id); },
  deleteMany: async (q) => { pending = pending.filter((p) => p.email !== q.email); },
  findOneAndDelete: async (q) => { const d = pending.find((p) => p._id === q._id); if (d) pending = pending.filter((p) => p._id !== q._id); return d || null; },
});

// ---- everything else
const settings = { welcomeBonusEnabled: true, welcomeBonusCredits: 10 };
let decision = { allowed: true };
const events = [];       // 'code' / 'welcome' in the order they were mailed
const codeMails = [];
const welcomeMails = [];
let mailBroken = false;
const attached = { referral: [], affiliate: [] };
stub('models/settingsModel.js', { getSettings: async () => ({ ...settings }) });
stub('models/ebayAccountsModel.js', {});
stub('services/signupBonusGuard.js', { emailKey: (e) => e, welcomeBonusDecision: async () => decision });
stub('services/passwordService.js', { hashPassword: async (p) => 'hash:' + p, verifyPassword: async () => true });
stub('services/emailQualityService.js', { checkEmailQuality: async () => ({ ok: true }) });
stub('services/sessionTracker.js', { endAllSessions: async () => 1, requestContext: () => ({ ip: '1.2.3.4', deviceId: 'd' }), startSession: async () => 'sid', recordFailedLogin: () => {} });
stub('services/emailService.js', {
  sendAdminAlert: async () => {}, sendPasswordResetOtp: async () => {}, sendPasswordChangedEmail: async () => {}, sendPasswordResetRequestedEmail: async () => {}, sendNewLoginEmail: async () => {},
  sendSignupCodeEmail: async (m) => { if (mailBroken) throw new Error('smtp down'); events.push('code'); codeMails.push(m); },
  sendWelcomeEmail: async (m) => { events.push('welcome'); welcomeMails.push(m); },
});
stub('services/googleAuthService.js', { verifyGoogleToken: async () => ({}) });
stub('services/accessGuard.js', { checkNewAccount: async () => null, blockedError: (d) => Object.assign(new Error('blocked'), { statusCode: 403, blocked: d }) });
stub('services/referralService.js', { attachReferral: async ({ user, code }) => { attached.referral.push([user.id, code]); return { applied: true, discountPercent: 10, discountUses: 1, discountDays: 0 }; } });
stub('services/affiliateService.js', { attachAtSignup: async (user, code) => { attached.affiliate.push([user.id, code]); } });

const route = require('../routes/auth');
const handler = (method, p) => { const l = route.stack.find((x) => x.route && x.route.path === p && x.route.methods[method]); assert.ok(l, method + ' ' + p); return l.route.stack[l.route.stack.length - 1].handle; };
const fakeRes = () => { const r = { statusCode: 200 }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
const post = async (p, body) => { const res = fakeRes(); await handler('post', p)({ body, headers: {}, ip: '1.2.3.4', socket: {} }, res); return res; };
const begin = (extra = {}) => post('/register', { username: 'newperson', email: 'New@Person.com', password: 'a-long-password-1', ...extra });
const wrongFor = (code) => (code === '000000' ? '111111' : '000000');
const reset = () => { users.length = 0; pending = []; events.length = 0; codeMails.length = 0; welcomeMails.length = 0; attached.referral.length = 0; attached.affiliate.length = 0; decision = { allowed: true }; mailBroken = false; };

(async () => {
  // ---------- starting: a code is mailed, nothing exists yet ----------
  reset();
  let res = await begin();
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.needsConfirmation, true);
  assert.strictEqual(res.body.email, 'new@person.com');
  assert.strictEqual(res.body.pendingToken.length, 48);
  assert.strictEqual(res.body.sessionToken, undefined, 'no session yet');
  assert.strictEqual(users.length, 0, 'no account yet');
  assert.strictEqual(codeMails.length, 1);
  assert.strictEqual(codeMails[0].to, 'new@person.com');
  assert.match(codeMails[0].code, /^\d{6}$/);
  assert.strictEqual(welcomeMails.length, 0, 'no welcome mail before the address is confirmed');
  const token = res.body.pendingToken;
  const code = codeMails[0].code;
  assert.strictEqual(pending.length, 1);
  assert.notStrictEqual(pending[0].tokenHash, token, 'only a hash of the token is kept');
  assert.notStrictEqual(pending[0].codeHash, code, 'only a hash of the code is kept');
  assert.strictEqual(pending[0].passwordHash, 'hash:a-long-password-1', 'the password is kept hashed');

  // ---------- typing the code ----------
  res = await post('/register/confirm', { pendingToken: token, code: 'abc' });
  assert.strictEqual(res.statusCode, 400, 'not 6 digits');
  res = await post('/register/confirm', { code });
  assert.strictEqual(res.statusCode, 400, 'no token');
  res = await post('/register/confirm', { pendingToken: 'f'.repeat(48), code });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.restart, true, 'an unknown sign-up must start again');

  // wrong codes: five tries, then even the right code is refused until a new code is asked for
  const wrong = wrongFor(code);
  for (let left = 4; left >= 0; left -= 1) {
    res = await post('/register/confirm', { pendingToken: token, code: wrong });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.attemptsLeft, left);
  }
  res = await post('/register/confirm', { pendingToken: token, code });
  assert.strictEqual(res.statusCode, 429, 'locked after five wrong codes');
  assert.strictEqual(users.length, 0);

  // ---------- asking for a new code ----------
  res = await post('/register/resend', { pendingToken: token });
  assert.strictEqual(res.statusCode, 429, 'not again within a minute');
  assert.ok(res.body.retryAfterSeconds > 0 && res.body.retryAfterSeconds <= 60);
  pending[0].lastSentAt = new Date(Date.now() - 61 * 1000);
  res = await post('/register/resend', { pendingToken: token });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(codeMails.length, 2);
  const code2 = codeMails[1].code;
  if (code2 !== code) {
    res = await post('/register/confirm', { pendingToken: token, code });
    assert.strictEqual(res.statusCode, 400, 'the old code stopped working');
  }
  res = await post('/register/resend', { pendingToken: 'nope' });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.restart, true);

  // an expired code asks for a new one
  pending[0].codeExpiresAt = new Date(Date.now() - 1000);
  res = await post('/register/confirm', { pendingToken: token, code: code2 });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.expired, true);
  pending[0].lastSentAt = new Date(Date.now() - 61 * 1000);
  await post('/register/resend', { pendingToken: token });
  const code3 = codeMails[2].code;

  // ---------- the right code: the account is made, credits + welcome mail after the code mail, signed in ----------
  res = await post('/register/confirm', { pendingToken: token, code: code3 });
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.success, true);
  assert.ok(res.body.sessionToken, 'signed in');
  assert.strictEqual(users.length, 1);
  const made = users[0];
  assert.strictEqual(made.email, 'new@person.com');
  assert.strictEqual(made.passwordHash, 'hash:a-long-password-1', 'the password chosen at sign-up');
  assert.strictEqual(made.unverifiedPassword, false, 'the code proved the mailbox');
  assert.ok(made.emailVerifiedAt instanceof Date);
  assert.strictEqual(made.creditBalance, 10, 'the welcome credits');
  assert.deepStrictEqual(res.body.user.welcomePopup, { credits: 10 });
  assert.deepStrictEqual(welcomeMails, [{ to: 'new@person.com', name: 'newperson', credits: 10 }]);
  assert.deepStrictEqual(events.filter((e, i, all) => e !== all[i - 1]), ['code', 'welcome'], 'the code mail first, the welcome mail after the code');
  assert.strictEqual(pending.length, 0, 'the sign-up is used up');
  res = await post('/register/confirm', { pendingToken: token, code: code3 });
  assert.strictEqual(res.statusCode, 400, 'a code works once');
  assert.strictEqual(res.body.restart, true);
  assert.strictEqual(users.length, 1);

  // ---------- welcome credits refused by the abuse guard: the account is still made, without credits or popup ----------
  reset();
  decision = { allowed: false, reason: 'same network' };
  res = await begin({ username: 'guarded', email: 'guarded@x.com' });
  res = await post('/register/confirm', { pendingToken: res.body.pendingToken, code: codeMails[0].code });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(users[0].creditBalance, 0);
  assert.strictEqual(res.body.user.welcomePopup, null);
  assert.strictEqual(welcomeMails[0].credits, 0);

  // ---------- nobody can finish somebody else's sign-up, and a mailbox owner cannot be tricked into finishing one ----------
  reset();
  const attacker = await post('/register', { username: 'attacker', email: 'victim@gmail.com', password: 'attacker-password-1' });
  const victim = await post('/register', { username: 'victim', email: 'victim@gmail.com', password: 'victim-password-1' });
  assert.strictEqual(codeMails.length, 2, 'both codes went to the victim mailbox');
  const [codeA, codeV] = codeMails.map((m) => m.code);
  // the victim types the attacker's code into their own page: refused, nothing made
  if (codeA !== codeV) {
    res = await post('/register/confirm', { pendingToken: victim.body.pendingToken, code: codeA });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(users.length, 0);
  }
  // the attacker has a token but not the code that only reaches the mailbox
  res = await post('/register/confirm', { pendingToken: attacker.body.pendingToken, code: wrongFor(codeA) });
  assert.strictEqual(res.statusCode, 400);
  // the victim finishes their own sign-up: the account has THEIR password
  res = await post('/register/confirm', { pendingToken: victim.body.pendingToken, code: codeV });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(users[0].passwordHash, 'hash:victim-password-1');
  assert.strictEqual(users[0].username, 'victim');
  // the attacker's leftover sign-up is gone with it
  res = await post('/register/confirm', { pendingToken: attacker.body.pendingToken, code: codeA });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.restart, true);
  assert.strictEqual(users.length, 1);

  // ---------- an address or username that already has an account: refused at the start, no mail ----------
  reset();
  users.push(new Doc({ _id: 'g1', email: 'google@x.com', googleId: 'g-1', username: undefined, creditBalance: 500 }));
  users.push(new Doc({ _id: 'p1', email: 'taken@x.com', username: 'takenname', passwordHash: 'h', creditBalance: 5 }));
  res = await post('/register', { username: 'someone', email: 'google@x.com', password: 'a-long-password-1' });
  assert.strictEqual(res.statusCode, 409);
  assert.ok(!users[0].passwordHash, 'the Google account is untouched');
  res = await post('/register', { username: 'takenname', email: 'free@x.com', password: 'a-long-password-1' });
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(codeMails.length, 0);
  assert.strictEqual(pending.length, 0);

  // the address got an account (Google) between the start and the code: 409, no second account
  reset();
  res = await begin({ username: 'racer', email: 'race@x.com' });
  users.push(new Doc({ _id: 'g2', email: 'race@x.com', googleId: 'g-2', creditBalance: 10 }));
  res = await post('/register/confirm', { pendingToken: res.body.pendingToken, code: codeMails[0].code });
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(res.body.restart, true, 'the page sends the person back to the sign-up form');
  assert.strictEqual(users.length, 1);

  // ---------- limits ----------
  reset();
  for (let i = 1; i <= 5; i += 1) assert.strictEqual((await begin({ username: 'user' + i, email: 'same@x.com' })).statusCode, 200);
  res = await begin({ username: 'user6', email: 'same@x.com' });
  assert.strictEqual(res.statusCode, 429, 'no more than five codes per address per hour');
  assert.strictEqual(codeMails.length, 5);
  // one sign-up gets at most six codes
  reset();
  res = await begin();
  for (let i = 0; i < 5; i += 1) { pending[0].lastSentAt = new Date(Date.now() - 61 * 1000); assert.strictEqual((await post('/register/resend', { pendingToken: res.body.pendingToken })).statusCode, 200); }
  pending[0].lastSentAt = new Date(Date.now() - 61 * 1000);
  assert.strictEqual((await post('/register/resend', { pendingToken: res.body.pendingToken })).statusCode, 429);

  // ---------- a mail problem is an answer, and leaves nothing behind ----------
  reset();
  mailBroken = true;
  res = await begin();
  assert.strictEqual(res.statusCode, 503);
  assert.strictEqual(pending.length, 0, 'no half-made sign-up');
  mailBroken = false;
  res = await begin();
  pending[0].lastSentAt = new Date(Date.now() - 61 * 1000);
  mailBroken = true;
  assert.strictEqual((await post('/register/resend', { pendingToken: res.body.pendingToken })).statusCode, 503);
  mailBroken = false;

  // ---------- the referral and affiliate codes typed at sign-up are used when the account is made ----------
  reset();
  res = await begin({ username: 'referred', email: 'referred@x.com', referralCode: 'BOSS2024', affiliateCode: 'AFF123' });
  assert.deepStrictEqual(attached.referral, [], 'nobody is referred before the account exists');
  res = await post('/register/confirm', { pendingToken: res.body.pendingToken, code: codeMails[0].code });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(attached.referral, [[users[0]._id, 'BOSS2024']]);
  assert.deepStrictEqual(attached.affiliate, [[users[0]._id, 'AFF123']]);
  assert.strictEqual(res.body.referral.applied, true);
  reset();
  res = await begin({ username: 'plain', email: 'plain@x.com' });
  res = await post('/register/confirm', { pendingToken: res.body.pendingToken, code: codeMails[0].code });
  assert.strictEqual(res.body.referral, undefined);
  assert.deepStrictEqual(attached.affiliate, []);

  console.log('signup confirm tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
