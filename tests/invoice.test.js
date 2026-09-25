// Invoices: number, only what was bought, discount line only when there was a discount, the payment method that was used, PDF, branded mails.
const assert = require('assert');
const path = require('path');
const abs = (rel) => require.resolve(path.join('..', rel));
const stub = (rel, exports) => { const p = abs(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
const fakeRes = () => { const r = { statusCode: 200, headers: {} }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; r.set = (h) => { Object.assign(r.headers, h); return r; }; r.send = (b) => { r.sent = b; return r; }; return r; };
const handler = (router, method, p) => { const l = router.stack.find((x) => x.route && x.route.path === p && x.route.methods[method]); assert.ok(l, method + ' ' + p); return l.route.stack[l.route.stack.length - 1].handle; };

const purchases = {
  a: { id: 'a', userId: 'u1', provider: 'cashtap', providerTransactionId: 'CT-1', priceUsd: 120, listPriceUsd: 120, discountPercent: 0, creditsGranted: 600, status: 'completed', planName: 'Pro', paymentMethod: null, createdAt: '2026-09-25T10:00:00Z' },
  b: { id: 'b', userId: 'u1', provider: 'paddle', providerTransactionId: 'txn_2', priceUsd: 108, listPriceUsd: 120, discountPercent: 10, creditsGranted: 600, status: 'completed', planName: 'Pro', paymentMethod: 'Visa card', createdAt: '2026-09-26T10:00:00Z' },
  v: { id: 'v', userId: 'u1', provider: 'voucher', providerTransactionId: 'V-1', priceUsd: 0, listPriceUsd: 0, discountPercent: 0, creditsGranted: 100, status: 'completed', planName: 'Starter', createdAt: '2026-09-26T10:00:00Z' },
  x: { id: 'x', userId: 'u2', provider: 'cashtap', providerTransactionId: 'CT-9', priceUsd: 10, listPriceUsd: 10, discountPercent: 0, creditsGranted: 50, status: 'completed', planName: 'Mini', createdAt: '2026-09-26T10:00:00Z' },
};
let seq = 122;
const numbers = {};
stub('models/purchasesModel', {
  getPurchaseById: async (id) => purchases[id] || null,
  ensureInvoiceNumber: async (id) => { if (!numbers[id]) { seq += 1; numbers[id] = 'ELMS-2026-' + String(seq).padStart(6, '0'); } return numbers[id]; },
  listPurchasesForUser: async () => [],
});
stub('models/usersModel', { getUserById: async (id) => ({ id, name: 'Ali Khan', email: 'ali@example.com' }) });
stub('middleware/requireAuth', { requireAuth: (q, s, n) => n() });
stub('services/referralService', {});
stub('services/voucherService', {});
stub('models/plansModel', { listActivePlans: async () => [], getPlanById: async () => null });
stub('services/paddleService', { createTransaction: async () => ({}) });
stub('services/cashtapPaymentService', { activeProvider: () => 'cashtap' });

const invoices = require('../services/invoiceService');
const { layout } = require('../services/mailTemplate');

(async () => {
  // no discount: one line, the total, no discount line, no tax or address wording
  const a = await invoices.invoiceForPurchase(purchases.a);
  assert.strictEqual(a.number, 'ELMS-2026-000123');
  assert.strictEqual(a.payment, 'Cash App');
  assert.strictEqual(a.item, 'Pro, 600 credits');
  assert.strictEqual(a.discount, 0);
  assert.strictEqual(a.total, 120);
  const htmlA = invoices.invoiceHtml(a);
  assert.ok(htmlA.includes('$120.00') && htmlA.includes('Cash App') && htmlA.includes('ELMS-2026-000123'));
  assert.ok(!/discount/i.test(htmlA), 'no discount line when there was no discount');
  assert.ok(!/tax|vat|street|referral/i.test(htmlA));
  assert.strictEqual((await invoices.invoiceForPurchase(purchases.a)).number, a.number, 'the number stays');

  // discount: the list price, a plain "Discount" line (no percent, no referral wording), the amount paid; the method the buyer used
  const b = await invoices.invoiceForPurchase(purchases.b);
  assert.strictEqual(b.number, 'ELMS-2026-000124');
  assert.strictEqual(b.payment, 'Visa card');
  assert.strictEqual(b.itemAmount, 120);
  assert.strictEqual(b.discount, 12);
  assert.strictEqual(b.total, 108);
  const htmlB = invoices.invoiceHtml(b);
  assert.ok(htmlB.includes('Discount') && htmlB.includes('-$12.00') && htmlB.includes('$108.00'));
  assert.ok(!/referral|10%/i.test(htmlB));

  // a free voucher plan has no invoice
  assert.strictEqual(await invoices.invoiceForPurchase(purchases.v), null);

  // the PDF
  const pdf = await invoices.invoicePdf(b);
  assert.ok(Buffer.isBuffer(pdf) && pdf.slice(0, 5).toString() === '%PDF-' && pdf.length > 1500);

  // the mail
  const mail = invoices.invoiceMail(a);
  assert.strictEqual(mail.subject, 'ELMS invoice ELMS-2026-000123');
  assert.ok(mail.html.includes('logo-wordmark.png') && mail.html.includes('#E53238') && mail.html.includes('Thanks for your purchase, Ali'));
  assert.ok(mail.text.includes('Total paid: $120.00'));
  const safe = layout({ title: '<b>x</b>', bodyHtml: '' });
  assert.ok(!safe.includes('<b>x</b>'), 'the title is escaped');

  // sending: the PDF is attached, nothing throws when the mail fails
  let sent;
  stub('services/emailService', { sendInvoiceEmail: async (m) => { sent = m; return { ok: 1 }; } });
  await invoices.sendInvoiceForPurchase(purchases.a);
  assert.strictEqual(sent.to, 'ali@example.com');
  assert.strictEqual(sent.attachments[0].filename, 'ELMS-2026-000123.pdf');
  assert.strictEqual(sent.attachments[0].content.slice(0, 5).toString(), '%PDF-');
  stub('services/emailService', { sendInvoiceEmail: async () => { throw new Error('smtp down'); } });
  assert.strictEqual(await invoices.sendInvoiceForPurchase(purchases.a), null);

  // the route: own purchase only
  const router = require('../routes/payments');
  const get = handler(router, 'get', '/invoice/:id');
  let res = fakeRes(); await get({ userId: 'u1', params: { id: 'b' }, query: {} }, res);
  assert.strictEqual(res.headers['Content-Type'], 'application/pdf');
  assert.ok(String(res.headers['Content-Disposition']).includes('ELMS-2026-000124.pdf'));
  assert.strictEqual(res.sent.slice(0, 5).toString(), '%PDF-');
  res = fakeRes(); await get({ userId: 'u1', params: { id: 'x' }, query: {} }, res);
  assert.strictEqual(res.statusCode, 404, "someone else's purchase");
  res = fakeRes(); await get({ userId: 'u1', params: { id: 'v' }, query: {} }, res);
  assert.strictEqual(res.statusCode, 404, 'voucher plan');
  res = fakeRes(); await get({ userId: 'u1', params: { id: 'a' }, query: { format: 'json' } }, res);
  assert.strictEqual(res.body.invoice.total, 120);

  console.log('invoice tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
