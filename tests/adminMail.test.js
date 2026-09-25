// Admin mail: only configured senders are offered, a one-off mail goes from the chosen sender to any address, bad input is refused,
// announcements remember their sender.
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
const fakeRes = () => { const r = { statusCode: 200 }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
const handler = (router, method, p) => { const l = router.stack.find((x) => x.route && x.route.path === p && x.route.methods[method]); assert.ok(l, method + ' ' + p); return l.route.stack[l.route.stack.length - 1].handle; };

// a fake mail transport that keeps what was sent
const sent = [];
require.cache[require.resolve('nodemailer')] = { id: 'nodemailer', filename: require.resolve('nodemailer'), loaded: true, exports: { createTransport: () => ({ sendMail: async (m) => { sent.push(m); return { messageId: 'id-' + sent.length }; } }) } };

process.env.SMTP_HOST = 'smtp.test.local';
const ENV = ['SMTP_FROM', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM_SUPPORT', 'SMTP_FROM_BILLING', 'SMTP_FROM_SECURITY', 'SMTP_FROM_ADMIN', 'SMTP_USER_BILLING', 'SMTP_PASS_BILLING', 'SMTP_USER_SECURITY', 'SMTP_PASS_SECURITY'];
const setEnv = (o) => { ENV.forEach((k) => { delete process.env[k]; }); Object.assign(process.env, o); };

(async () => {
  const email = require('../services/emailService');

  // nothing set up: no senders to offer
  setEnv({});
  assert.deepStrictEqual(email.availableSenders(), []);
  await assert.rejects(() => email.sendCustomMail({ from: 'billing', to: 'a@b.com', subject: 'Hi', body: 'Hello' }), /configured senders/);

  // only the default login: the no-reply sender exists
  setEnv({ SMTP_USER: 'noreply@elmstool.com', SMTP_PASS: 'x', SMTP_FROM: 'noreply@elmstool.com' });
  assert.deepStrictEqual(email.availableSenders().map((s) => s.id), ['noreply']);

  // support by address, billing with its own mailbox login, security not set up, admin by address
  setEnv({ SMTP_USER: 'noreply@elmstool.com', SMTP_PASS: 'x', SMTP_FROM: 'noreply@elmstool.com', SMTP_FROM_SUPPORT: 'support@elmstool.com', SMTP_USER_BILLING: 'billing@elmstool.com', SMTP_PASS_BILLING: 'y', SMTP_FROM_ADMIN: 'owner@elmstool.com' });
  const list = email.availableSenders();
  assert.deepStrictEqual(list.map((s) => [s.id, s.address]), [['noreply', 'noreply@elmstool.com'], ['support', 'support@elmstool.com'], ['billing', 'billing@elmstool.com'], ['admin', 'owner@elmstool.com']]);
  assert.ok(!list.some((s) => s.id === 'security'), 'a sender that is not set up is not offered');

  // a one-off mail goes from the chosen sender to any address, branded, with a reply address
  await email.sendCustomMail({ from: 'billing', to: 'someone@gmail.com', subject: 'About your payment', body: 'Hello,\n\nThis is a <test>.' });
  const m = sent.at(-1);
  assert.strictEqual(m.to, 'someone@gmail.com');
  assert.ok(m.from.includes('billing@elmstool.com') && m.from.includes('Billing'), m.from);
  assert.strictEqual(m.replyTo, 'support@elmstool.com');
  assert.ok(m.html.includes('logo-wordmark.png') && m.html.includes('About your payment'));
  assert.ok(m.html.includes('&lt;test&gt;') && !m.html.includes('<test>'), 'the message text is escaped');
  assert.ok(m.text.includes('This is a <test>.'));
  await email.sendCustomMail({ from: 'support', to: 'x@y.org', subject: 'Re: hi', body: 'ok' });
  assert.ok(sent.at(-1).from.includes('support@elmstool.com'));
  assert.strictEqual(sent.at(-1).replyTo, undefined, 'support replies to itself');

  // announcements go from the sender they were written for
  await email.sendAnnouncementEmail({ to: 'u@x.com', subject: 'News', body: 'Big news', unsubscribeUrl: 'https://x/u', sender: 'billing' });
  assert.ok(sent.at(-1).from.includes('billing@elmstool.com'));
  await email.sendAnnouncementEmail({ to: 'u@x.com', subject: 'News', body: 'Big news', unsubscribeUrl: 'https://x/u' });
  assert.ok(sent.at(-1).from.includes('support@elmstool.com'), 'support when none is chosen');

  // the route
  stub('middleware/requireAuth', { requireAuth: (q, s, n) => n() });
  stub('middleware/requireAdmin', { requireAdmin: (q, s, n) => n(), requireSuperAdmin: (q, s, n) => n() });
  const router = require('../routes/admin');
  const call = async (body) => { const res = fakeRes(); const r = router.stack.find((x) => x.route && x.route.path === '/mail/send' && x.route.methods.post); await r.route.stack[r.route.stack.length - 1].handle({ userId: 'admin1', body }, res); return res; };
  let res = await call({ from: 'billing', to: 'client@gmail.com', subject: 'Hello', body: 'Your invoice is attached.' });
  assert.strictEqual(res.body.success, true);
  assert.ok(sent.at(-1).from.includes('billing@elmstool.com') && sent.at(-1).to === 'client@gmail.com');
  const before = sent.length;
  for (const bad of [
    { from: 'billing', to: 'not an email', subject: 'Hello', body: 'Hi there' },
    { from: 'billing', to: 'a@b.com, c@d.com', subject: 'Hello', body: 'Hi there' },
    { from: 'billing', to: 'a@b.com', subject: 'Line1\nBcc: evil@x.com', body: 'Hi there' },
    { from: 'billing', to: 'a@b.com', subject: 'Hello', body: '' },
    { from: 'security', to: 'a@b.com', subject: 'Hello', body: 'Hi there' },
    { from: 'nobody', to: 'a@b.com', subject: 'Hello', body: 'Hi there' },
  ]) {
    res = await call(bad);
    assert.strictEqual(res.statusCode, 400, JSON.stringify(bad));
  }
  assert.strictEqual(sent.length, before, 'nothing was sent for bad input');
  res = await call({ to: 'a@b.com', subject: 'No sender chosen', body: 'Goes from support' });
  assert.strictEqual(res.body.from, 'support');

  console.log('adminMail tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
