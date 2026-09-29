// services/ebayListingService.js updateOfferQuantity: a live listing's real available quantity is
// min(offer.availableQuantity, inventory_item.availability.shipToLocationAvailability.quantity) - eBay's own docs -
// so restocking must PUT both, not just the offer (confirmed 2026-09-29: two real listings "changed" in ELMS via the
// offer-only version but never moved on eBay). This is used by both jobs/stockMonitor.js (Amazon back in stock) and
// services/liveBulkRestockService.js (the seller's own "Restock" button).
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

stub('services/ebayAuthService', { getAccessToken: async (rt) => 'AT-' + rt });

const calls = [];
let offerBody = null;
let inventoryBody = null;
let failOn = null; // 'offer-get' | 'inventory-get' | 'inventory-put' | 'offer-put'

// axios is CALLED as a function (axios({...})), not axios.get/put - replace the export itself with a callable.
const axiosPath = require.resolve('axios');
require.cache[axiosPath] = {
  id: axiosPath, filename: axiosPath, loaded: true,
  exports: async (config) => {
    const isGetOffer = config.method === 'GET' && config.url.includes('/sell/inventory/v1/offer/');
    const isGetInventory = config.method === 'GET' && config.url.includes('/sell/inventory/v1/inventory_item/');
    const isPutInventory = config.method === 'PUT' && config.url.includes('/sell/inventory/v1/inventory_item/');
    const isPutOffer = config.method === 'PUT' && config.url.includes('/sell/inventory/v1/offer/');
    calls.push({ method: config.method, url: config.url, data: config.data, auth: config.headers.Authorization });
    if (failOn === 'offer-get' && isGetOffer) throw { response: { status: 404, data: { errors: [{ message: 'Offer not found.' }] } } };
    if (failOn === 'inventory-get' && isGetInventory) throw { response: { status: 404, data: { errors: [{ message: 'Inventory item not found.' }] } } };
    if (failOn === 'inventory-put' && isPutInventory) throw { response: { status: 400, data: { errors: [{ message: 'Quantity is invalid.' }] } } };
    if (failOn === 'offer-put' && isPutOffer) throw { response: { status: 400, data: { errors: [{ message: 'Offer is not published.' }] } } };
    if (isGetOffer) return { data: offerBody };
    if (isGetInventory) return { data: inventoryBody };
    return { data: {} };
  },
};

const { updateOfferQuantity } = require('../services/ebayListingService');

const reset = () => {
  calls.length = 0; failOn = null;
  offerBody = { sku: 'B0TEST', availableQuantity: 0, categoryId: '177', listingPolicies: { paymentPolicyId: 'p1' }, pricingSummary: { price: { value: '19.99', currency: 'USD' } } };
  inventoryBody = { condition: 'NEW', product: { title: 'A Kettle', imageUrls: ['https://i/1.jpg'] }, availability: { shipToLocationAvailability: { quantity: 0 } } };
};

(async () => {
  // ---------- the happy path: both the inventory item AND the offer are PUT with the new quantity ----------
  reset();
  const out = await updateOfferQuantity('rt1', 'O123', 5);
  assert.deepStrictEqual(out, { offerId: 'O123', quantity: 5 });
  const methods = calls.map((c) => c.method + ' ' + (c.url.includes('/offer/') ? 'offer' : 'inventory'));
  assert.deepStrictEqual(methods, ['GET offer', 'GET inventory', 'PUT inventory', 'PUT offer'], 'offer read first (for the SKU), then inventory read+write, then the offer write');
  const putInventory = calls.find((c) => c.method === 'PUT' && c.url.includes('inventory_item'));
  assert.strictEqual(putInventory.data.availability.shipToLocationAvailability.quantity, 5);
  assert.strictEqual(putInventory.data.condition, 'NEW', 'the rest of the inventory item is preserved, not wiped');
  assert.deepStrictEqual(putInventory.data.product.imageUrls, ['https://i/1.jpg']);
  const putOffer = calls.find((c) => c.method === 'PUT' && c.url.includes('/offer/'));
  assert.strictEqual(putOffer.data.availableQuantity, 5);
  assert.strictEqual(putOffer.data.categoryId, '177', 'the rest of the offer is preserved too');
  assert.ok(!('offerId' in putOffer.data) && !('listing' in putOffer.data), 'offerId/listing are stripped before PUTting the offer back (eBay rejects them)');
  assert.ok(calls.every((c) => c.auth === 'Bearer AT-rt1'));

  // ---------- an offer with no sku on it: the inventory item is never touched, only the offer (never throws) ----------
  reset(); offerBody = { ...offerBody, sku: undefined };
  await updateOfferQuantity('rt1', 'O123', 3);
  assert.deepStrictEqual(calls.map((c) => c.method + ' ' + (c.url.includes('/offer/') ? 'offer' : 'inventory')), ['GET offer', 'PUT offer']);

  // ---------- eBay refusing the inventory item PUT surfaces its own message, and the offer is never touched ----------
  reset(); failOn = 'inventory-put';
  await assert.rejects(() => updateOfferQuantity('rt1', 'O123', 5), /Quantity is invalid/);
  assert.ok(!calls.some((c) => c.method === 'PUT' && c.url.includes('/offer/')), 'the offer PUT never runs after the inventory item PUT failed');

  // ---------- input validation: unchanged from before ----------
  reset();
  await assert.rejects(() => updateOfferQuantity('rt1', null, 5), /offerId is required/);
  await assert.rejects(() => updateOfferQuantity('rt1', 'O123', 0), /valid positive integer/);
  await assert.rejects(() => updateOfferQuantity('rt1', 'O123', 1.5), /valid positive integer/);
  assert.strictEqual(calls.length, 0, 'a bad argument never reaches eBay at all');

  console.log('updateOfferQuantity tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
