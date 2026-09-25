// Every new account gets a welcome mail, and the welcome popup shows the credits the account REALLY got (whatever the admin had set
// at that moment). Part 1 runs the real emailService against a fake mail transport; part 2 runs the real usersModel and the
// /welcome-seen route on in-memory stand-ins.
const assert = require('assert');
const path = require('path');
process.env.JWT_SECRET = 'test-secret';
process.env.ENCRYPTION_KEY = 'test-encryption-key-test-encryption-key';
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

// a fake mail transport that keeps what was sent
const sent = [];
require.cache[require.resolve('nodemailer')] = { id: 'nodemailer', filename: require.resolve('nodemailer'), loaded: true, exports: { createTransport: () => ({ sendMail: async (m) => { sent.push(m); return { messageId: 'id-' + sent.length }; } }) } };
Object.assign(process.env, { SMTP_HOST: 'smtp.test.local', SMTP_USER: 'noreply@elmstool.com', SMTP_PASS: 'x', SMTP_FROM: 'noreply@elmstool.com', SMTP_FROM_SUPPORT: 'support@elmstool.com', FRONTEND_URL: 'https://elmstool.com' });

(async () => {
  // ---------- part 1: the mail ----------
  const email = require('../services/emailService');
  await email.sendWelcomeEmail({ to: 'new@x.com', name: 'Rao Shoaib', credits: 10 });
  let m = sent.at(-1);
  assert.strictEqual(m.to, 'new@x.com');
  assert.ok(m.from.includes('noreply@elmstool.com'), m.from);
  assert.strictEqual(m.replyTo, 'support@elmstool.com');
  assert.strictEqual(m.subject, 'Welcome to ELMS: 10 free credits to try it');
  assert.ok(m.text.startsWith('Hi Rao,') && m.text.includes('We added 10 free credits') && m.text.includes('https://elmstool.com/dashboard'), m.text);
  assert.ok(m.html.includes('logo-wordmark.png') && m.html.includes('Open ELMS') && m.html.includes('10 free credits are in your account'));

  await email.sendWelcomeEmail({ to: 'a@x.com', name: 'A', credits: 50 });
  assert.ok(sent.at(-1).subject.includes('50 free credits') && sent.at(-1).text.includes('We added 50 free credits'), 'the amount follows what was given');
  await email.sendWelcomeEmail({ to: 'a@x.com', name: 'A', credits: 1 });
  assert.ok(sent.at(-1).text.includes('We added 1 free credit ') && !sent.at(-1).text.includes('1 free credits'), 'singular for one credit');
  await email.sendWelcomeEmail({ to: 'a@x.com', name: 'A', credits: 0 });
  assert.strictEqual(sent.at(-1).subject, 'Welcome to ELMS');
  assert.ok(!/free credit/.test(sent.at(-1).text) && !/free credit/.test(sent.at(-1).html), 'no credits, no credit talk');
  await email.sendWelcomeEmail({ to: 'a@x.com', name: '<b>Eve</b>', credits: 5 });
  assert.ok(!sent.at(-1).html.includes('<b>Eve'), 'a name is escaped in the html');
  await email.sendWelcomeEmail({ to: 'a@x.com', credits: 5 });
  assert.ok(sent.at(-1).text.startsWith('Hi,'), 'no name: a plain greeting');

  // ---------- part 2: sign-up ----------
  const store = [];
  class Doc {
    constructor(o) { Object.assign(this, o); }
    async save() { return this; }
    toObject() { const { save, toObject, ...rest } = this; return { ...rest }; }
  }
  const matches = (u, q) => Object.entries(q).every(([k, v]) => (v === null ? u[k] == null : u[k] === v));
  const User = {
    findOne: async (q) => store.find((u) => matches(u, q)) || null,
    exists: async (q) => (store.find((u) => matches(u, q)) ? { _id: 1 } : null),
    findById: async (id) => store.find((u) => u._id === id) || null,
    updateOne: async (filter, update) => { const d = store.find((u) => matches(u, filter)); if (d) Object.assign(d, update.$set); return { matchedCount: d ? 1 : 0 }; },
    create: async (o) => {
      if (store.some((u) => u.email === o.email || (o.username && u.username === o.username))) throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
      const d = new Doc({ _id: 'u' + (store.length + 1), role: 'user', creditBalance: 0, passwordHash: null, googleId: null, welcomePopupSeenAt: null, ...o });
      store.push(d);
      return d;
    },
  };
  const settings = { welcomeBonusEnabled: true, welcomeBonusCredits: 10 };
  const welcome = [];
  let mailMode = 'ok';
  stub('models/schemas/User.js', User);
  stub('models/settingsModel.js', { getSettings: async () => ({ ...settings }) });
  stub('models/ebayAccountsModel.js', {});
  stub('services/sessionTracker.js', { endAllSessions: async () => 1, requestContext: () => ({ ip: '1.2.3.4', deviceId: 'd' }), startSession: async () => 'sid', recordFailedLogin: () => {} });
  stub('services/emailService.js', {
    sendAdminAlert: async () => {}, sendPasswordRemovedEmail: async () => {}, sendPasswordResetOtp: async () => {}, sendPasswordChangedEmail: async () => {}, sendPasswordResetRequestedEmail: async () => {}, sendNewLoginEmail: async () => {},
    sendWelcomeEmail: (mail) => {
      if (mailMode === 'throws') throw new Error('mail is broken');
      if (mailMode === 'rejects') return Promise.reject(new Error('smtp is down'));
      welcome.push(mail);
      return Promise.resolve();
    },
  });
  stub('services/googleAuthService.js', { verifyGoogleToken: async () => ({}) });
  stub('services/accessGuard.js', { checkNewAccount: async () => null, blockedError: (d) => Object.assign(new Error('blocked'), { statusCode: 403, blocked: d }) });
  const users = require('../models/usersModel');
  const signUp = (username, opts) => users.registerWithPassword({ username, email: username + '@x.com', password: 'a-long-password-1' }, opts);

  // the admin has 10 set: the account gets 10, the popup says 10, the welcome mail says 10
  let u = await signUp('newbie', { welcomeBonus: true });
  assert.strictEqual(u.creditBalance, 10);
  assert.deepStrictEqual(u.welcomePopup, { credits: 10 });
  assert.deepStrictEqual(welcome, [{ to: 'newbie@x.com', name: 'newbie', credits: 10 }]);

  // the admin changes it to 50: the next account gets 50 and a popup for 50; the first one is not touched
  settings.welcomeBonusCredits = 50;
  const u2 = await signUp('second', { welcomeBonus: true });
  assert.deepStrictEqual(u2.welcomePopup, { credits: 50 });
  assert.strictEqual(welcome.at(-1).credits, 50);
  assert.deepStrictEqual((await users.getUserById(u.id)).welcomePopup, { credits: 10 }, 'the first account keeps what it was given');

  // welcome bonus switched off, or refused by the abuse guard: the account still gets the mail, but no credits and no popup
  settings.welcomeBonusEnabled = false;
  const off = await signUp('nobonus', { welcomeBonus: true });
  assert.strictEqual(off.creditBalance, 0);
  assert.strictEqual(off.welcomePopup, null);
  assert.strictEqual(welcome.at(-1).credits, 0);
  settings.welcomeBonusEnabled = true;
  const denied = await signUp('denied', { welcomeBonus: false });
  assert.strictEqual(denied.creditBalance, 0);
  assert.strictEqual(denied.welcomePopup, null);
  assert.deepStrictEqual(welcome.at(-1), { to: 'denied@x.com', name: 'denied', credits: 0 });

  // a brand-new Google account: same; signing in again does not send another mail
  const before = welcome.length;
  const g = await users.findOrCreateUser({ googleId: 'g-1', email: 'gina@x.com', name: 'Gina Lee', picture: 'p' }, { welcomeBonus: true });
  assert.deepStrictEqual(g.welcomePopup, { credits: 50 });
  assert.deepStrictEqual(welcome.at(-1), { to: 'gina@x.com', name: 'Gina Lee', credits: 50 });
  await users.findOrCreateUser({ googleId: 'g-1', email: 'gina@x.com', name: 'Gina Lee', picture: 'p' }, { welcomeBonus: true });
  assert.strictEqual(welcome.length, before + 1, 'one welcome mail per account');

  // Google linking to an account that already existed is not a new account: no mail, no popup
  store.push(new Doc({ _id: 'old1', email: 'old@x.com', username: 'oldtimer', passwordHash: 'h', googleId: null, creditBalance: 500, role: 'user', welcomePopupSeenAt: null }));
  const linked = await users.findOrCreateUser({ googleId: 'g-2', email: 'old@x.com', name: 'Old', picture: 'p' }, { welcomeBonus: true });
  assert.strictEqual(linked.welcomePopup, null);
  assert.strictEqual(welcome.length, before + 1, 'no welcome mail for an existing account');
  assert.strictEqual((await users.getUserById('old1')).welcomePopup, null, 'an account from before this feature never gets a popup');

  // closing the popup: it is gone for good, the first close is kept, and other accounts are not affected
  const route = require('../routes/auth');
  const handler = (method, p) => { const l = route.stack.find((x) => x.route && x.route.path === p && x.route.methods[method]); assert.ok(l, method + ' ' + p); return l.route.stack[l.route.stack.length - 1].handle; };
  const fakeRes = () => { const r = { statusCode: 200 }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
  let res = fakeRes();
  await handler('post', '/welcome-seen')({ userId: u.id }, res);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual((await users.getUserById(u.id)).welcomePopup, null, 'closed: not shown again');
  const firstClose = store.find((x) => x._id === u.id).welcomePopupSeenAt;
  assert.ok(firstClose instanceof Date);
  await new Promise((r) => setTimeout(r, 5));
  await handler('post', '/welcome-seen')({ userId: u.id }, fakeRes());
  assert.strictEqual(store.find((x) => x._id === u.id).welcomePopupSeenAt.getTime(), firstClose.getTime(), 'the first close is kept');
  assert.deepStrictEqual((await users.getUserById(u2.id)).welcomePopup, { credits: 50 }, 'someone else still sees theirs');

  // a problem saving it is an answer, not a crash
  const realUpdate = User.updateOne;
  User.updateOne = async () => { throw new Error('db down'); };
  res = fakeRes();
  await handler('post', '/welcome-seen')({ userId: u2.id }, res);
  assert.strictEqual(res.statusCode, 500);
  User.updateOne = realUpdate;

  // a broken or slow mail system never stops a sign-up
  mailMode = 'throws';
  const a = await signUp('mailbroken1', { welcomeBonus: true });
  assert.strictEqual(a.creditBalance, 50);
  mailMode = 'rejects';
  const b = await signUp('mailbroken2', { welcomeBonus: true });
  assert.deepStrictEqual(b.welcomePopup, { credits: 50 });
  await new Promise((r) => setTimeout(r, 10)); // let the rejected mail be logged, not thrown
  mailMode = 'ok';

  console.log('welcome signup tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
