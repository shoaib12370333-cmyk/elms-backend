// services/ebayListingService.js updateOfferQuantity: a live listing's real available quantity is
// min(offer.availableQuantity, inventory_item.availability.shipToLocationAvailability.quantity) - eBay's own docs -
// so restocking must write both, not just the offer (confirmed 2026-09-29: two real listings "changed" in ELMS via the
// offer-only version but never moved on eBay). This is used by both jobs/stockMonitor.js (Amazon back in stock) and
// services/liveBulkRestockService.js (the seller's own "Restock" button).
//
// A second, later gap (confirmed again by a seller reporting the exact same "changed in ELMS, still sold out on
// eBay" symptom after the write-both fix): eBay answering 200 to a PUT is not proof the live listing actually changed
// - the offer can be sitting outside PUBLISHED (in which case a quantity/price write never reaches the live
// listing), or eBay can simply keep its own value. Both updateOfferQuantity and updateOfferPrice now re-read the
// offer+inventory item afterwards (republishing first if the offer isn't PUBLISHED) and THROW if what eBay actually
// holds does not match what was asked for - a caller that already treats a thrown error as "this one did not work"
// (bulkRestock, bulkLivePrice's single fallback, the stock monitor) is told the truth instead of a false success.
//
// A third gap (2026-10-03, six sold-out listings): writing the WHOLE inventory item back made eBay refuse every one with
// "Invalid value for weight.value" (25709) - the package weight eBay had returned itself. The SKU's quantity is now set
// with eBay's own quantity update (bulk_update_price_quantity, only shipToLocationAvailability), which never sends the
// rest of the item back; the whole-item write is only the fallback when eBay does not positively confirm that.
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

stub('services/ebayAuthService', { getAccessToken: async (rt) => 'AT-' + rt });

const calls = [];
let offerState = null;
let inventoryState = null;
let publishCalls = 0;
let failOn = null; // 'offer-get' | 'inventory-get' | 'inventory-put' | 'offer-put' | 'publish'
let silentNoop = false; // eBay accepts the write(s) with 200 but the mock's state does not actually change - simulates a real silent no-op
let staleGetsLeft = 0; // how many GETs, after the first write, still answer with the PRE-write snapshot - simulates eBay's real read-after-write lag
let writesHappened = false;
let preWriteOffer = null;
let preWriteInventory = null;
let bulkMode = 'ok'; // the quantity-only call: 'ok' | 'throw' | 'entry-error' | 'entry-400-no-errors' | 'entry-200-with-errors' | 'unconfirmed' | 'other-sku' | 'noop' (a clean 2xx answer, nothing changes)
let weightRefused = null; // null | 'when-present' (eBay refuses a whole-item PUT that carries a package weight) | 'always' (refuses with or without)
let otherInvalidValue = false; // the whole-item PUT is refused with 25709 for a field that is NOT the weight
let policyCost = {}; // fulfillment policy id -> 'FLAT_RATE' | 'CALCULATED' | 'THROW'
let staleItemReads = 0; // how many reads of the INVENTORY ITEM, after the first write, still answer with the pre-write item (the offer is already fresh)
let itemBonus = 0; // the quantity-only call leaves the SKU's stock this much higher than asked (eBay keeps its own larger figure / a sale came in)

const weightError = () => ({ response: { status: 400, data: { errors: [{ errorId: 25709, message: 'Invalid value for weight.value.', parameters: [{ name: 'weight.value', value: '0' }] }] } } });

// axios is CALLED as a function (axios({...})), not axios.get/put - replace the export itself with a callable.
// Stateful (unlike a plain fixture): a write really updates offerState/inventoryState, so the verification re-GET that
// updateOfferQuantity/updateOfferPrice now does afterwards sees what was actually written, exactly like real eBay.
const axiosPath = require.resolve('axios');
require.cache[axiosPath] = {
  id: axiosPath, filename: axiosPath, loaded: true,
  exports: async (config) => {
    const isPublish = config.url.includes('/publish');
    const isBulk = config.url.includes('/bulk_update_price_quantity');
    const isPolicy = config.url.includes('/sell/account/v1/fulfillment_policy/');
    const isOffer = !isPublish && config.url.includes('/sell/inventory/v1/offer/');
    const isInventory = config.url.includes('/sell/inventory/v1/inventory_item/');
    calls.push({ method: config.method, url: config.url, data: config.data, auth: config.headers.Authorization, marketplace: config.headers['X-EBAY-C-MARKETPLACE-ID'] });
    if (failOn === 'offer-get' && config.method === 'GET' && isOffer) throw { response: { status: 404, data: { errors: [{ message: 'Offer not found.' }] } } };
    if (failOn === 'inventory-get' && config.method === 'GET' && isInventory) throw { response: { status: 404, data: { errors: [{ message: 'Inventory item not found.' }] } } };
    if (failOn === 'inventory-put' && config.method === 'PUT' && isInventory) throw { response: { status: 400, data: { errors: [{ message: 'Quantity is invalid.' }] } } };
    if (failOn === 'offer-put' && config.method === 'PUT' && isOffer) throw { response: { status: 400, data: { errors: [{ message: 'Offer is not published.' }] } } };
    if (failOn === 'publish' && isPublish) throw { response: { status: 400, data: { errors: [{ message: 'This offer has an unresolved issue.' }] } } };
    if (failOn === 'publish-transient-once' && isPublish && publishCalls === 0) { publishCalls += 1; throw { response: { status: 503, data: { errors: [{ message: 'eBay is temporarily unavailable.' }] } } }; }
    if (failOn === 'publish-transient-always' && isPublish) throw { response: { status: 503, data: { errors: [{ message: 'eBay is temporarily unavailable.' }] } } };
    if (isPolicy) {
      const id = decodeURIComponent(config.url.split('/').pop());
      if (policyCost[id] === 'THROW') throw { response: { status: 500, data: { errors: [{ message: 'Policy service down.' }] } } };
      return { data: { shippingOptions: [{ costType: policyCost[id] || 'FLAT_RATE' }] } };
    }
    if (isBulk) {
      if (bulkMode === 'throw') throw { response: { status: 400, data: { errors: [{ errorId: 25002, message: 'Bad bulk request.' }] } } };
      const reqs = config.data.requests;
      if (!writesHappened) { preWriteOffer = { ...offerState }; preWriteInventory = { ...inventoryState }; writesHappened = true; }
      if (bulkMode === 'unconfirmed') return { data: {} };
      if (bulkMode === 'entry-error') return { data: { responses: reqs.map((r) => ({ sku: r.sku, statusCode: 400, errors: [{ errorId: 25002, message: 'Refused.' }] })) } };
      if (bulkMode === 'entry-400-no-errors') return { data: { responses: reqs.map((r) => ({ sku: r.sku, statusCode: 400 })) } };
      if (bulkMode === 'entry-200-with-errors') return { data: { responses: reqs.map((r) => ({ sku: r.sku, statusCode: 200, errors: [{ errorId: 25002, message: 'Refused after all.' }] })) } };
      if (bulkMode === 'noop') return { status: 207, data: { responses: reqs.map((r) => ({ sku: r.sku, statusCode: 200 })) } };
      if (bulkMode === 'other-sku') return { data: { responses: [{ sku: 'SOMETHING-ELSE', statusCode: 200 }] } };
      if (!silentNoop) {
        for (const r of reqs) {
          inventoryState = { ...inventoryState, availability: { ...(inventoryState.availability || {}), shipToLocationAvailability: { ...(inventoryState.availability?.shipToLocationAvailability || {}), quantity: r.shipToLocationAvailability.quantity + itemBonus } } };
        }
      }
      return { status: 207, data: { responses: reqs.map((r) => ({ sku: r.sku, statusCode: 200 })) } };
    }
    if (config.method === 'GET' && isOffer) {
      if (writesHappened && staleGetsLeft > 0) { staleGetsLeft -= 1; return { data: preWriteOffer }; }
      return { data: offerState };
    }
    if (config.method === 'GET' && isInventory) {
      if (writesHappened && staleItemReads > 0) { staleItemReads -= 1; return { data: preWriteInventory }; }
      if (writesHappened && staleGetsLeft > 0) { staleGetsLeft -= 1; return { data: preWriteInventory }; }
      return { data: inventoryState };
    }
    if (config.method === 'PUT' && isOffer) {
      if (!writesHappened) { preWriteOffer = { ...offerState }; preWriteInventory = { ...inventoryState }; writesHappened = true; }
      if (!silentNoop) offerState = { ...offerState, ...config.data };
      return { data: {} };
    }
    if (config.method === 'PUT' && isInventory) {
      if (weightRefused === 'param-only' && config.data.packageWeightAndSize) throw { response: { status: 400, data: { errors: [{ errorId: 25709, message: 'Invalid value for a field.', parameters: [{ name: 'packageWeightAndSize.weight.value', value: '0' }] }] } } };
      if (weightRefused === 'always' || (weightRefused === 'when-present' && config.data.packageWeightAndSize)) throw weightError();
      if (otherInvalidValue) throw { response: { status: 400, data: { errors: [{ errorId: 25709, message: 'Invalid value for product.title.', parameters: [{ name: 'product.title', value: '' }] }] } } };
      if (!writesHappened) { preWriteOffer = { ...offerState }; preWriteInventory = { ...inventoryState }; writesHappened = true; }
      if (!silentNoop) inventoryState = { ...inventoryState, ...config.data };
      return { data: {} };
    }
    if (isPublish) { publishCalls += 1; offerState = { ...offerState, status: 'PUBLISHED' }; return { data: { listingId: 'LST1' } }; }
    return { data: {} };
  },
};

const { updateOfferQuantity, updateOfferPrice, VERIFY_RETRY } = require('../services/ebayListingService');
VERIFY_RETRY.delayMs = 1; // do not really wait 1.5s per retry in a test

const reset = () => {
  calls.length = 0; failOn = null; publishCalls = 0; silentNoop = false; staleGetsLeft = 0; writesHappened = false; preWriteOffer = null; preWriteInventory = null;
  bulkMode = 'ok'; weightRefused = null; otherInvalidValue = false; policyCost = {}; itemBonus = 0; staleItemReads = 0;
  offerState = { sku: 'B0TEST', availableQuantity: 0, status: 'PUBLISHED', categoryId: '177', listingPolicies: { paymentPolicyId: 'p1' }, pricingSummary: { price: { value: '19.99', currency: 'USD' } } };
  inventoryState = { condition: 'NEW', product: { title: 'A Kettle', imageUrls: ['https://i/1.jpg'] }, availability: { shipToLocationAvailability: { quantity: 0 } } };
};
const kind = (c) => c.url.includes('/publish') ? 'publish' : c.url.includes('/bulk_update_price_quantity') ? 'bulk' : c.url.includes('/fulfillment_policy/') ? 'policy' : c.url.includes('/offer/') ? 'offer' : 'inventory';
const seq = () => calls.map((c) => c.method + ' ' + kind(c));
const inventoryPuts = () => calls.filter((c) => c.method === 'PUT' && kind(c) === 'inventory');
const weighted = { weight: { value: 0, unit: 'POUND' } }; // what eBay handed back for the six sold-out listings

(async () => {
  // ==================== updateOfferQuantity ====================

  // ---------- the happy path: the SKU's quantity is set with eBay's quantity-only call, the offer is PUT with the new quantity, then verified ----------
  reset();
  let out = await updateOfferQuantity('rt1', 'O123', 5);
  assert.strictEqual(out.offerId, 'O123');
  assert.strictEqual(out.quantity, 5);
  assert.strictEqual(out.live.quantity, 5, 'the returned `live` object is what eBay held after re-reading, not just an echo of the request');
  assert.deepStrictEqual(seq(), ['GET offer', 'POST bulk', 'PUT offer', 'GET offer', 'GET inventory'], 'quantity-only call, offer write, then re-read both to verify - no republish needed, the offer was already PUBLISHED');
  const bulk = calls.find((c) => kind(c) === 'bulk');
  assert.deepStrictEqual(bulk.data, { requests: [{ sku: 'B0TEST', shipToLocationAvailability: { quantity: 5 } }] }, 'ONLY the quantity of that SKU is sent: nothing else of the inventory item');
  assert.strictEqual(inventoryPuts().length, 0, 'the whole inventory item is not written back');
  assert.ok(bulk.url.endsWith('/sell/inventory/v1/bulk_update_price_quantity'));
  const putOffer = calls.find((c) => c.method === 'PUT' && kind(c) === 'offer');
  assert.strictEqual(putOffer.data.availableQuantity, 5);
  assert.strictEqual(putOffer.data.categoryId, '177', 'the rest of the offer is preserved');
  assert.ok(!('offerId' in putOffer.data) && !('listing' in putOffer.data), 'offerId/listing are stripped before PUTting the offer back (eBay rejects them)');
  assert.ok(calls.every((c) => c.auth === 'Bearer AT-rt1'));
  assert.strictEqual(publishCalls, 0);

  // ---------- the marketplace of the offer travels with the quantity-only call ----------
  reset(); offerState.marketplaceId = 'EBAY_GB';
  await updateOfferQuantity('rt1', 'O123', 2);
  assert.strictEqual(calls.find((c) => kind(c) === 'bulk').marketplace, 'EBAY_GB');

  // ---------- THE FIX: an item whose package weight eBay refuses on a whole-item write (the six sold-out listings) is restocked without that write ----------
  reset(); inventoryState.packageWeightAndSize = weighted; weightRefused = 'when-present';
  out = await updateOfferQuantity('rt1', 'O123', 1);
  assert.strictEqual(out.quantity, 1); assert.strictEqual(out.live.quantity, 1);
  assert.strictEqual(inventoryPuts().length, 0, 'the refused weight is never sent back');
  assert.deepStrictEqual(inventoryState.packageWeightAndSize, weighted, "the item's package weight is left exactly as it was");

  // ---------- eBay answers the quantity-only call with a clean 2xx but the SKU's stock does not move (the listing shows the LOWER of offer and stock, so it would stay
  // sold out): the check that follows reads the SKU's own stock too and refuses to call that a restock ----------
  reset(); bulkMode = 'noop';
  await assert.rejects(() => updateOfferQuantity('rt1', 'O123', 5), /stock of this item still shows 0/);
  // ...while a stock figure that is HIGHER than asked is fine (eBay kept a larger one, or a sale came in): only "not enough" is refused
  reset(); itemBonus = 2;
  out = await updateOfferQuantity('rt1', 'O123', 5);
  assert.strictEqual(out.quantity, 5); assert.strictEqual(out.live.itemQuantity, 7);
  // the SKU's stock is slower to show than the offer (eBay's read lag hits the two reads separately): it is waited for, not refused at the first read
  reset(); staleItemReads = 2;
  out = await updateOfferQuantity('rt1', 'O123', 5);
  assert.strictEqual(out.live.itemQuantity, 5); assert.strictEqual(staleItemReads, 0, 'the stale item reads were really consumed');
  // an item that reports no stock figure at all has nothing to compare: the offer's verified quantity decides, as before
  reset(); bulkMode = 'noop'; delete inventoryState.availability;
  out = await updateOfferQuantity('rt1', 'O123', 5);
  assert.strictEqual(out.quantity, 5); assert.strictEqual(out.live.itemQuantity, null);
  // the same stock check holds when the whole item had to be written
  reset(); bulkMode = 'unconfirmed'; silentNoop = false;
  out = await updateOfferQuantity('rt1', 'O123', 3);
  assert.strictEqual(out.live.itemQuantity, 3);

  // ---------- an offer with no sku on it: the inventory item is never touched, and there is nothing to verify with (never throws) ----------
  reset(); offerState = { ...offerState, sku: undefined };
  out = await updateOfferQuantity('rt1', 'O123', 3);
  assert.deepStrictEqual(out, { offerId: 'O123', quantity: 3 }, 'no live check possible without a sku - the same lenient result as before this fix');
  assert.deepStrictEqual(seq(), ['GET offer', 'PUT offer']);

  // ---------- eBay not taking the quantity-only call: the whole item is read and written back, as it always was ----------
  for (const mode of ['throw', 'entry-error', 'entry-400-no-errors', 'entry-200-with-errors', 'unconfirmed', 'other-sku']) {
    reset(); bulkMode = mode;
    out = await updateOfferQuantity('rt1', 'O123', 4);
    assert.strictEqual(out.quantity, 4, mode);
    assert.deepStrictEqual(seq(), ['GET offer', 'POST bulk', 'GET inventory', 'PUT inventory', 'PUT offer', 'GET offer', 'GET inventory'], `${mode}: not positively confirmed -> the whole item is written`);
    const put = inventoryPuts()[0];
    assert.strictEqual(put.data.availability.shipToLocationAvailability.quantity, 4);
    assert.strictEqual(put.data.condition, 'NEW', 'the rest of the inventory item is preserved, not wiped');
    assert.deepStrictEqual(put.data.product.imageUrls, ['https://i/1.jpg']);
  }

  // ---------- eBay refusing the inventory item PUT surfaces its own message, and the offer is never touched ----------
  reset(); bulkMode = 'throw'; failOn = 'inventory-put';
  await assert.rejects(() => updateOfferQuantity('rt1', 'O123', 5), /Quantity is invalid/);
  assert.ok(!calls.some((c) => c.method === 'PUT' && kind(c) === 'offer'), 'the offer PUT never runs after the inventory item PUT failed');

  // ---------- fallback + the weight: a FLAT-rate policy never needs a weight, so that one refused value is left out and the write repeated ONCE ----------
  reset(); bulkMode = 'unconfirmed'; weightRefused = 'when-present'; inventoryState.packageWeightAndSize = weighted;
  offerState.listingPolicies = { fulfillmentPolicyId: 'FP-FLAT' }; policyCost['FP-FLAT'] = 'FLAT_RATE';
  out = await updateOfferQuantity('rt1', 'O123', 6);
  assert.strictEqual(out.quantity, 6);
  let puts = inventoryPuts();
  assert.strictEqual(puts.length, 2, 'the refused write, then the repeat without the weight');
  assert.ok(puts[0].data.packageWeightAndSize, 'the first write is the plain one');
  assert.ok(!('packageWeightAndSize' in puts[1].data), 'the repeat has no package weight/size');
  assert.strictEqual(puts[1].data.availability.shipToLocationAvailability.quantity, 6);
  assert.strictEqual(puts[1].data.condition, 'NEW'); assert.deepStrictEqual(puts[1].data.product.imageUrls, ['https://i/1.jpg']);
  // ...with the offer's marketplace on the policy lookup, and the weight named only in the error's parameters is recognised too
  reset(); bulkMode = 'unconfirmed'; weightRefused = 'param-only'; inventoryState.packageWeightAndSize = weighted;
  offerState.marketplaceId = 'EBAY_GB'; offerState.listingPolicies = { fulfillmentPolicyId: 'FP-FLAT-GB' }; policyCost['FP-FLAT-GB'] = 'FLAT_RATE';
  out = await updateOfferQuantity('rt1', 'O123', 6);
  assert.strictEqual(out.quantity, 6); assert.strictEqual(inventoryPuts().length, 2);
  assert.strictEqual(calls.find((c) => kind(c) === 'policy').marketplace, 'EBAY_GB');

  // ---------- ...but never for a CALCULATED policy (the weight is what prices the postage), an unknown policy, or a listing with no policy on it ----------
  for (const [label, setup] of [
    ['calculated policy', () => { offerState.listingPolicies = { fulfillmentPolicyId: 'FP-CALC' }; policyCost['FP-CALC'] = 'CALCULATED'; }],
    ['policy lookup fails', () => { offerState.listingPolicies = { fulfillmentPolicyId: 'FP-ERR' }; policyCost['FP-ERR'] = 'THROW'; }],
    ['no fulfillment policy on the offer', () => { offerState.listingPolicies = { paymentPolicyId: 'p1' }; }],
  ]) {
    reset(); bulkMode = 'unconfirmed'; weightRefused = 'when-present'; inventoryState.packageWeightAndSize = weighted; setup();
    await assert.rejects(() => updateOfferQuantity('rt1', 'O123', 6), /Invalid value for weight\.value/, label);
    assert.strictEqual(inventoryPuts().length, 1, `${label}: no second write`);
    assert.ok(!calls.some((c) => c.method === 'PUT' && kind(c) === 'offer'), `${label}: the offer is not touched`);
  }

  // ---------- only a refusal OF THE WEIGHT is repeated: another invalid value is thrown; and the repeat is a single one, not a loop ----------
  reset(); bulkMode = 'unconfirmed'; otherInvalidValue = true; inventoryState.packageWeightAndSize = weighted;
  offerState.listingPolicies = { fulfillmentPolicyId: 'FP-FLAT2' }; policyCost['FP-FLAT2'] = 'FLAT_RATE';
  await assert.rejects(() => updateOfferQuantity('rt1', 'O123', 6), /Invalid value for product\.title/);
  assert.strictEqual(inventoryPuts().length, 1, 'another invalid value is not "fixed" by leaving the weight out');
  reset(); bulkMode = 'unconfirmed'; weightRefused = 'always'; inventoryState.packageWeightAndSize = weighted;
  offerState.listingPolicies = { fulfillmentPolicyId: 'FP-FLAT3' }; policyCost['FP-FLAT3'] = 'FLAT_RATE';
  await assert.rejects(() => updateOfferQuantity('rt1', 'O123', 6), /Invalid value for weight\.value/);
  assert.strictEqual(inventoryPuts().length, 2, 'refused again without the weight: stop (exactly one repeat)');
  reset(); bulkMode = 'unconfirmed'; weightRefused = 'always'; // an item with no package weight at all cannot be refused for it: nothing to leave out
  offerState.listingPolicies = { fulfillmentPolicyId: 'FP-FLAT4' }; policyCost['FP-FLAT4'] = 'FLAT_RATE';
  await assert.rejects(() => updateOfferQuantity('rt1', 'O123', 6), /Invalid value for weight\.value/);
  assert.strictEqual(inventoryPuts().length, 1);

  // ---------- the offer was not PUBLISHED: it is republished before the quantity is trusted, then verified normally ----------
  reset(); offerState.status = 'UNPUBLISHED';
  out = await updateOfferQuantity('rt1', 'O123', 7);
  assert.strictEqual(out.quantity, 7);
  assert.strictEqual(publishCalls, 1);
  assert.deepStrictEqual(seq(), ['GET offer', 'POST bulk', 'PUT offer', 'POST publish', 'GET offer', 'GET inventory'], 'republish happens after both writes, before the verifying re-read');

  // ---------- republishing itself fails: a clear, specific error, not eBay's raw one ----------
  reset(); offerState.status = 'UNPUBLISHED'; failOn = 'publish';
  await assert.rejects(() => updateOfferQuantity('rt1', 'O123', 5), /unresolved issue|is unpublished and could not be republished/i);

  // ---------- republishing hits a transient eBay hiccup (not a real problem with the listing): retried once, and
  // this time it succeeds - before this fix, a plain "eBay is briefly down" failed the whole restock permanently,
  // indistinguishable from a genuine unresolved-issue refusal ----------
  reset(); offerState.status = 'UNPUBLISHED'; failOn = 'publish-transient-once';
  out = await updateOfferQuantity('rt1', 'O123', 6);
  assert.strictEqual(out.quantity, 6);
  assert.strictEqual(publishCalls, 2, 'the failed attempt, then the retry that succeeded');

  // ---------- the transient hiccup does not clear up even after the retry: still fails, but the one retry is given ----------
  reset(); offerState.status = 'UNPUBLISHED'; failOn = 'publish-transient-always';
  await assert.rejects(() => updateOfferQuantity('rt1', 'O123', 5), /temporarily unavailable/);

  // ---------- eBay answers 200 but the live listing never actually moves (a real, observed eBay failure mode): this now throws instead of reporting false success ----------
  reset(); silentNoop = true;
  await assert.rejects(() => updateOfferQuantity('rt1', 'O123', 5), /still shows 0 available/);

  // ---------- eBay's own read-after-write lag (also real and observed: every restock in a seller's very first
  // batch after the check above was added failed verification on the FIRST read, one retry later they had all
  // actually gone through) - the first two verifying reads still see the pre-write snapshot, the third sees the
  // real, changed value: this must succeed, not be reported as a failure just because the confirming read raced ahead ----------
  reset(); staleGetsLeft = 4; // 2 stale rounds (2 GETs each) before the 3rd round finally reads the real state
  out = await updateOfferQuantity('rt1', 'O123', 9);
  assert.strictEqual(out.quantity, 9);
  assert.strictEqual(out.live.quantity, 9);
  assert.strictEqual(staleGetsLeft, 0, 'exactly as many stale reads as arranged were consumed - the retry loop did not stop early or loop forever');

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
  assert.deepStrictEqual(seq(), ['GET offer', 'PUT offer', 'GET offer', 'GET inventory'], 'price only PUTs the offer, but verification still reads both (the same fetchLiveListing as quantity)');
  assert.strictEqual(publishCalls, 0);

  // ---------- not published: republished first, then verified ----------
  reset(); offerState.status = 'UNPUBLISHED';
  out = await updateOfferPrice('rt1', 'O123', 30);
  assert.strictEqual(out.live.price, 30);
  assert.strictEqual(publishCalls, 1);

  // ---------- a silent no-op is caught here too ----------
  reset(); silentNoop = true;
  await assert.rejects(() => updateOfferPrice('rt1', 'O123', 30), /still shows 19\.99/);

  // ---------- and the same read-after-write lag is tolerated here too ----------
  reset(); staleGetsLeft = 2;
  out = await updateOfferPrice('rt1', 'O123', 45);
  assert.strictEqual(out.live.price, 45);

  console.log('updateOfferQuantity / updateOfferPrice tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
