// models/ordersModel.js upsertOrder's wiring for the auto "thanks for your order" message: fires exactly when an
// order line is first seen as PAID (never on a re-sync that was already PAID, and never twice for the same
// transition), and passes through enough for services/autoBuyerMessageService.js to apply its own
// toggle/recency/once-only checks (tested separately in tests/autoBuyerMessageService.test.js). Same fake-model
// harness as tests/listingSoldOut.test.js, which already covers upsertOrder's other side effects.
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

let listings = {};
let orders = [];

function chain(promise) {
  return { select: () => chain(promise), populate: () => chain(promise), lean: () => promise, then: (res, rej) => promise.then(res, rej), catch: (rej) => promise.catch(rej) };
}
stub('models/schemas/Listing', {
  findOne: ({ sku, _id }) => chain((async () => (_id ? (listings[String(_id)] ? { ...listings[String(_id)] } : null) : (Object.values(listings).find((l) => l.sku === sku) || null)))()),
  findOneAndUpdate: () => chain((async () => null)()),
  updateOne: async () => ({ modifiedCount: 0 }),
});
const asDoc = (o) => (o ? Object.assign(o, { set: (fields) => Object.assign(o, fields), save: async () => {} }) : null);
stub('models/schemas/Order', {
  findOne: ({ ebayOrderId, ebayLineItemId, sku }) => chain((async () => (ebayLineItemId
    ? asDoc(orders.find((o) => o.ebayOrderId === ebayOrderId && o.ebayLineItemId === ebayLineItemId))
    : asDoc(orders.find((o) => o.ebayOrderId === ebayOrderId && o.sku === sku))))()),
  create: async (doc) => { const o = { _id: 'ord' + (orders.length + 1), ...doc }; orders.push(o); return asDoc(o); },
});
stub('models/schemas/Import', {});
stub('models/schemas/EbayAccount', { find: () => ({ select: () => ({ lean: async () => [] }) }) });
stub('services/currencyService', { warmRates: async () => {}, convertCached: (v) => v });
stub('config/amazonDomains', { sourceCurrency: () => 'USD' });
stub('services/accountLabel', { accountLabel: () => null, publicUsername: () => null });

const calls = [];
stub('services/autoBuyerMessageService', {
  maybeSendThankYouMessage: async (args) => { calls.push(args); },
});

const { upsertOrder } = require('../models/ordersModel');
const lineItem = (over = {}) => ({ ebayOrderId: 'O1', ebayLineItemId: 'LI1', sku: 'B0TEST', buyerUsername: 'buyer1', salePrice: 20, quantity: 1, itemTitle: 'Widget', legacyItemId: '110001', ...over });

(async () => {
  // ---------- a brand new order line, synced already PAID (the normal case: eBay usually shows a line only once it's paid) - triggers ----------
  orders = []; listings = {}; calls.length = 0;
  await upsertOrder('u1', lineItem({ ebayPaymentStatus: 'PAID', paidAt: new Date() }), 'acc1');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].justPaid, true);
  assert.strictEqual(calls[0].alreadySent, false);
  assert.strictEqual(calls[0].buyerUsername, 'buyer1');
  assert.strictEqual(calls[0].ebayAccountId, 'acc1');
  assert.strictEqual(calls[0].itemId, '110001');
  assert.strictEqual(calls[0].itemTitle, 'Widget');

  // ---------- re-syncing the same order, still PAID - never fires again ----------
  calls.length = 0;
  await upsertOrder('u1', lineItem({ ebayPaymentStatus: 'PAID', paidAt: new Date() }), 'acc1');
  assert.strictEqual(calls.length, 0, 'wasPaid was already true - not a fresh transition');

  // ---------- an order created PENDING, then later synced as PAID - the live transition - triggers ----------
  orders = []; calls.length = 0;
  await upsertOrder('u1', lineItem({ ebayOrderId: 'O2', ebayLineItemId: 'LI2', ebayPaymentStatus: 'PENDING' }), 'acc1');
  assert.strictEqual(calls.length, 0, 'not paid yet');
  await upsertOrder('u1', lineItem({ ebayOrderId: 'O2', ebayLineItemId: 'LI2', ebayPaymentStatus: 'PAID', paidAt: new Date() }), 'acc1');
  assert.strictEqual(calls.length, 1, 'PENDING -> PAID is a live transition');
  assert.strictEqual(calls[0].justPaid, true);

  // ---------- an order line that never has a payment status at all: never fires (no false trigger on undefined/undefined) ----------
  orders = []; calls.length = 0;
  await upsertOrder('u1', lineItem({ ebayOrderId: 'O3', ebayLineItemId: 'LI3', ebayPaymentStatus: null }), 'acc1');
  assert.strictEqual(calls.length, 0);

  console.log('auto buyer message (ordersModel wiring) tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
