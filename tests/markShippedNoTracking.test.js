// Marking an order as shipped on eBay with NO tracking number: models/ordersModel.js markShippedNoTracking only ever
// sets fulfillmentStatus='shipped' (never touches trackingNumber/shippingCarrier - so a later real tracking number
// via setTracking is not special-cased), and services/ebayOrdersService.js createShippingFulfillment sends eBay a
// shipping fulfillment with just lineItems/shippedDate when no trackingNumber is given (a carrier code with nothing
// to track would be meaningless, so it is left out too) - but still includes trackingNumber/shippingCarrierCode when
// one is given, exactly as before. The real functions run; the database and eBay's HTTP call are stand-ins.
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

// ---------- markShippedNoTracking (models/ordersModel.js) ----------
let stored = null;
let sets = [];
stub('models/schemas/Order', {
  findOneAndUpdate: async (q, u) => { sets.push(u); stored = { ...stored, ...u }; return { toObject: () => ({ _id: { toString: () => 'o1' }, userId: { toString: () => 'u1' }, ebayOrderId: '11-1', sku: 'B0X', quantity: 1, salePrice: 30, currency: 'GBP', trackingNumber: null, shippingCarrier: null, ...stored }) }; },
});
stub('models/schemas/Listing', {});
stub('models/schemas/Import', {});
const { markShippedNoTracking } = require('../models/ordersModel');

// ---------- createShippingFulfillment (services/ebayOrdersService.js) ----------
stub('services/ebayAuthService', { getAccessToken: async () => 'AT' });
const postCalls = [];
const axiosPath = require.resolve('axios');
require.cache[axiosPath] = { id: axiosPath, filename: axiosPath, loaded: true, exports: { get: async () => ({ data: {} }), post: async (url, body) => { postCalls.push({ url, body }); return { data: { ok: true } }; } } };
const { createShippingFulfillment } = require('../services/ebayOrdersService');

(async () => {
  // ---------- the model: sets fulfillmentStatus only, trackingNumber/shippingCarrier are left exactly as they were ----------
  stored = { fulfillmentStatus: 'pending', trackingNumber: null, shippingCarrier: null };
  let out = await markShippedNoTracking('u1', 'o1');
  assert.deepStrictEqual(sets[0], { fulfillmentStatus: 'shipped' }, 'only the status is written - no trackingNumber/shippingCarrier keys at all');
  assert.strictEqual(out.fulfillment_status, 'shipped');
  assert.strictEqual(out.tracking_number, null, 'still no tracking number - this is the no-tracking path');

  // a later real tracking number (setTracking, not this function) is unaffected - already proven by its own tests; here just confirm this function never writes one
  sets = []; stored = { fulfillmentStatus: 'shipped', trackingNumber: 'OLD123', shippingCarrier: 'ROYAL_MAIL' };
  out = await markShippedNoTracking('u1', 'o1');
  assert.strictEqual(out.tracking_number, 'OLD123', 'calling this again never clears an existing tracking number either');

  // ---------- the eBay call: no trackingNumber given - the body has no trackingNumber/shippingCarrierCode keys at all ----------
  postCalls.length = 0;
  await createShippingFulfillment('rt', '11-1', 'li-1', 2);
  assert.strictEqual(postCalls.length, 1);
  assert.deepStrictEqual(Object.keys(postCalls[0].body).sort(), ['lineItems', 'shippedDate'], 'trackingNumber/shippingCarrierCode are left out entirely, not sent as null/undefined');
  assert.deepStrictEqual(postCalls[0].body.lineItems, [{ lineItemId: 'li-1', quantity: 2 }]);

  // a tracking number IS given: the body still carries both, exactly as before this change
  postCalls.length = 0;
  await createShippingFulfillment('rt', '11-1', 'li-1', 1, 'TRACK123', 'USPS');
  assert.strictEqual(postCalls[0].body.trackingNumber, 'TRACK123');
  assert.strictEqual(postCalls[0].body.shippingCarrierCode, 'USPS');

  // a tracking number with no carrier: falls back to 'OTHER', same as before
  postCalls.length = 0;
  await createShippingFulfillment('rt', '11-1', 'li-1', 1, 'TRACK999');
  assert.strictEqual(postCalls[0].body.shippingCarrierCode, 'OTHER');

  console.log('mark shipped (no tracking) tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
