// Orders -> "Import from Amazon": same credits as a normal import, the order is linked to the imported product,
// a bare ASIN uses the Amazon site of the order's store, and nothing is fetched when the input or credits are wrong.
const assert = require('assert');
const Module = require('module');

let credits = true;
let order = { id: 'o1', ebay_account_id: 'a1' };
const fetched = [];
let fetchResult;
let fetchError = null;
let linkedTo = null;
const fakes = {
  '../models/ordersModel': {
    listOrders: async () => [], updateFulfillmentStatus: async () => null, upsertOrder: async () => null, setTracking: async () => null,
    linkAmazonOrder: async () => null, setSellerNote: async () => null, setBuyPrice: async () => null,
    getOrderById: async () => (order ? { ...order, buy_price: linkedTo ? 8 : null } : null),
    linkOrderToListing: async (u, id, listingId) => { linkedTo = listingId; return 3; },
  },
  '../models/ebayAccountsModel': { listEbayAccounts: async () => [], getEbayAccountRefreshToken: async () => 'tok', getEbayAccountById: async () => ({ marketplaceId: 'EBAY_GB' }) },
  '../models/schemas/EbayAccount': {},
  '../services/ebayOrdersService': { fetchOrderById: async () => null, normalizeOrderLineItems: () => [], createShippingFulfillment: async () => null },
  '../services/orderSyncService': { syncAccountOrders: async () => ({}) },
  '../services/orderImageService': { backfillOrderImagesForUser: () => {}, fillMissingOrderImages: async () => 0 },
  '../services/trackingConversionService': { convertTracking: () => null },
  '../middleware/requireAuth': { requireAuth: (req, res, next) => next() },
  './fetchProduct': { fetchAndSaveDraft: async (userId, url) => { fetched.push(url); if (fetchError) throw fetchError; return fetchResult; } },
  '../models/usersModel': { hasCredits: async () => credits },
};
const origLoad = Module._load;
Module._load = function (request, parent) {
  if (fakes[request] && parent && /routes.orders.js$/.test(parent.filename)) return fakes[request];
  return origLoad.apply(this, arguments);
};
const router = require('../routes/orders');
Module._load = origLoad;

const layer = router.stack.find((l) => l.route && l.route.path === '/:id/import-product' && l.route.methods.post);
assert.ok(layer, 'the route exists');
const handler = layer.route.stack[layer.route.stack.length - 1].handle;
const fakeRes = () => { const r = { statusCode: 200 }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
const call = async (amazon) => { const res = fakeRes(); await handler({ userId: 'u1', params: { id: 'o1' }, body: { amazon } }, res); return res; };

(async () => {
  fetchResult = { product: { title: 'Lamp', price: 8, currency: 'USD' }, draft: { id: 'l1' } };

  // wrong input: nothing is fetched
  let res = await call('hello');
  assert.strictEqual(res.statusCode, 400);
  res = await call('https://example.com/dp/B0ABCDEFGH');
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(fetched.length, 0);

  // no credits: nothing is fetched (and so nothing charged)
  credits = false;
  res = await call('https://www.amazon.com/dp/B0ABCDEFGH');
  assert.strictEqual(res.statusCode, 402);
  assert.strictEqual(fetched.length, 0);
  credits = true;

  // a link: imported, order linked, profit source (buy_price) comes back
  res = await call('https://www.amazon.com/dp/B0ABCDEFGH');
  assert.strictEqual(res.body.success, true);
  assert.deepStrictEqual(fetched, ['https://www.amazon.com/dp/B0ABCDEFGH']);
  assert.strictEqual(linkedTo, 'l1');
  assert.strictEqual(res.body.order.buy_price, 8);
  assert.strictEqual(res.body.priceFound, true);
  assert.strictEqual(res.body.linkedOrders, 3);

  // an ASIN alone: the Amazon site of the order's store (a UK store -> amazon.co.uk), upper-cased
  fetched.length = 0;
  res = await call('b0abcdefgh');
  assert.deepStrictEqual(fetched, ['https://www.amazon.co.uk/dp/B0ABCDEFGH']);

  // Amazon had no price: still linked (the credit was spent by the import), the page is told to ask for the cost by hand
  fetchResult = { product: { title: 'Lamp', price: null }, draft: { id: 'l2' } };
  res = await call('https://www.amazon.com/dp/B0ABCDEFGH');
  assert.strictEqual(res.body.priceFound, false);

  // a failed import reports its own status and links nothing
  linkedTo = null; fetchError = Object.assign(new Error('Could not find a valid Amazon ASIN in that URL.'), { statusCode: 400 });
  res = await call('https://www.amazon.com/dp/B0ABCDEFGH');
  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.error, /ASIN/);
  assert.strictEqual(linkedTo, null);
  fetchError = null;

  // unknown order
  order = null;
  res = await call('https://www.amazon.com/dp/B0ABCDEFGH');
  assert.strictEqual(res.statusCode, 404);
  console.log('order import tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
