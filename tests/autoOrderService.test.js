// Auto Order's most important rule lives here: WHEN a supplier order is allowed to be queued at all. Real money is
// spent once the extension acts on one of these, so this only ever queues one for an Amazon listing, only once the
// eBay line is actually paid, and only when the seller has explicitly switched Auto Order to 'full_auto' - never for
// CJ/AliExpress (their own supplier APIs handle that, not a buyer-account browser extension), never for an unpaid
// order, and never just because a listing happens to exist. There is no automatic-on-payment creation any more -
// the seller decides which orders enter Auto Order via queueSupplierOrder (the Orders page's "Send to Auto Order"),
// and separately decides when the queue actually starts via startQueuedSupplierOrders ("Start Auto Order").
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

let user = null;
let created = [];
let placedRows = [];
let imports = {};
let placedCalls = [];
let markOrderedCalls = [];
let placedEbayInfo = { ebay_account_id: null, ebay_order_id: null };
let ebayAccount = null;
let ebayRefreshToken = null;
let noteCalls = [];
let orders = {};
let listings = {};
let startPendingCalls = [];

stub('models/schemas/User', { findById: (id) => ({ select: () => ({ lean: async () => (user && String(user._id) === String(id) ? { ...user } : null) }) }) });
stub('models/schemas/Import', { findById: (id) => ({ select: () => ({ lean: async () => imports[id] || null }) }) });
stub('models/schemas/Listing', { findOne: (q) => ({ select: () => ({ lean: async () => (listings[q._id] && listings[q._id].userId === q.userId ? { ...listings[q._id] } : null) }) }) });
stub('models/supplierOrdersModel', {
  createSupplierOrder: async (data) => {
    if (created.some((d) => d.ebayLineItemId === data.ebayLineItemId)) return null; // the real unique-index dedupe
    const doc = { id: 'so' + (created.length + 1), ...data };
    created.push(doc);
    return doc;
  },
  markPlaced: async (userId, id, body) => { placedCalls.push({ userId, id, body }); return { order_id: 'o1', ...placedEbayInfo }; },
  todaysPlacedTotal: async (userId) => placedRows.filter((r) => r.userId === userId).reduce((t, r) => t + r.amount, 0),
  startPendingSupplierOrders: async (userId) => { startPendingCalls.push(userId); return created.filter((d) => d.userId === userId && d.status === 'pending').length; },
});
stub('models/ordersModel', {
  linkAmazonOrder: async () => null,
  markOrdered: async (userId, id, body) => { markOrderedCalls.push({ userId, id, body }); return { order: {} }; },
  getOrderById: async (userId, id) => (orders[id] && orders[id].userId === userId ? { ...orders[id] } : null),
});
stub('models/ebayAccountsModel', { getEbayAccountById: async () => ebayAccount, getEbayAccountRefreshToken: async () => ebayRefreshToken });
stub('services/ebayOrderNoteService', { writeAmazonOrderNote: async (refreshToken, marketplaceId, body) => { noteCalls.push({ refreshToken, marketplaceId, body }); return { status: 'ok' }; } });
stub('models/usersModel', { hasCredits: async () => true, spendCredit: async () => true });
stub('config/actionCosts', { ACTION_COSTS: { AUTO_ORDER: 1 } });

const { queueSupplierOrder, startQueuedSupplierOrders, withinDailyLimit, primeOnlySetting, completeSupplierOrderPlacement } = require('../services/autoOrderService');

const listing = (over = {}) => ({ _id: 'l1', userId: 'u1', sourcePlatform: 'amazon', sku: 'B0TESTAAAA', amazonPrice: 20, ...over });
const order = (over = {}) => ({ id: 'o1', userId: 'u1', ebay_order_id: 'E1', ebay_line_item_id: 'LI1', listing_id: 'l1', ebay_account_id: 'acc1', variant_details: null, quantity: 1, shipping_address: { city: 'X' }, buyer_phone: '+1-555-1234', ebay_payment_status: 'PAID', ...over });
const reset = () => { created = []; orders = { o1: order() }; listings = { l1: listing() }; };

(async () => {
  // ---------- the seller has Auto Order off: nothing is queued ----------
  user = { _id: 'u1', autoOrderMode: 'disabled', autoOrderMaxPriceIncreasePercent: 10, autoOrderMaxCost: null };
  reset();
  let out = await queueSupplierOrder('u1', 'o1');
  assert.strictEqual(out.status, 'skipped', 'disabled: nothing queued');
  assert.match(out.reason, /Full-auto/);
  assert.strictEqual(created.length, 0);

  // ---------- semi_auto is a real mode too, but it is not this extension's automation - still not queued ----------
  user.autoOrderMode = 'semi_auto';
  out = await queueSupplierOrder('u1', 'o1');
  assert.strictEqual(out.status, 'skipped', 'semi_auto: no supplier order (the seller places these by hand)');

  // ---------- full_auto, but the listing is CJ or AliExpress: never for those, they use their own supplier APIs ----------
  user.autoOrderMode = 'full_auto';
  listings.l1 = listing({ sourcePlatform: 'cj' });
  out = await queueSupplierOrder('u1', 'o1');
  assert.strictEqual(out.status, 'skipped', 'CJ listing: never');
  listings.l1 = listing({ sourcePlatform: 'aliexpress' });
  out = await queueSupplierOrder('u1', 'o1');
  assert.strictEqual(out.status, 'skipped', 'AliExpress listing: never');
  listings.l1 = listing();

  // ---------- full_auto, Amazon listing, but the order is not paid yet: not yet ----------
  orders.o1 = order({ ebay_payment_status: 'PENDING' });
  out = await queueSupplierOrder('u1', 'o1');
  assert.strictEqual(out.status, 'skipped', 'unpaid: no supplier order yet');
  assert.match(out.reason, /not paid/);

  // ---------- no ebayLineItemId at all: nothing to key the unique index on, so it is skipped rather than risking a
  // duplicate Amazon order later ----------
  orders.o1 = order({ ebay_line_item_id: null });
  out = await queueSupplierOrder('u1', 'o1');
  assert.strictEqual(out.status, 'skipped');

  // ---------- an order that does not belong to this user, or does not exist: skipped, not an error ----------
  out = await queueSupplierOrder('someone-else', 'o1');
  assert.strictEqual(out.status, 'skipped');
  out = await queueSupplierOrder('u1', 'nope');
  assert.strictEqual(out.status, 'skipped');

  // ---------- the happy path: everything lines up, queued 'pending' (not 'ready' - the seller must Start it) ----------
  orders.o1 = order();
  listings.l1 = listing({ importId: 'imp1' });
  imports = { imp1: { amazonUrl: 'https://www.amazon.com/dp/B0TESTAAAA' } };
  out = await queueSupplierOrder('u1', 'o1');
  assert.strictEqual(out.status, 'queued', 'a supplier order is queued');
  assert.strictEqual(out.supplierOrder.status, 'pending', 'queued, not started - the extension only ever claims \'ready\'');
  assert.strictEqual(out.supplierOrder.fulfillmentMethod, 'extension');
  assert.strictEqual(out.supplierOrder.asin, 'B0TESTAAAA', 'the ASIN is the listing\'s own sku, an Amazon listing\'s sku IS its ASIN');
  assert.strictEqual(out.supplierOrder.amazonUrl, 'https://www.amazon.com/dp/B0TESTAAAA', 'the exact product page, from the listing\'s import');
  assert.strictEqual(out.supplierOrder.maxAllowedCost, 22, '10% over the $20 saved Amazon price, no flat cap set');
  assert.deepStrictEqual(out.supplierOrder.shippingAddress, { city: 'X', phone: '+1-555-1234' }, 'the buyer\'s phone (a separate field on the order) is folded into the address - Amazon needs one to save a new address');

  // ---------- sent twice: the second call is skipped, never a second supplier order for the same eBay line ----------
  out = await queueSupplierOrder('u1', 'o1');
  assert.strictEqual(out.status, 'skipped');
  assert.match(out.reason, /already sent/);
  assert.strictEqual(created.length, 1);

  // ---------- a listing with no linked import at all: amazonUrl is simply null, never an error ----------
  reset();
  orders.o1 = order({ ebay_line_item_id: 'LI0' });
  out = await queueSupplierOrder('u1', 'o1');
  assert.strictEqual(out.supplierOrder.amazonUrl, null);

  // ---------- a flat autoOrderMaxCost lower than the percentage cap wins (the tighter of the two) ----------
  reset();
  orders.o1 = order({ ebay_line_item_id: 'LI2' });
  user.autoOrderMaxCost = 21;
  out = await queueSupplierOrder('u1', 'o1');
  assert.strictEqual(out.supplierOrder.maxAllowedCost, 21, 'the flat cap is tighter than the 22 percentage cap, so it wins');

  // ---------- a flat cap set but no saved Amazon price on the listing: the flat cap alone applies ----------
  reset();
  orders.o1 = order({ ebay_line_item_id: 'LI3' });
  listings.l1 = listing({ amazonPrice: null });
  out = await queueSupplierOrder('u1', 'o1');
  assert.strictEqual(out.supplierOrder.maxAllowedCost, 21);

  // ---------- neither a saved Amazon price nor a flat cap: maxAllowedCost is null (the extension must report
  // needs_attention rather than guess a safe price) ----------
  reset();
  orders.o1 = order({ ebay_line_item_id: 'LI4' });
  listings.l1 = listing({ amazonPrice: null });
  user.autoOrderMaxCost = null;
  out = await queueSupplierOrder('u1', 'o1');
  assert.strictEqual(out.supplierOrder.maxAllowedCost, null);

  // ---------- startQueuedSupplierOrders: the seller's "Start Auto Order" - delegates straight to the model ----------
  startPendingCalls = [];
  await startQueuedSupplierOrders('u1');
  assert.deepStrictEqual(startPendingCalls, ['u1']);

  // ---------- withinDailyLimit: no limit set always passes; a limit blocks once today's placed total would be exceeded ----------
  user.autoOrderDailyLimit = null;
  placedRows = [];
  assert.strictEqual(await withinDailyLimit('u1', 500), true, 'no daily limit set: always within it');
  user.autoOrderDailyLimit = 100;
  placedRows = [{ userId: 'u1', amount: 80 }];
  assert.strictEqual(await withinDailyLimit('u1', 15), true, '80 + 15 = 95, still within the 100 limit');
  assert.strictEqual(await withinDailyLimit('u1', 25), false, '80 + 25 = 105, over the 100 limit');

  // ---------- completeSupplierOrderPlacement: saves the delivery date and the real Amazon total as the buying
  // cost on the ELMS order, the same fields the manual "Mark as ordered" dialog fills in - nothing left to type in ----------
  placedCalls = []; markOrderedCalls = [];
  await completeSupplierOrderPlacement('u1', 'so1', { amazonOrderId: 'AMZ-1', amazonTotal: 24.5, deliveryDate: '2026-10-05T00:00:00.000Z' });
  assert.strictEqual(markOrderedCalls.length, 1);
  assert.strictEqual(markOrderedCalls[0].userId, 'u1');
  assert.strictEqual(markOrderedCalls[0].id, 'o1');
  assert.strictEqual(markOrderedCalls[0].body.ordered, true);
  assert.strictEqual(markOrderedCalls[0].body.buyingPrice, 24.5);
  assert.ok(markOrderedCalls[0].body.deliveryDate instanceof Date);
  assert.strictEqual(markOrderedCalls[0].body.deliveryDate.toISOString(), '2026-10-05T00:00:00.000Z');

  // an unreadable delivery date (the extension could not find one) leaves it undefined - markOrdered then keeps
  // whatever was already there instead of clearing a real date with a bad one
  markOrderedCalls = [];
  await completeSupplierOrderPlacement('u1', 'so1', { amazonOrderId: 'AMZ-2', amazonTotal: 10, deliveryDate: null });
  assert.strictEqual(markOrderedCalls[0].body.deliveryDate, undefined);

  // ---------- the eBay order note uses the account's OWN marketplace, never a hardcoded EBAY_US - a UK/DE/AU/...
  // seller's Amazon order note used to silently go to the wrong regional eBay site (account.marketplace_id does not
  // exist on the serialized account - the real field is camelCase marketplaceId - so it always fell back to
  // 'EBAY_US' and the note was silently skipped for every non-US seller) ----------
  placedEbayInfo = { ebay_account_id: 'acc1', ebay_order_id: 'E1' };
  ebayAccount = { id: 'acc1', marketplaceId: 'EBAY_GB' };
  ebayRefreshToken = 'rt-gb';
  noteCalls = [];
  await completeSupplierOrderPlacement('u1', 'so1', { amazonOrderId: 'AMZ-3', amazonTotal: 12 });
  assert.strictEqual(noteCalls.length, 1);
  assert.strictEqual(noteCalls[0].marketplaceId, 'EBAY_GB', 'the seller\'s real marketplace is used, not a hardcoded EBAY_US');
  assert.strictEqual(noteCalls[0].refreshToken, 'rt-gb');
  assert.strictEqual(noteCalls[0].body.orderId, 'E1');
  assert.strictEqual(noteCalls[0].body.amazonOrderId, 'AMZ-3');

  // an account with no marketplaceId at all still falls back to EBAY_US (never throws, never sends undefined)
  ebayAccount = { id: 'acc1' };
  noteCalls = [];
  await completeSupplierOrderPlacement('u1', 'so1', { amazonOrderId: 'AMZ-4', amazonTotal: 12 });
  assert.strictEqual(noteCalls[0].marketplaceId, 'EBAY_US');
  placedEbayInfo = { ebay_account_id: null, ebay_order_id: null }; ebayAccount = null; ebayRefreshToken = null;

  // ---------- primeOnlySetting: defaults to true (the safer default) unless explicitly turned off ----------
  user.autoOrderPrimeOnly = undefined;
  assert.strictEqual(await primeOnlySetting('u1'), true, 'unset: defaults on');
  user.autoOrderPrimeOnly = false;
  assert.strictEqual(await primeOnlySetting('u1'), false);

  console.log('autoOrderService: all good');
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
