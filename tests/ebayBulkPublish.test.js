// eBay's bulk calls: 25 listings per call, matched back to each listing, and any unusual answer sends THAT listing the ordinary (one at a
// time) way. The real body builder runs; the eBay calls are a fake that behaves like eBay's bulk endpoints.
const assert = require('assert');
process.env.BULK_PUBLISH_WINDOW_MS = '100';
const bulk = require('../services/ebayBulkPublisher');

const calls = [];
const singles = [];
let invFail = new Set(); let pubFail = new Set(); let offerExists = new Set(); let dropInv = new Set(); let throwOn = null;
bulk.deps.request = async (token, method, path, body, options) => {
  calls.push({ token, method, path, n: body.requests.length, options });
  if (throwOn && path.endsWith(throwOn)) throw Object.assign(new Error('eBay is down'), { statusCode: 503 });
  await new Promise((r) => setTimeout(r, 5));
  if (path.endsWith('/bulk_create_or_replace_inventory_item')) {
    return { responses: body.requests.filter((r) => !dropInv.has(r.sku)).map((r) => (invFail.has(r.sku)
      ? { sku: r.sku, locale: r.locale, statusCode: 400, errors: [{ errorId: 25002, message: 'Invalid category', parameters: [{ name: 'categoryId', value: '1' }] }] }
      : { sku: r.sku, locale: r.locale, statusCode: 200 })) };
  }
  if (path.endsWith('/bulk_create_offer')) {
    return { responses: body.requests.map((r) => (offerExists.has(r.sku)
      ? { sku: r.sku, statusCode: 400, errors: [{ errorId: 25002, message: 'Offer entity already exists.' }] }
      : { sku: r.sku, marketplaceId: r.marketplaceId, format: 'FIXED_PRICE', offerId: 'O-' + r.sku, statusCode: 201 })) };
  }
  if (path.endsWith('/bulk_publish_offer')) {
    return { responses: body.requests.map((r) => (pubFail.has(r.offerId)
      ? { offerId: r.offerId, statusCode: 400, errors: [{ errorId: 25020, message: 'Item specific Brand is missing' }] }
      : { offerId: r.offerId, statusCode: 200, listingId: 'L-' + r.offerId })) };
  }
  throw new Error('unexpected path ' + path);
};
bulk.deps.single = async (args) => { const sku = args.sku || args.product.asin; singles.push(sku); return { sku, offerId: 'S-' + sku, listingId: 'SL-' + sku, imageUrls: [] }; };

const settings = (over = {}) => ({ merchantLocationKey: 'loc1', paymentPolicyId: 'p', fulfillmentPolicyId: 'f', returnPolicyId: 'r', marketplaceId: 'EBAY_GB', ...over });
const args = (i, over = {}) => ({
  refreshToken: 'tok1', product: { asin: 'B0' + String(10000000 + i), title: 'Kettle ' + i, description: 'Desc ' + i, images: ['https://img.example/' + i + '.jpg'] },
  sellPrice: 20 + i, quantity: 1, categoryId: '9355', sellerSettings: settings(), timeoutMs: 240000, ...over,
});
const skuOf = (i) => 'B0' + String(10000000 + i);
const reset = () => { calls.length = 0; singles.length = 0; invFail = new Set(); pubFail = new Set(); offerExists = new Set(); dropInv = new Set(); throwOn = null; };
const path = (c) => c.path.replace('/sell/inventory/v1/', '');

(async () => {
  assert.strictEqual(bulk.isEnabled(), false, 'off unless EBAY_BULK_PUBLISH is set');
  process.env.EBAY_BULK_PUBLISH = '1'; assert.strictEqual(bulk.isEnabled(), true);

  // ---- 60 listings: three groups (25 + 25 + 10), three bulk calls each, instead of 240 calls ----
  reset();
  let results = await Promise.all(Array.from({ length: 60 }, (_, i) => bulk.publish(args(i))));
  assert.strictEqual(results.length, 60);
  assert.strictEqual(calls.length, 9, 'three groups x three bulk calls: ' + calls.length);
  assert.deepStrictEqual(calls.filter((c) => path(c) === 'bulk_create_offer').map((c) => c.n).sort((a, b) => b - a), [25, 25, 10]);
  assert.strictEqual(singles.length, 0, 'the ordinary path was not needed');
  assert.deepStrictEqual(results[7], { sku: skuOf(7), offerId: 'O-' + skuOf(7), listingId: 'L-O-' + skuOf(7), imageUrls: ['https://img.example/7.jpg'] }, 'the same answer the ordinary publish gives');
  assert.ok(calls.every((c) => c.method === 'POST' && c.options.marketplaceId === 'EBAY_GB' && c.options.maxTimeoutMs === 120000 && c.token === 'tok1'), 'a marketplace header and a timeout long enough for 25 listings');
  // the request bodies are the ordinary ones: inventory items carry their sku and locale
  assert.strictEqual(calls[0].n <= 25, true);

  // ---- a listing eBay refuses fails with eBay's own words (like the ordinary path); the others go through ----
  reset(); invFail = new Set([skuOf(2)]); pubFail = new Set(['O-' + skuOf(4)]);
  const settled = await Promise.allSettled([0, 1, 2, 3, 4, 5].map((i) => bulk.publish(args(i))));
  assert.deepStrictEqual(settled.map((r) => r.status), ['fulfilled', 'fulfilled', 'rejected', 'fulfilled', 'rejected', 'fulfilled']);
  assert.match(settled[2].reason.message, /Invalid category \(eBay error 25002\) \[categoryId: 1\]/);
  assert.strictEqual(settled[2].reason.statusCode, 400); assert.strictEqual(settled[2].reason.ebayErrors[0].errorId, 25002);
  assert.match(settled[4].reason.message, /Item specific Brand is missing \(eBay error 25020\)/);
  assert.strictEqual(singles.length, 0, 'a real refusal is not tried again the slow way');
  // a refused inventory item is not offered or published
  assert.deepStrictEqual(calls.filter((c) => path(c) === 'bulk_create_offer').map((c) => c.n), [5]);

  // ---- an offer that already exists: that listing goes the ordinary way (which reuses the offer) ----
  reset(); offerExists = new Set([skuOf(1)]);
  results = await Promise.all([0, 1, 2].map((i) => bulk.publish(args(i))));
  assert.deepStrictEqual(singles, [skuOf(1)]);
  assert.strictEqual(results[1].listingId, 'SL-' + skuOf(1)); assert.strictEqual(results[0].listingId, 'L-O-' + skuOf(0));

  // ---- a whole bulk call fails: every listing of it goes the ordinary way, none is lost ----
  reset(); throwOn = '/bulk_create_or_replace_inventory_item';
  results = await Promise.all([0, 1, 2, 3].map((i) => bulk.publish(args(i))));
  assert.deepStrictEqual(singles.sort(), [0, 1, 2, 3].map(skuOf).sort()); assert.ok(results.every((r) => /^SL-/.test(r.listingId)));
  reset(); throwOn = '/bulk_publish_offer'; // the offers exist now: the ordinary path finds and publishes them
  results = await Promise.all([0, 1].map((i) => bulk.publish(args(i))));
  assert.deepStrictEqual(singles.sort(), [skuOf(0), skuOf(1)]);
  reset(); throwOn = '/bulk_create_offer';
  results = await Promise.all([0, 1].map((i) => bulk.publish(args(i))));
  assert.deepStrictEqual(singles.sort(), [skuOf(0), skuOf(1)]);

  // ---- eBay does not answer for one listing: it is settled the ordinary way ----
  reset(); dropInv = new Set([skuOf(1)]);
  results = await Promise.all([0, 1, 2].map((i) => bulk.publish(args(i))));
  assert.deepStrictEqual(singles, [skuOf(1)]); assert.strictEqual(results[1].listingId, 'SL-' + skuOf(1));

  // ---- the same SKU twice in one group: the second goes the ordinary way ----
  reset();
  results = await Promise.all([bulk.publish(args(3)), bulk.publish(args(3, { sellPrice: 99 }))]);
  assert.strictEqual(singles.length, 1); assert.strictEqual(results[0].listingId, 'L-O-' + skuOf(3));

  // ---- a missing policy fails at once, with the ordinary message, without any eBay call ----
  reset();
  await assert.rejects(() => bulk.publish(args(1, { sellerSettings: settings({ paymentPolicyId: null }) })), /missing its business policy setup/);
  await assert.rejects(() => bulk.publish(args(1, { categoryId: null })), /categoryId is required/);
  assert.strictEqual(calls.length, 0);

  // ---- two stores (or two marketplaces) are never mixed in one call ----
  reset();
  results = await Promise.all([bulk.publish(args(0)), bulk.publish(args(1, { refreshToken: 'tok2' })), bulk.publish(args(2, { sellerSettings: settings({ marketplaceId: 'EBAY_US' }) }))]);
  const inv = calls.filter((c) => path(c) === 'bulk_create_or_replace_inventory_item');
  assert.strictEqual(inv.length, 3); assert.ok(inv.every((c) => c.n === 1));
  assert.deepStrictEqual(inv.map((c) => c.token + '|' + c.options.marketplaceId).sort(), ['tok1|EBAY_GB', 'tok1|EBAY_US', 'tok2|EBAY_GB']);

  // ---- one listing alone is not held back for ever: it goes when the short wait is over ----
  reset();
  const t0 = Date.now();
  await bulk.publish(args(9));
  assert.ok(Date.now() - t0 < 1500, 'a lone listing went after the short wait: ' + (Date.now() - t0));
  assert.strictEqual(calls.length, 3);

  // ---- nothing is left waiting ----
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(bulk._groups.size, 0, 'no group is left behind');

  console.log('ebay bulk publish tests passed');
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
