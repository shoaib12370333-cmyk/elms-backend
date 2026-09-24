// Profit on orders: the cost comes from the seller's own figure, else the listing, its import, or the product price;
// orders that lost their listing link find it again by SKU or eBay item number; the cost can be set by hand.
const assert = require('assert');
const Module = require('module');

const oid = (s) => ({ toString: () => s });
const doc = (f) => ({ _id: oid(f.id), userId: oid('u1'), salePrice: 20, quantity: 1, ebayAccountId: null, listingId: null, ...f });

const listings = [
  { _id: oid('l-sku'), sku: 'B0AAA', ebayListingId: '111', title: 'By sku', mainImage: 'img-sku', ebayAccountId: oid('a1'), amazonPrice: 8, importId: null },
  { _id: oid('l-other'), sku: 'B0AAA', ebayListingId: '999', title: 'Same sku, other store', ebayAccountId: oid('a2'), amazonPrice: 5, importId: null },
  { _id: oid('l-item'), sku: 'B0ZZZ', ebayListingId: '222', title: 'By item number', ebayAccountId: oid('a1'), amazonPrice: null, importId: { amazonPrice: null, product: { price: '6.5' } } },
];
let orderDocs = [];
let findCalls = 0;
const chain = (result) => { const q = { populate: () => q, sort: () => q, select: () => q, lean: async () => result }; return q; };
const updates = [];
const fakes = {
  './schemas/Order': { find: () => chain(orderDocs), findOne: () => chain(orderDocs[0] || null), updateOne: async (f, u) => { updates.push(['one', u.$set]); }, updateMany: async (f, u) => { updates.push(['many', f, u.$set]); return { modifiedCount: 2 }; }, findOneAndUpdate: async (f, u) => ({ ...orderDocs[0], ...u, _id: oid('o1'), userId: oid('u1'), toObject() { return this; } }) },
  './schemas/Listing': { findOne: (f) => chain(f._id === 'l1' ? { _id: 'l1' } : null), find: (f) => { findCalls++; const or = f.$or; return chain(listings.filter((l) => or.some((c) => (c.sku && c.sku.$in.includes(l.sku)) || (c.ebayListingId && c.ebayListingId.$in.includes(l.ebayListingId))))); } },
  './schemas/Import': {},
};
const origLoad = Module._load;
Module._load = function (request, parent) {
  if (fakes[request] && parent && /ordersModel/.test(parent.filename)) return fakes[request];
  return origLoad.apply(this, arguments);
};
const { listOrders, setBuyPrice, linkOrderToListing } = require('../models/ordersModel');
Module._load = origLoad;

(async () => {
  orderDocs = [
    doc({ id: 'o1', sku: 'B0AAA', ebayAccountId: oid('a1'), quantity: 2, listingId: { title: 'Linked', amazonPrice: 7, importId: null } }),     // linked, listing price
    doc({ id: 'o2', sku: 'B0AAA', ebayAccountId: oid('a1') }),                                                                                    // link lost: found by SKU (same store)
    doc({ id: 'o3', sku: 'EBAY-222', legacyItemId: '222', ebayAccountId: oid('a1') }),                                                            // no ELMS sku: found by item number; cost from the product price
    doc({ id: 'o4', sku: 'EBAY-333', legacyItemId: '333' }),                                                                                      // not ours at all
    doc({ id: 'o5', sku: 'EBAY-333', legacyItemId: '333', buyPriceOverride: 12 }),                                                                // the seller typed the cost
    doc({ id: 'o6', sku: 'B0AAA', ebayAccountId: oid('a1'), buyPriceOverride: 12, listingId: { title: 'Linked', amazonPrice: 7, importId: null } }), // the seller's figure wins
    doc({ id: 'o7', listingId: { title: 'Zero price', amazonPrice: 0, importId: { amazonPrice: 0, product: { price: 4 } } } }),                    // a 0 is not a price
  ];
  const out = await listOrders('u1');
  const by = Object.fromEntries(out.map((o) => [o.id, o]));

  assert.strictEqual(by.o1.buy_price, 7);
  assert.strictEqual(by.o1.profit, 6, '20 - 7 x 2');
  assert.strictEqual(by.o2.listing_title, 'By sku', 'found again by SKU');
  assert.strictEqual(by.o2.main_image, 'img-sku');
  assert.strictEqual(by.o2.buy_price, 8, 'the listing of the same store, not the other store\'s');
  assert.strictEqual(by.o2.profit, 12);
  assert.strictEqual(by.o3.listing_title, 'By item number');
  assert.strictEqual(by.o3.buy_price, 6.5, 'a text price on the product is read');
  assert.strictEqual(by.o3.profit, 13.5);
  assert.strictEqual(by.o4.buy_price, null);
  assert.strictEqual(by.o4.profit, null, 'no cost anywhere -> no profit (shown as needing a price)');
  assert.strictEqual(by.o5.buy_price, 12);
  assert.strictEqual(by.o5.profit, 8);
  assert.strictEqual(by.o5.buy_price_manual, true);
  assert.strictEqual(by.o6.buy_price, 12, 'the seller\'s own figure wins');
  assert.strictEqual(by.o4.buy_price_manual, false);
  assert.strictEqual(by.o7.buy_price, 4, 'a 0 on the listing is skipped');
  assert.strictEqual(findCalls, 1, 'all missing links are looked up in one query');

  // setting the cost by hand
  orderDocs = [doc({ id: 'o1' })];
  assert.ok(await setBuyPrice('u1', 'o1', '9.5'));
  assert.ok(await setBuyPrice('u1', 'o1', null), 'empty clears it');
  await assert.rejects(() => setBuyPrice('u1', 'o1', 'abc'), /number above 0/);
  await assert.rejects(() => setBuyPrice('u1', 'o1', 0), /number above 0/);
  await assert.rejects(() => setBuyPrice('u1', 'o1', -3), /number above 0/);
  // linking an order to an imported product: it and the unlinked orders of the same eBay item, only for a listing of this user
  orderDocs = [{ ebayAccountId: 'a1', legacyItemId: '111' }];
  assert.strictEqual(await linkOrderToListing('u1', 'o1', 'l1'), 3);
  assert.deepStrictEqual(updates[0], ['one', { listingId: 'l1' }]);
  assert.strictEqual(updates[1][0], 'many');
  assert.deepStrictEqual(updates[1][1], { userId: 'u1', ebayAccountId: 'a1', legacyItemId: '111', listingId: null }, 'only orders without a listing follow');
  assert.strictEqual(await linkOrderToListing('u1', 'o1', 'someone-elses'), null, 'a listing that belongs to someone else is refused');
  console.log('order profit tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
