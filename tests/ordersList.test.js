// Regression test for a crash in models/ordersModel.js's listOrders(): it referenced an
// undefined `obj` variable when falling back to an order's own item title (i.e. any order
// whose line item has no linked ELMS listing - the normal case for eBay orders that were
// never imported/published through ELMS). That crashed the ENTIRE GET /api/orders response
// with a generic 500 for every order in the list, not just the affected one.
const assert = require('assert');
const Module = require('module');

function fakeDoc(fields) {
  const obj = { _id: { toString: () => fields.id }, userId: { toString: () => 'u1' }, ...fields };
  return { ...obj, toObject: () => obj };
}

const docs = [
  // Order WITH a linked listing that has a title - the common/working case.
  fakeDoc({ id: 'o1', itemTitle: 'Raw eBay title (should not be used)', listingId: { title: 'ELMS Draft Title', mainImage: 'https://x/img.jpg', importId: { amazonPrice: 9.5 } }, ebayAccountId: { ebayUserId: 'seller1' }, salePrice: 20 }),
  // Order with NO linked listing (e.g. not sourced from ELMS, or the listing was deleted) -
  // this is the exact shape that used to throw "obj is not defined". Also has no itemImage,
  // so main_image should end up null rather than throwing.
  fakeDoc({ id: 'o2', itemTitle: 'Buyer bought this directly on eBay', listingId: null, ebayAccountId: null, salePrice: 15 }),
  // Order with no linked listing but eBay DID give us a picture for the line item - this
  // should be used as a fallback so the Orders page isn't stuck showing no image for every
  // order that was never imported/published through ELMS (the common case).
  fakeDoc({ id: 'o3', itemTitle: 'Also bought directly on eBay', itemImage: 'https://ebay.example/pic.jpg', listingId: null, ebayAccountId: null, salePrice: 12 }),
];

const fakes = {
  './schemas/Order': {
    find: () => ({
      populate: () => ({ populate: () => ({ sort: () => ({ lean: async () => docs }) }) }),
    }),
  },
  './schemas/Listing': {},
  './schemas/Import': {},
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (fakes[request] && parent && /ordersModel/.test(parent.filename)) return fakes[request];
  return origLoad.apply(this, arguments);
};
const { listOrders } = require('../models/ordersModel');
Module._load = origLoad;

(async () => {
  const orders = await listOrders('u1'); // used to reject with "ReferenceError: obj is not defined"
  assert.strictEqual(orders.length, 3);
  assert.strictEqual(orders[0].listing_title, 'ELMS Draft Title', 'prefers the linked listing title');
  assert.strictEqual(orders[0].buy_price, 9.5);
  assert.strictEqual(orders[0].main_image, 'https://x/img.jpg', 'uses the linked listing\'s image');
  assert.strictEqual(orders[1].listing_title, 'Buyer bought this directly on eBay', 'falls back to the order\'s own item title with no linked listing');
  assert.strictEqual(orders[1].buy_price, null);
  assert.strictEqual(orders[1].main_image, null, 'no listing and no eBay image -> null, not a crash');
  assert.strictEqual(orders[2].main_image, 'https://ebay.example/pic.jpg', 'falls back to eBay\'s own line-item image with no linked listing');
  console.log('orders list tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
