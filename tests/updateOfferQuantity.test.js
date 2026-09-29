// services/ebayListingService.js updateOfferQuantity: a live listing's real available quantity is
// min(offer.availableQuantity, inventory_item.availability.shipToLocationAvailability.quantity) - eBay's own docs -
// so restocking must PUT both, not just the offer (confirmed 2026-09-29: two real listings "changed" in ELMS via the
// offer-only version but never moved on eBay). This is used by both jobs/stockMonitor.js (Amazon back in stock) and
// services/liveBulkRestockService.js (the seller's own "Restock" button).
//
// A second, later gap (confirmed again by a seller reporting the exact same "changed in ELMS, still sold out on
// eBay" symptom after the PUT-both fix): eBay answering 200 to a PUT is not proof the live listing actually changed
// - the offer can be sitting outside PUBLISHED (in which case a quantity/price write never reaches the live
// listing), or eBay can simply keep its own value. Both updateOfferQuantity and updateOfferPrice now re-read the
// offer+inventory item afterwards (republishing first if the offer isn't PUBLISHED) and THROW if what eBay actually
// holds does not match what was asked for - a caller that already treats a thrown error as "this one did not work"
// (bulkRestock, bulkLivePrice's single fallback, the stock monitor) is told the truth instead of a false success.
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

stub('services/ebayAuthService', { getAccessToken: async (rt) => 'AT-' + rt });

const calls = [];
let offerState = null;
let inventoryState = null;
let publishCalls = 0;
let failOn = null; // 'offer-get' | 'inventory-get' | 'inventory-put' | 'offer-put' | 'publish'
let silentNoop = false; // eBay accepts the PUT(s) with 200 but the mock's state does not actually change - simulates a real silent no-op

// axios is CALLED as a function (axios({...})), not axios.get/put - replace the export itself with a callable.
// Stateful (unlike a plain fixture): a PUT really updates offerState/inventoryState, so the verification re-GET that
// updateOfferQuantity/updateOfferPrice now does afterwards sees what was actually written, exactly like real eBay.
const axiosPath = require.resolve('axios');
require.cache[axiosPath] = {
  id: axiosPath, filename: axiosPath, loaded: true,
  exports: async (config) => {
    const isPublish = config.url.includes('/publish');
    const isOffer = !isPublish && config.url.includes('/sell/inventory/v1/offer/');
    const isInventory = config.url.includes('/sell/inventory/v1/inventory_item/');
    calls.push({ method: config.method, url: config.url, data: config.data, auth: config.headers.Authorization });
    if (failOn === 'offer-get' && config.method === 'GET' && isOffer) throw { response: { status: 404, data: { errors: [{ message: 'Offer not found.' }] } } };
    if (failOn === 'inventory-get' && config.method === 'GET' && isInventory) throw { response: { status: 404, data: { errors: [{ message: 'Inventory item not found.' }] } } };
    if (failOn === 'inventory-put' && config.method === 'PUT' && isInventory) throw { response: { status: 400, data: { errors: [{ message: 'Quantity is invalid.' }] } } };
    if (failOn === 'offer-put' && config.method === 'PUT' && isOffer) throw { response: { status: 400, data: { errors: [{ message: 'Offer is not published.' }] } } };
    if (failOn === 'publish' && isPublish) throw { response: { status: 400, data: { errors: [{ message: 'This offer has an unresolved issue.' }] } } };
    if (config.method === 'GET' && isOffer) return { data: offerState };
    if (config.method === 'GET' && isInventory) return { data: inventoryState };
    if (config.method === 'PUT' && isOffer) { if (!silentNoop) offerState = { ...offerState, ...config.data }; return { data: {} }; }
    if (config.method === 'PUT' && isInventory) { if (!silentNoop) inventoryState = { ...inventoryState, ...config.data }; return { data: {} }; }
    if (isPublish) { publishCalls += 1; offerState = { ...offerState, status: 'PUBLISHED' }; return { data: { listingId: 'LST1' } }; }
    return { data: {} };
  },
};

const { updateOfferQuantity, updateOfferPrice } = require('../services/ebayListingService');

const reset = () => {
  calls.length = 0; failOn = null; publishCalls = 0; silentNoop = false;
  offerState = { sku: 'B0TEST', availableQuantity: 0, status: 'PUBLISHED', categoryId: '177', listingPolicies: { paymentPolicyId: 'p1' }, pricingSummary: { price: { value: '19.99', currency: 'USD' } } };
  inventoryState = { condition: 'NEW', product: { title: 'A Kettle', imageUrls: ['https://i/1.jpg'] }, availability: { shipToLocationAvailability: { quantity: 0 } } };
};

(async () => {
  // ==================== updateOfferQuantity ====================

  // ---------- the happy path: both the inventory item AND the offer are PUT with the new quantity, then verified ----------
  reset();
  let out = await updateOfferQuantity('rt1', 'O123', 5);
  assert.strictEqual(out.offerId, 'O123');
  assert.strictEqual(out.quantity, 5);
  assert.strictEqual(out.live.quantity, 5, 'the returned `live` object is what eBay held after re-reading, not just an echo of the request');
  const kind = (c) => c.url.includes('/publish') ? 'publish' : c.url.includes('/offer/') ? 'offer' : 'inventory';
  assert.deepStrictEqual(calls.map((c) => c.method + ' ' + kind(c)), ['GET offer', 'GET inventory', 'PUT inventory', 'PUT offer', 'GET offer', 'GET inventory'], 'write both, then re-read both to verify - no republish needed, the offer was already PUBLISHED');
  const putInventory = calls.find((c) => c.method === 'PUT' && kind(c) === 'inventory');
  assert.strictEqual(putInventory.data.availability.shipToLocationAvailability.quantity, 5);
  assert.strictEqual(putInventory.data.condition, 'NEW', 'the rest of the inventory item is preserved, not wiped');
  assert.deepStrictEqual(putInventory.data.product.imageUrls, ['https://i/1.jpg']);
  const putOffer = calls.find((c) => c.method === 'PUT' && kind(c) === 'offer');
  assert.strictEqual(putOffer.data.availableQuantity, 5);
  assert.strictEqual(putOffer.data.categoryId, '177', 'the rest of the offer is preserved too');
  assert.ok(!('offerId' in putOffer.data) && !('listing' in putOffer.data), 'offerId/listing are stripped before PUTting the offer back (eBay rejects them)');
  assert.ok(calls.every((c) => c.auth === 'Bearer AT-rt1'));
  assert.strictEqual(publishCalls, 0);

  // ---------- an offer with no sku on it: the inventory item is never touched, and there is nothing to verify with (never throws) ----------
  reset(); offerState = { ...offerState, sku: undefined };
  out = await updateOfferQuantity('rt1', 'O123', 3);
  assert.deepStrictEqual(out, { offerId: 'O123', quantity: 3 }, 'no live check possible without a sku - the same lenient result as before this fix');
  assert.deepStrictEqual(calls.map((c) => c.method + ' ' + kind(c)), ['GET offer', 'PUT offer']);

  // ---------- eBay refusing the inventory item PUT surfaces its own message, and the offer is never touched ----------
  reset(); failOn = 'inventory-put';
  await assert.rejects(() => updateOfferQuantity('rt1', 'O123', 5), /Quantity is invalid/);
  assert.ok(!calls.some((c) => c.method === 'PUT' && kind(c) === 'offer'), 'the offer PUT never runs after the inventory item PUT failed');

  // ---------- the offer was not PUBLISHED: it is republished before the quantity is trusted, then verified normally ----------
  reset(); offerState.status = 'UNPUBLISHED';
  out = await updateOfferQuantity('rt1', 'O123', 7);
  assert.strictEqual(out.quantity, 7);
  assert.strictEqual(publishCalls, 1);
  assert.deepStrictEqual(calls.map((c) => c.method + ' ' + kind(c)), ['GET offer', 'GET inventory', 'PUT inventory', 'PUT offer', 'POST publish', 'GET offer', 'GET inventory'], 'republish happens after both writes, before the verifying re-read');

  // ---------- republishing itself fails: a clear, specific error, not eBay's raw one ----------
  reset(); offerState.status = 'UNPUBLISHED'; failOn = 'publish';
  await assert.rejects(() => updateOfferQuantity('rt1', 'O123', 5), /unresolved issue|is unpublished and could not be republished/i);

  // ---------- eBay answers 200 but the live listing never actually moves (a real, observed eBay failure mode): this now throws instead of reporting false success ----------
  reset(); silentNoop = true;
  await assert.rejects(() => updateOfferQuantity('rt1', 'O123', 5), /still shows 0 available/);

  // ---------- input validation: unchanged from before ----------
  reset();
  await assert.rejects(() => updateOfferQuantity('rt1', null, 5), /offerId is required/);
  await assert.rejects(() => updateOfferQuantity('rt1', 'O123', 0), /valid positive integer/);
  await assert.rejects(() => updateOfferQuantity('rt1', 'O123', 1.5), /valid positive integer/);
  assert.strictEqual(calls.length, 0, 'a bad argument never reaches eBay at all');

  // ==================== updateOfferPrice ====================

  // ---------- the happy path: the offer is PUT with the new price, then verified ----------
  reset();
  out = await updateOfferPrice('rt1', 'O123', 24.5);
  assert.strictEqual(out.newPrice, '24.50');
  assert.strictEqual(out.live.price, 24.5);
  assert.deepStrictEqual(calls.map((c) => c.method + ' ' + kind(c)), ['GET offer', 'PUT offer', 'GET offer', 'GET inventory'], 'price only PUTs the offer, but verification still reads both (the same fetchLiveListing as quantity)');
  assert.strictEqual(publishCalls, 0);

  // ---------- not published: republished first, then verified ----------
  reset(); offerState.status = 'UNPUBLISHED';
  out = await updateOfferPrice('rt1', 'O123', 30);
  assert.strictEqual(out.live.price, 30);
  assert.strictEqual(publishCalls, 1);

  // ---------- a silent no-op is caught here too ----------
  reset(); silentNoop = true;
  await assert.rejects(() => updateOfferPrice('rt1', 'O123', 30), /still shows 19\.99/);

  console.log('updateOfferQuantity / updateOfferPrice tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
