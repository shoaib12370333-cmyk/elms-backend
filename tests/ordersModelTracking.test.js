// models/ordersModel.js hasOrderLineItemsNeedingTracking/importTrackingFromEbay: the exact filter used to decide
// whether an extra eBay call is worth making, and that importing tracking from eBay never overwrites a tracking
// number ELMS already has (from setTracking or an earlier run of this same function).
const assert = require('assert');
const stub = (specifier, exports) => { const p = require.resolve(specifier); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

let lastExistsFilter = null;
let existsReturns = false;
const updateCalls = [];
stub('../models/schemas/Order', {
  exists: async (filter) => { lastExistsFilter = filter; return existsReturns; },
  updateOne: async (filter, update) => { updateCalls.push({ filter, update }); return { modifiedCount: filter.trackingNumber === null && update.trackingNumber ? 1 : 0 }; },
});
stub('../models/schemas/Listing', {});
stub('../models/schemas/Import', {});
stub('../services/currencyService', { warmRates: async () => {}, convertCached: (v) => v });
stub('../config/amazonDomains', { sourceCurrency: () => 'USD' });
stub('../services/accountLabel', { accountLabel: () => null, publicUsername: () => null });

const { hasOrderLineItemsNeedingTracking, importTrackingFromEbay } = require('../models/ordersModel');

(async () => {
  // ---------- hasOrderLineItemsNeedingTracking: exact filter (scoped to the user, account and eBay order) ----------
  existsReturns = true;
  const needs = await hasOrderLineItemsNeedingTracking('u1', 'acc1', 'O1');
  assert.strictEqual(needs, true);
  assert.deepStrictEqual(lastExistsFilter, { userId: 'u1', ebayAccountId: 'acc1', ebayOrderId: 'O1', trackingNumber: null });
  existsReturns = false;
  assert.strictEqual(await hasOrderLineItemsNeedingTracking('u1', 'acc1', 'O1'), false);

  // ---------- importTrackingFromEbay: one updateOne per (fulfillment, lineItem) pair, filtered on trackingNumber: null
  // so an already-tracked line item (e.g. set by the seller through ELMS) is never touched ----------
  updateCalls.length = 0;
  const fulfillments = [
    { shipmentTrackingNumber: '1Z999', shippingCarrierCode: 'UPS', lineItems: [{ lineItemId: 'li1' }, { lineItemId: 'li2' }] },
    { shipmentTrackingNumber: null, shippingCarrierCode: 'USPS', lineItems: [{ lineItemId: 'li3' }] }, // no tracking number yet - nothing to import
  ];
  const updated = await importTrackingFromEbay('u1', 'acc1', 'O1', fulfillments);
  assert.strictEqual(updateCalls.length, 2, 'one call per line item of the fulfillment that HAS a tracking number; the one without is skipped entirely');
  assert.deepStrictEqual(updateCalls[0].filter, { userId: 'u1', ebayAccountId: 'acc1', ebayOrderId: 'O1', ebayLineItemId: 'li1', trackingNumber: null }, 'never overwrites an existing tracking number - atomic in the filter itself');
  assert.deepStrictEqual(updateCalls[0].update, { trackingNumber: '1Z999', shippingCarrier: 'UPS', fulfillmentStatus: 'shipped' });
  assert.strictEqual(updateCalls[1].filter.ebayLineItemId, 'li2');
  assert.strictEqual(updated, 2, 'counts only the line items actually modified');

  // ---------- a line item reference with no lineItemId is skipped, never crashes ----------
  updateCalls.length = 0;
  await importTrackingFromEbay('u1', 'acc1', 'O2', [{ shipmentTrackingNumber: 'X', lineItems: [{}] }]);
  assert.strictEqual(updateCalls.length, 0);

  // ---------- no fulfillments at all: a no-op, never throws ----------
  assert.strictEqual(await importTrackingFromEbay('u1', 'acc1', 'O3', []), 0);
  assert.strictEqual(await importTrackingFromEbay('u1', 'acc1', 'O3', undefined), 0);

  console.log('orders model tracking tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
