// services/ebayListingService.js verifyOfferPrice: the check behind the bulk price call. eBay's answer to bulk_update_price_quantity is not believed on its
// word alone; the offer is read back (one GET) and must be PUBLISHED and show the price. eBay's read-after-write lag is waited out, a price that never
// shows is "false" (the caller then sets it the ordinary way), and a failing read throws (the caller treats that as "not verified").
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

stub('services/ebayAuthService', { getAccessToken: async (rt) => 'AT-' + rt });

const calls = [];
let answers = []; // what the next GETs answer, in order; the last one repeats
let failGet = false;
const axiosPath = require.resolve('axios');
require.cache[axiosPath] = {
  id: axiosPath, filename: axiosPath, loaded: true,
  exports: async (config) => {
    calls.push({ method: config.method, url: config.url, auth: config.headers.Authorization, marketplace: config.headers['X-EBAY-C-MARKETPLACE-ID'] });
    if (failGet) throw { response: { status: 500, data: { errors: [{ errorId: 25001, message: 'System error.' }] } } };
    const a = answers.length > 1 ? answers.shift() : answers[0];
    return { data: a };
  },
};

const { verifyOfferPrice, VERIFY_RETRY } = require('../services/ebayListingService');
VERIFY_RETRY.delayMs = 1; // do not really wait 1.5 s per retry in a test

const offer = (value, status = 'PUBLISHED') => ({ offerId: 'O1', sku: 'S1', status, pricingSummary: { price: { value, currency: 'GBP' } } });
const reset = () => { calls.length = 0; failGet = false; answers = [offer('12.50')]; };

(async () => {
  // ---------- the price shows at once: one read, true ----------
  reset();
  assert.strictEqual(await verifyOfferPrice('rt1', 'O1', 12.5, { marketplaceId: 'EBAY_GB' }), true);
  assert.strictEqual(calls.length, 1, 'one GET: the offer only, not the inventory item');
  assert.strictEqual(calls[0].method, 'GET'); assert.ok(calls[0].url.endsWith('/sell/inventory/v1/offer/O1'));
  assert.strictEqual(calls[0].auth, 'Bearer AT-rt1'); assert.strictEqual(calls[0].marketplace, 'EBAY_GB');

  // ---------- the price is a text with cents, compared as money (half a cent of slack) ----------
  reset(); answers = [offer('12.499')];
  assert.strictEqual(await verifyOfferPrice('rt1', 'O1', 12.5), true);
  reset(); answers = [offer('12.51')];
  assert.strictEqual(await verifyOfferPrice('rt1', 'O1', 12.5), false, 'a cent off is a different price');

  // ---------- eBay's read lag: the first reads still show the old price, a later one the new: true, and it stops reading once it has seen it ----------
  reset(); answers = [offer('9.99'), offer('9.99'), offer('12.50')];
  assert.strictEqual(await verifyOfferPrice('rt1', 'O1', 12.5), true);
  assert.strictEqual(calls.length, 3);

  // ---------- the price never shows: false after the attempts, not an error ----------
  reset(); answers = [offer('9.99')];
  assert.strictEqual(await verifyOfferPrice('rt1', 'O1', 12.5), false);
  assert.strictEqual(calls.length, VERIFY_RETRY.attempts, 'exactly the attempts that are allowed');

  // ---------- the offer is not PUBLISHED: a price there never reaches the live listing, so it is not "taken" even when it shows ----------
  reset(); answers = [offer('12.50', 'UNPUBLISHED')];
  assert.strictEqual(await verifyOfferPrice('rt1', 'O1', 12.5), false);
  assert.strictEqual(calls.length, 1, 'waiting does not publish an offer: one read, not all the attempts');
  reset(); answers = [offer('12.50', 'UNPUBLISHED'), offer('12.50', 'PUBLISHED')];
  assert.strictEqual(await verifyOfferPrice('rt1', 'O1', 12.5), false, 'a later PUBLISHED is not waited for either (the ordinary path republishes and checks)');
  reset(); answers = [{ offerId: 'O1', sku: 'S1', pricingSummary: { price: { value: '12.50' } } }];
  assert.strictEqual(await verifyOfferPrice('rt1', 'O1', 12.5), true, 'no status in the answer: as updateOfferPrice, not a reason to refuse');

  // ---------- an answer with no price, or no offer at all ----------
  reset(); answers = [{ offerId: 'O1', status: 'PUBLISHED' }];
  assert.strictEqual(await verifyOfferPrice('rt1', 'O1', 12.5), false);
  reset(); answers = [null];
  assert.strictEqual(await verifyOfferPrice('rt1', 'O1', 12.5), false);

  // ---------- a failing read throws (the bulk price service takes that as "not verified"); no offer id never reaches eBay ----------
  reset(); failGet = true;
  await assert.rejects(() => verifyOfferPrice('rt1', 'O1', 12.5), /System error/);
  reset();
  assert.strictEqual(await verifyOfferPrice('rt1', '', 12.5), false);
  assert.strictEqual(calls.length, 0);

  console.log('verifyOfferPrice tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
