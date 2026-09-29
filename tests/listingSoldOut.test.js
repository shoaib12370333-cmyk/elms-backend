// A listing that sells out its whole quantity moves itself to the "Sold" tab (models/ordersModel.js upsertOrder ->
// markSoldIfOut), and summarizeLiveListings' counts split "Active" from "Sold" instead of lumping every published
// listing into "Active" (the gap the owner reported: the Sold tab always showed 0).
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

let listings = {}; // id -> { _id, quantity, soldQuantity, status }
let orders = []; // { _id, userId, ebayOrderId, ebayLineItemId, sku, listingId }

function chain(promise) {
  return { select: () => chain(promise), populate: () => chain(promise), lean: () => promise, then: (res, rej) => promise.then(res, rej), catch: (rej) => promise.catch(rej) };
}

stub('models/schemas/Listing', {
  findOne: ({ userId, sku, ebayAccountId, _id }) => chain((async () => {
    if (_id) return listings[String(_id)] ? { ...listings[String(_id)] } : null;
    return Object.values(listings).find((l) => l.sku === sku) || null;
  })()),
  findOneAndUpdate: ({ _id }, update, opts) => chain((async () => {
    const l = listings[String(_id)];
    if (!l) return null;
    if (update.$inc) for (const [k, v] of Object.entries(update.$inc)) l[k] = (l[k] || 0) + v;
    return { ...l };
  })()),
  updateOne: async ({ _id, status: matchStatus }, update) => {
    const l = listings[String(_id)];
    if (!l) return { modifiedCount: 0 };
    if (matchStatus !== undefined && l.status !== matchStatus) return { modifiedCount: 0 };
    if (update.$set) Object.assign(l, update.$set);
    return { modifiedCount: 1 };
  },
});

const asDoc = (o) => (o ? Object.assign(o, { set: (fields) => Object.assign(o, fields), save: async () => {} }) : null);
stub('models/schemas/Order', {
  findOne: ({ userId, ebayOrderId, ebayLineItemId, sku }) => chain((async () => {
    if (ebayLineItemId) return asDoc(orders.find((o) => o.ebayOrderId === ebayOrderId && o.ebayLineItemId === ebayLineItemId));
    return asDoc(orders.find((o) => o.ebayOrderId === ebayOrderId && o.sku === sku));
  })()),
  create: async (doc) => { const o = { _id: 'ord' + (orders.length + 1), ...doc }; orders.push(o); return asDoc(o); },
});
stub('models/schemas/Import', {});
stub('models/schemas/EbayAccount', { find: () => ({ select: () => ({ lean: async () => [] }) }) });
stub('services/currencyService', { warmRates: async () => {}, convertCached: (v) => v });
stub('config/amazonDomains', { sourceCurrency: () => 'USD' });
stub('services/accountLabel', { accountLabel: () => null, publicUsername: () => null });

const { upsertOrder } = require('../models/ordersModel');

const lineItem = (over = {}) => ({ ebayOrderId: 'O1', ebayLineItemId: 'LI1', sku: 'B0TEST', buyerUsername: 'buyer1', salePrice: 20, quantity: 1, ebayPaymentStatus: 'PAID', ...over });

(async () => {
  // ---------- a listing with quantity 1: one new order sells out the whole thing ----------
  listings = { l1: { _id: 'l1', sku: 'B0TEST', quantity: 1, soldQuantity: 0, status: 'published' } };
  orders = [];
  await upsertOrder('u1', lineItem(), 'acc1');
  assert.strictEqual(listings.l1.soldQuantity, 1);
  assert.strictEqual(listings.l1.status, 'sold', 'the whole quantity sold: the listing moves to Sold');

  // ---------- re-syncing the SAME order (webhook + job both ran) never counts it twice ----------
  await upsertOrder('u1', lineItem({ ebayPaymentStatus: 'FULLY_REFUNDED' }), 'acc1'); // an update, not a new order
  assert.strictEqual(listings.l1.soldQuantity, 1, 'a re-sync of an order already seen never increments again');

  // ---------- a listing with quantity 2: needs two separate NEW orders before it moves to Sold ----------
  listings = { l2: { _id: 'l2', sku: 'B0TWO', quantity: 2, soldQuantity: 0, status: 'published' } };
  orders = [];
  await upsertOrder('u1', { ...lineItem({ sku: 'B0TWO' }), ebayOrderId: 'OA', ebayLineItemId: 'LIA', quantity: 1 }, 'acc1');
  assert.strictEqual(listings.l2.soldQuantity, 1);
  assert.strictEqual(listings.l2.status, 'published', 'only half sold so far: still active');
  await upsertOrder('u1', { ...lineItem({ sku: 'B0TWO' }), ebayOrderId: 'OB', ebayLineItemId: 'LIB', quantity: 1 }, 'acc1');
  assert.strictEqual(listings.l2.soldQuantity, 2);
  assert.strictEqual(listings.l2.status, 'sold', 'now every unit is sold');

  // ---------- an order for a quantity greater than what is left still flips it (never left dangling above 100%) ----------
  listings = { l3: { _id: 'l3', sku: 'B0THREE', quantity: 1, soldQuantity: 0, status: 'published' } };
  orders = [];
  await upsertOrder('u1', { ...lineItem({ sku: 'B0THREE' }), ebayOrderId: 'OC', ebayLineItemId: 'LIC', quantity: 3 }, 'acc1');
  assert.strictEqual(listings.l3.status, 'sold');

  // ---------- an order with no matching listing (no SKU match): never throws, nothing to update ----------
  listings = {};
  orders = [];
  await upsertOrder('u1', lineItem({ sku: 'NO-SUCH-SKU' }), 'acc1'); // must not throw

  // ---------- a listing already 'ended' (or any non-'published' status) is never silently moved to 'sold' ----------
  listings = { l4: { _id: 'l4', sku: 'B0FOUR', quantity: 1, soldQuantity: 0, status: 'ended' } };
  orders = [];
  await upsertOrder('u1', { ...lineItem({ sku: 'B0FOUR' }), ebayOrderId: 'OD', ebayLineItemId: 'LID' }, 'acc1');
  assert.strictEqual(listings.l4.status, 'ended', 'an ended listing is not reopened as "sold" by an incidental order match');
  assert.strictEqual(listings.l4.soldQuantity, 1, 'the count itself is still kept (in case it is relisted later)');

  console.log('listing sold-out tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
