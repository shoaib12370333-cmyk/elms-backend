// Suspend / permanent ban / reinstate, the mails that go with them, the appeal flow (a permanent ban cannot appeal, a second appeal joins the
// first one), the admin Appeals list, and: EVERY ELMS mail carries the layout and the Privacy / Terms links.
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
process.env.JWT_SECRET = 'test-secret';

// ---- a fake mail transport that keeps everything that leaves ----
const sent = [];
let smtpDown = false;
require.cache[require.resolve('nodemailer')] = { id: 'nodemailer', filename: require.resolve('nodemailer'), loaded: true, exports: { createTransport: () => ({ sendMail: async (m) => { if (smtpDown) throw new Error('smtp is down'); sent.push(m); return { messageId: 'id-' + sent.length }; } }) } };
Object.assign(process.env, { SMTP_HOST: 'smtp.test.local', SMTP_USER: 'noreply@elmstool.com', SMTP_PASS: 'x', SMTP_FROM: 'noreply@elmstool.com', SMTP_FROM_SUPPORT: 'support@elmstool.com', SMTP_FROM_SECURITY: 'security@elmstool.com', ADMIN_ALERT_EMAIL: 'owner@elmstool.com', FRONTEND_URL: 'https://elmstool.com' });

// ---- a tiny in-memory database ----
const db = { users: new Map(), tickets: [] };
let seq = 0;
const chain = (rows) => { let out = rows; const c = { sort() { out = out.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)); return c; }, limit(n) { out = out.slice(0, n); return c; }, lean: async () => out.map((r) => ({ ...r })) }; return c; };
stub('models/schemas/User', {
  findById: (id) => ({ lean: async () => { const u = db.users.get(String(id)); return u ? { ...u } : null; } }),
  findOne: ({ email }) => ({ lean: async () => { const u = [...db.users.values()].find((x) => x.email === email); return u ? { ...u } : null; } }),
  find: (q) => ({ lean: async () => [...db.users.values()].filter((u) => q._id.$in.map(String).includes(String(u._id))).map((u) => ({ ...u })) }),
  updateOne: async ({ _id }, up) => { Object.assign(db.users.get(String(_id)), up.$set || {}); return { matchedCount: 1 }; },
});
stub('models/schemas/Session', { updateMany: async () => ({}), find: () => chain([]), findOne: () => ({ lean: async () => null }), updateOne: async () => ({}), create: async (d) => d });
stub('models/schemas/LoginEvent', { exists: async () => null, create: async (d) => d, updateOne: async () => ({}), aggregate: async () => [], find: () => chain([]) });
stub('models/schemas/Listing', { updateMany: async () => ({}) });
stub('models/schemas/IpBlock', { findOne: () => ({ lean: async () => null }), exists: async () => null, find: () => chain([]) });
stub('models/systemNotificationsModel', { createSystemNotification: async () => ({}) });
stub('models/schemas/SupportTicket', {
  create: async (d) => { const t = { _id: 't' + (++seq), status: 'open', thread: [], ref: 'ref' + seq, createdAt: new Date(Date.now() + seq * 1000), ...d }; db.tickets.push(t); return { ...t, toObject: () => t }; },
  findOneAndUpdate: async (q, up) => {
    const t = db.tickets.find((x) => x.source === q.source && x.status === q.status && x.fromEmail === q.fromEmail);
    if (!t) return null;
    if (up.$push) t.thread.push(up.$push.thread);
    Object.assign(t, up.$set || {});
    return { ...t, toObject: () => t };
  },
  find: (q) => chain(db.tickets.filter((t) => t.source === q.source)),
  updateMany: async (q, up) => {
    db.tickets.filter((t) => t.source === q.source && t.status === q.status && q.$or.some((c) => (c.userId && String(t.userId) === String(c.userId)) || (c.fromEmail && t.fromEmail === c.fromEmail)))
      .forEach((t) => { Object.assign(t, up.$set); t.thread.push(up.$push.thread); });
  },
});
const alerts = [];
stub('services/supportAssistantService', { alertAdmin: async (ticket, o) => { alerts.push({ ticket, ...o }); } });

const guard = require('../services/accessGuard');
const svc = require('../services/accessAdminService');
const email = require('../services/emailService');
const mailTemplate = require('../services/mailTemplate');
const appealService = require('../services/appealService');

const ADMIN = 'aaaaaaaaaaaaaaaaaaaa0001'; const BOB = 'aaaaaaaaaaaaaaaaaaaa0002'; const CARA = 'aaaaaaaaaaaaaaaaaaaa0003';
const seed = () => {
  db.users.clear(); db.tickets.length = 0; sent.length = 0; alerts.length = 0; smtpDown = false; guard.invalidate();
  db.users.set(ADMIN, { _id: ADMIN, role: 'admin', email: 'admin@x.com', name: 'Boss' });
  db.users.set(BOB, { _id: BOB, role: 'user', email: 'bob@x.com', name: 'Bob Builder', suspendedAt: null, suspendedPermanent: false });
  db.users.set(CARA, { _id: CARA, role: 'user', email: 'cara@x.com', name: 'Cara', suspendedAt: null, suspendedPermanent: false });
};
const rejects = (fn, status, re, label) => assert.rejects(fn, (e) => e.statusCode === status && re.test(e.message), label);
const handler = (router, method, p) => { const l = router.stack.find((x) => x.route && x.route.path === p && x.route.methods[method]); assert.ok(l, method + ' ' + p); return l.route.stack[l.route.stack.length - 1].handle; };
const fakeRes = () => { const r = { statusCode: 200 }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };

(async () => {
  // ================= the guard: a permanent ban has no appeal =================
  seed();
  db.users.get(BOB).suspendedAt = new Date(); db.users.get(BOB).suspendedReason = 'Fake orders.';
  let denied = await guard.checkAccess({ user: db.users.get(BOB), ip: '1.1.1.1' });
  assert.strictEqual(denied.permanent, false); assert.match(denied.reason, /appeal/i);
  assert.strictEqual(guard.blockedError(denied).blocked.permanent, undefined, 'a plain suspension does not carry the flag');
  db.users.get(BOB).suspendedPermanent = true;
  denied = await guard.checkAccess({ user: db.users.get(BOB), ip: '1.1.1.1' });
  assert.strictEqual(denied.permanent, true);
  assert.strictEqual(denied.reason, 'Fake orders.', 'the reason as the admin wrote it, without the appeal hint');
  assert.strictEqual(guard.blockedError(denied).blocked.permanent, true);
  assert.strictEqual(await guard.checkAccess({ user: { ...db.users.get(ADMIN), suspendedAt: new Date(), suspendedPermanent: true }, ip: '1.1.1.1' }), null, 'an admin is never locked out');

  // ================= suspend: the person is told =================
  seed();
  let out = await svc.suspendUser({ userId: BOB, reason: 'Repeated chargebacks <b>now</b>', note: 'private', adminId: ADMIN });
  assert.deepStrictEqual([out.permanent, out.emailed], [false, true]);
  assert.strictEqual(db.users.get(BOB).suspendedPermanent, false);
  let m = sent.at(-1);
  assert.strictEqual(m.to, 'bob@x.com');
  assert.match(m.subject, /suspended/); assert.ok(m.from.includes('security@elmstool.com'), m.from); assert.strictEqual(m.replyTo, 'support@elmstool.com');
  assert.ok(m.html.includes('Account suspended') && m.html.includes('#FFFAEB'), 'amber banner');
  assert.ok(m.html.includes('Repeated chargebacks &lt;b&gt;now&lt;/b&gt;') && !m.html.includes('<b>now</b>'), 'the admin text is escaped');
  assert.ok(m.html.includes('appeal form') && m.html.includes('Go to sign in and appeal'), 'a suspension explains how to appeal');
  assert.ok(m.html.includes('Hi Bob,'));
  assert.match(m.text, /appeal form/); assert.ok(!m.text.includes('private'), 'the private note is never mailed');
  assert.ok(!m.html.includes('private'));

  // ================= permanent ban: mailed, no appeal wording, cannot be turned back into a suspension =================
  out = await svc.suspendUser({ userId: BOB, reason: 'Counterfeit goods.', adminId: ADMIN, permanent: true });
  assert.deepStrictEqual([out.permanent, out.emailed], [true, true]);
  assert.strictEqual(db.users.get(BOB).suspendedPermanent, true);
  m = sent.at(-1);
  assert.match(m.subject, /permanently banned/);
  assert.ok(m.html.includes('Permanent ban') && m.html.includes('#FEF3F2'), 'red banner');
  assert.ok(m.html.includes('final') && m.html.includes('not available for a permanent ban'));
  assert.ok(!m.html.includes('Go to sign in and appeal') && !/try to sign in/i.test(m.html), 'no appeal steps in a ban mail');
  assert.ok(m.html.includes('terms.html#ending'), 'points to the Terms section on suspension and ending');
  await rejects(() => svc.suspendUser({ userId: BOB, reason: 'softer now', adminId: ADMIN }), 400, /permanently banned/, 'a ban is not quietly turned into a suspension');
  await rejects(() => svc.suspendUser({ userId: ADMIN, reason: 'no way', adminId: ADMIN, permanent: true }), 400, /admin account/, 'an admin cannot be banned');

  // a mail problem never undoes the action; the admin is told the mail did not go
  seed(); smtpDown = true;
  out = await svc.suspendUser({ userId: CARA, reason: 'Testing mail down', adminId: ADMIN });
  assert.strictEqual(out.emailed, false); assert.ok(db.users.get(CARA).suspendedAt, 'still suspended');
  smtpDown = false;

  // ================= reinstate =================
  // a permanent ban needs a real message first; nothing changes without it
  seed();
  await svc.suspendUser({ userId: BOB, reason: 'Fraud ring.', adminId: ADMIN, permanent: true });
  sent.length = 0;
  for (const bad of [undefined, '', '   ', 'short']) {
    await rejects(() => svc.unsuspendUser(BOB, { message: bad }), 400, /Write a message to the person first/, 'message: ' + JSON.stringify(bad));
  }
  assert.ok(db.users.get(BOB).suspendedAt && db.users.get(BOB).suspendedPermanent, 'still banned');
  assert.strictEqual(sent.length, 0, 'no mail without the message');
  await rejects(() => svc.unsuspendUser(BOB), 400, /message/, 'no options at all');

  // an open appeal exists (from before it was made permanent)
  db.tickets.push({ _id: 'old1', source: 'appeal', status: 'open', fromEmail: 'bob@x.com', userId: BOB, thread: [], createdAt: new Date() });
  out = await svc.unsuspendUser(BOB, { message: 'We looked again. You may return, <please> follow the rules.' });
  assert.deepStrictEqual([out.emailed, out.wasBanned, out.wasSuspended], [true, true, true]);
  assert.strictEqual(db.users.get(BOB).suspendedAt, null); assert.strictEqual(db.users.get(BOB).suspendedPermanent, false); assert.strictEqual(db.users.get(BOB).suspendedReason, null);
  m = sent.at(-1);
  assert.match(m.subject, /active again/);
  assert.ok(m.html.includes('Account reinstated') && m.html.includes('#ECFDF3'), 'green banner');
  assert.ok(m.html.includes('Message from our team') && m.html.includes('We looked again. You may return, &lt;please&gt; follow the rules.'), 'the admin message is in the mail, escaped');
  assert.ok(m.html.includes('permanently banned, and our team has now lifted the ban'));
  assert.match(m.text, /We looked again/);
  assert.strictEqual(db.tickets[0].status, 'resolved', 'the open appeal is closed');
  assert.match(db.tickets[0].thread.at(-1).text, /reinstated/);

  // a plain suspension can be lifted without a message
  seed();
  await svc.suspendUser({ userId: CARA, reason: 'Check.', adminId: ADMIN });
  sent.length = 0;
  out = await svc.unsuspendUser(CARA);
  assert.deepStrictEqual([out.emailed, out.wasBanned], [true, false]);
  m = sent.at(-1);
  assert.ok(m.html.includes('lifted the suspension') && !m.html.includes('Message from our team'));
  // an account that was not suspended: nothing to lift, nobody is mailed
  sent.length = 0;
  out = await svc.unsuspendUser(CARA);
  assert.deepStrictEqual([out.emailed, out.wasSuspended], [false, false]); assert.strictEqual(sent.length, 0);
  await rejects(() => svc.unsuspendUser('aaaaaaaaaaaaaaaaaaaa9999'), 404, /not found/i);

  // ================= the appeal form =================
  seed();
  const appealsRouter = require('../routes/appeals');
  const post = async (body) => { const res = fakeRes(); await handler(appealsRouter, 'post', '/')({ body, ip: '9.9.9.9', headers: {} }, res); return res; };
  let res = await post({ email: 'nope', message: 'hello there' }); assert.strictEqual(res.statusCode, 400);
  res = await post({ email: 'cara@x.com', message: 'x' }); assert.strictEqual(res.statusCode, 400);

  await svc.suspendUser({ userId: CARA, reason: 'Shared connection.', adminId: ADMIN });
  res = await post({ email: 'Cara@X.com', message: 'I did nothing wrong, it is a shared office connection.' });
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(db.tickets.length, 1);
  assert.strictEqual(db.tickets[0].source, 'appeal'); assert.strictEqual(String(db.tickets[0].userId), CARA);
  assert.match(db.tickets[0].message, /Account is suspended: Shared connection\./);
  assert.strictEqual(alerts.length, 1);
  // a second message while the first is open joins it: one row for the admin
  res = await post({ email: 'cara@x.com', message: 'Any news? I really need my store back.' });
  assert.strictEqual(res.body.success, true); assert.strictEqual(db.tickets.length, 1, 'no second ticket');
  assert.strictEqual(db.tickets[0].thread.length, 1); assert.match(db.tickets[0].thread[0].text, /Any news/);
  assert.strictEqual(alerts.length, 2); assert.match(alerts[1].reason, /open appeal/);
  // once the appeal is answered, a new one is a new ticket
  db.tickets[0].status = 'resolved';
  await post({ email: 'cara@x.com', message: 'Second appeal after the answer.' });
  assert.strictEqual(db.tickets.length, 2);
  // an email with no account still reaches the admin (and says so)
  await post({ email: 'stranger@nowhere.com', message: 'I was blocked from a hotel wifi.' });
  assert.match(db.tickets.at(-1).message, /No ELMS account has this email/);

  // a permanently banned account cannot appeal: nothing is saved, nobody is alerted
  await svc.suspendUser({ userId: BOB, reason: 'Counterfeit goods.', adminId: ADMIN, permanent: true });
  const before = db.tickets.length; const alertsBefore = alerts.length;
  res = await post({ email: 'bob@x.com', message: 'Please reconsider, I am sorry about this.' });
  assert.strictEqual(res.statusCode, 403); assert.strictEqual(res.body.permanent, true); assert.match(res.body.error, /permanent ban/);
  assert.strictEqual(db.tickets.length, before); assert.strictEqual(alerts.length, alertsBefore);

  // ================= the admin Appeals list =================
  const list = await appealService.listAppeals();
  assert.strictEqual(list.open, 2);
  assert.deepStrictEqual(list.appeals.map((a) => a.status), ['open', 'open', 'resolved'], 'open ones first');
  const cara = list.appeals.find((a) => a.email === 'cara@x.com' && a.status === 'open');
  assert.deepStrictEqual([cara.account.suspended, cara.account.permanent, cara.account.reason], [true, false, 'Shared connection.']);
  assert.strictEqual(list.appeals.find((a) => a.email === 'stranger@nowhere.com').account, null, 'no account behind this email');
  assert.ok(cara.message && cara.id && cara.ref);

  // ================= the admin routes =================
  stub('middleware/requireAuth', { requireAuth: (q, s, n) => n() });
  stub('middleware/requireAdmin', { requireAdmin: (q, s, n) => n(), requireSuperAdmin: (q, s, n) => n() });
  const sec = require('../routes/adminSecurity');
  const call = async (method, p, params, body) => { const r = fakeRes(); await handler(sec, method, p)({ params, body, userId: ADMIN }, r); return r; };
  seed();
  res = await call('post', '/users/:id/suspend', { id: CARA }, { reason: 'Plain suspension.' });
  assert.deepStrictEqual([res.body.success, res.body.permanent, res.body.emailed], [true, false, true]);
  res = await call('post', '/users/:id/suspend', { id: CARA }, { reason: 'Now for good.', permanent: true });
  assert.deepStrictEqual([res.body.permanent, res.body.emailed], [true, true]);
  res = await call('post', '/users/:id/suspend', { id: CARA }, { reason: 'string true is not enough', permanent: 'true' });
  assert.strictEqual(res.statusCode, 400, 'only a real true makes it permanent; the ban cannot be softened by accident');
  res = await call('post', '/users/:id/unsuspend', { id: CARA }, {});
  assert.strictEqual(res.statusCode, 400); assert.match(res.body.error, /message/);
  res = await call('post', '/users/:id/unsuspend', { id: CARA }, { message: 'Welcome back, please read the Terms.' });
  assert.deepStrictEqual([res.body.success, res.body.emailed, res.body.wasBanned], [true, true, true]);
  res = await call('post', '/users/:id/unsuspend', { id: 'not-an-id' }, {});
  assert.strictEqual(res.statusCode, 404);
  res = await call('get', '/appeals', {}, {});
  assert.deepStrictEqual([res.body.success, Array.isArray(res.body.appeals), res.body.open], [true, true, 0]);

  // ================= every mail carries the layout and the legal links =================
  seed(); sent.length = 0;
  const to = 'person@example.org';
  const samples = {
    sendWelcomeEmail: () => email.sendWelcomeEmail({ to, name: 'Pat', credits: 20 }),
    sendSignupCodeEmail: () => email.sendSignupCodeEmail({ to, code: '123456' }),
    sendVoucherEmail: () => email.sendVoucherEmail({ to, what: '10% off', note: 'Enjoy', expiresAt: new Date(), redeem: false }),
    sendPurchaseReceiptEmail: () => email.sendPurchaseReceiptEmail({ to, credits: 500, priceUsd: 9, transactionId: 'tx1', when: new Date() }),
    sendInvoiceEmail: () => email.sendInvoiceEmail({ to, subject: 'Invoice 1', text: 'Your invoice.', html: '<p>A bare fragment written without the layout.</p>' }),
    sendPlanEndedEmail: () => email.sendPlanEndedEmail({ to, planName: 'Pro', endedAt: new Date() }),
    sendAffiliateDecisionEmail: async () => { await email.sendAffiliateDecisionEmail({ to, approved: true, link: 'https://elmstool.com/?ref=x', percent: 20 }); await email.sendAffiliateDecisionEmail({ to, approved: false, note: 'No fit' }); },
    sendAffiliatePaidEmail: () => email.sendAffiliatePaidEmail({ to, amountUsd: 12.5, network: 'USDT', address: '0xabc', txHash: '0xdef' }),
    sendCustomMail: () => email.sendCustomMail({ from: 'noreply', to, subject: 'Hello', body: 'Hi there' }),
    sendTicketReplyEmail: () => email.sendTicketReplyEmail({ to, subject: 'Help', reply: 'Done.', ref: 'abc' }),
    sendAdminAlert: () => email.sendAdminAlert({ subject: 'Something', lines: ['line one'] }),
    sendAnnouncementEmail: () => email.sendAnnouncementEmail({ to, subject: 'News', body: 'Big news', unsubscribeUrl: 'https://x/u' }),
    sendSecurityEmail: () => email.sendSecurityEmail({ to, subject: 'Alert', title: 'Alert', paragraphs: ['One.'] }),
    sendNewDeviceEmail: () => email.sendNewDeviceEmail({ to, device: 'Chrome', where: 'Paris', method: 'google', when: new Date() }),
    sendPasswordResetOtp: () => email.sendPasswordResetOtp({ to, code: '654321' }),
    sendPasswordChangedEmail: () => email.sendPasswordChangedEmail({ to }),
    sendPasswordRemovedEmail: () => email.sendPasswordRemovedEmail({ to }),
    sendPasswordResetRequestedEmail: () => email.sendPasswordResetRequestedEmail({ to }),
    sendNewLoginEmail: () => email.sendNewLoginEmail({ to, method: 'password' }),
    sendAccountActionEmail: async () => { for (const action of ['suspended', 'banned', 'reinstated']) await email.sendAccountActionEmail({ to, name: 'Pat', action, reason: 'r', message: 'm' }); },
  };
  const senders = Object.keys(email).filter((k) => /^send[A-Z]/.test(k));
  assert.deepStrictEqual(senders.filter((k) => !samples[k]), [], 'a new send function needs a sample here, so it is checked for the layout too');
  for (const name of Object.keys(samples)) {
    const from = sent.length;
    await samples[name]();
    const mails = sent.slice(from);
    assert.ok(mails.length >= 1, name + ' sent nothing');
    for (const msg of mails) {
      assert.ok(msg.html.includes(mailTemplate.LAYOUT_MARK), name + ': the ELMS layout');
      assert.ok(msg.html.includes('logo-wordmark.png'), name + ': logo');
      assert.ok(msg.html.includes('href="https://elmstool.com/policy.html"') && msg.html.includes('Privacy Policy'), name + ': Privacy Policy link');
      assert.ok(msg.html.includes('href="https://elmstool.com/terms.html"') && msg.html.includes('Terms of Service'), name + ': Terms link');
      assert.match(msg.text, /Privacy Policy: https:\/\/elmstool\.com\/policy/, name + ': text version has the Privacy link');
      assert.match(msg.text, /Terms of Service: https:\/\/elmstool\.com\/terms\.html/, name + ': text version has the Terms link');
      assert.strictEqual(msg.text.split('Privacy Policy: https').length, 2, name + ': the legal lines appear once, not twice');
    }
  }

  // the safety net itself: a message written with no layout at all still gets one
  let wrapped = mailTemplate.ensureLayout({ subject: 'Plain', text: 'Just some text.\n\nSecond <line>.' });
  assert.ok(wrapped.html.includes(mailTemplate.LAYOUT_MARK) && wrapped.html.includes('Second &lt;line&gt;.') && wrapped.text.includes('Terms of Service: '));
  wrapped = mailTemplate.ensureLayout({ subject: 'Foreign', text: 'Body', html: '<html><body>someone else\'s document</body></html>' });
  assert.ok(wrapped.html.includes(mailTemplate.LAYOUT_MARK) && !wrapped.html.includes("someone else's document"), 'a foreign whole document is rebuilt, never nested');
  const laid = mailTemplate.layout({ title: 'T', bodyHtml: '<p>x</p>' });
  assert.strictEqual(mailTemplate.ensureLayout({ subject: 's', text: 'x', html: laid }).html, laid, 'a mail that already has the layout is left as it is');

  console.log('ban + appeals + mail layout tests passed');
})().catch((err) => { console.error(err); process.exit(1); });
