// Auto Order's most important rule lives here: WHEN a supplier order is allowed to be created at all. Real money is
// spent once the extension acts on one of these, so this only ever creates one for an Amazon listing, only once the
// eBay line is actually paid, and only when the seller has explicitly switched Auto Order to 'full_auto' - never for
// CJ/AliExpress (their own supplier APIs handle that, not a buyer-account browser extension), never for an unpaid
// order, and never just because a listing happens to exist.
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

let user = null;
let created = [];
let placedRows = [];

stub('models/schemas/User', { findById: (id) => ({ select: () => ({ lean: async () => (user && String(user._id) === String(id) ? { ...user } : null) }) }) });
stub('models/supplierOrdersModel', {
  createSupplierOrder: async (data) => { const doc = { id: 'so' + (created.length + 1), ...data }; created.push(doc); return doc; },
  markPlaced: async () => null,
  todaysPlacedTotal: async (userId) => placedRows.filter((r) => r.userId === userId).reduce((t, r) => t + r.amount, 0),
});
stub('models/ordersModel', { linkAmazonOrder: async () => null });
stub('models/ebayAccountsModel', { getEbayAccountById: async () => null, getEbayAccountRefreshToken: async () => null });
stub('services/ebayOrderNoteService', { writeAmazonOrderNote: async () => ({ status: 'skipped' }) });
stub('models/usersModel', { hasCredits: async () => true, spendCredit: async () => true });
stub('config/actionCosts', { ACTION_COSTS: { AUTO_ORDER: 1 } });

const { maybeCreateSupplierOrder, withinDailyLimit } = require('../services/autoOrderService');

const listing = (over = {}) => ({ _id: 'l1', sourcePlatform: 'amazon', sku: 'B0TESTAAAA', amazonPrice: 20, ...over });
const order = (over = {}) => ({ _id: 'o1', ebayOrderId: 'E1', ebayLineItemId: 'LI1', variantDetails: null, quantity: 1, shippingAddress: { city: 'X' }, ebayPaymentStatus: 'PAID', ...over });

(async () => {
  // ---------- the seller has Auto Order off: nothing is created ----------
  user = { _id: 'u1', autoOrderMode: 'disabled', autoOrderMaxPriceIncreasePercent: 10, autoOrderMaxCost: null };
  created = [];
  let out = await maybeCreateSupplierOrder({ userId: 'u1', listing: listing(), order: order(), ebayAccountId: 'acc1' });
  assert.strictEqual(out, null, 'disabled: no supplier order');
  assert.strictEqual(created.length, 0);

  // ---------- semi_auto is a real mode too, but it is not this extension's automation - still no supplier order ----------
  user.autoOrderMode = 'semi_auto';
  out = await maybeCreateSupplierOrder({ userId: 'u1', listing: listing(), order: order(), ebayAccountId: 'acc1' });
  assert.strictEqual(out, null, 'semi_auto: no supplier order (the seller places these by hand)');

  // ---------- full_auto, but the listing is CJ or AliExpress: never for those, they use their own supplier APIs ----------
  user.autoOrderMode = 'full_auto';
  out = await maybeCreateSupplierOrder({ userId: 'u1', listing: listing({ sourcePlatform: 'cj' }), order: order(), ebayAccountId: 'acc1' });
  assert.strictEqual(out, null, 'CJ listing: never');
  out = await maybeCreateSupplierOrder({ userId: 'u1', listing: listing({ sourcePlatform: 'aliexpress' }), order: order(), ebayAccountId: 'acc1' });
  assert.strictEqual(out, null, 'AliExpress listing: never');

  // ---------- full_auto, Amazon listing, but the order is not paid yet: not yet ----------
  out = await maybeCreateSupplierOrder({ userId: 'u1', listing: listing(), order: order({ ebayPaymentStatus: 'PENDING' }), ebayAccountId: 'acc1' });
  assert.strictEqual(out, null, 'unpaid: no supplier order yet');

  // ---------- no ebayLineItemId at all: nothing to key the unique index on, so it is skipped rather than risking a
  // duplicate Amazon order later ----------
  out = await maybeCreateSupplierOrder({ userId: 'u1', listing: listing(), order: order({ ebayLineItemId: null }), ebayAccountId: 'acc1' });
  assert.strictEqual(out, null);

  // ---------- the happy path: everything lines up ----------
  out = await maybeCreateSupplierOrder({ userId: 'u1', listing: listing(), order: order(), ebayAccountId: 'acc1' });
  assert.ok(out, 'a supplier order is created');
  assert.strictEqual(out.status, 'ready');
  assert.strictEqual(out.fulfillmentMethod, 'extension');
  assert.strictEqual(out.asin, 'B0TESTAAAA', 'the ASIN is the listing\'s own sku, an Amazon listing\'s sku IS its ASIN');
  assert.strictEqual(out.maxAllowedCost, 22, '10% over the $20 saved Amazon price, no flat cap set');

  // ---------- a flat autoOrderMaxCost lower than the percentage cap wins (the tighter of the two) ----------
  created = [];
  user.autoOrderMaxCost = 21;
  out = await maybeCreateSupplierOrder({ userId: 'u1', listing: listing(), order: order({ ebayLineItemId: 'LI2' }), ebayAccountId: 'acc1' });
  assert.strictEqual(out.maxAllowedCost, 21, 'the flat cap is tighter than the 22 percentage cap, so it wins');

  // ---------- a flat cap set but no saved Amazon price on the listing: the flat cap alone applies ----------
  created = [];
  out = await maybeCreateSupplierOrder({ userId: 'u1', listing: listing({ amazonPrice: null }), order: order({ ebayLineItemId: 'LI3' }), ebayAccountId: 'acc1' });
  assert.strictEqual(out.maxAllowedCost, 21);

  // ---------- neither a saved Amazon price nor a flat cap: maxAllowedCost is null (the extension must report
  // needs_attention rather than guess a safe price) ----------
  created = [];
  user.autoOrderMaxCost = null;
  out = await maybeCreateSupplierOrder({ userId: 'u1', listing: listing({ amazonPrice: null }), order: order({ ebayLineItemId: 'LI4' }), ebayAccountId: 'acc1' });
  assert.strictEqual(out.maxAllowedCost, null);

  // ---------- withinDailyLimit: no limit set always passes; a limit blocks once today's placed total would be exceeded ----------
  user.autoOrderDailyLimit = null;
  placedRows = [];
  assert.strictEqual(await withinDailyLimit('u1', 500), true, 'no daily limit set: always within it');
  user.autoOrderDailyLimit = 100;
  placedRows = [{ userId: 'u1', amount: 80 }];
  assert.strictEqual(await withinDailyLimit('u1', 15), true, '80 + 15 = 95, still within the 100 limit');
  assert.strictEqual(await withinDailyLimit('u1', 25), false, '80 + 25 = 105, over the 100 limit');

  console.log('autoOrderService: all good');
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
