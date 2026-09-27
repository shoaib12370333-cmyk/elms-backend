// A CJ listing's sku ("CJ-" + its own CJ variant id, e.g. "D4057F56-3F09-4541-8461-9D76D014846D" - never the supplier's own
// variant sku text, which can be any length or shape) used to be forced through requireAsinSku when publishing (services/
// ebayListingService.js buildListingBodies), which only accepts a 10-character Amazon ASIN - so every CJ publish failed.
// It is now sent to eBay as it is (services/skuService.js finalizeEbaySku), capped at eBay's own 50-character sku limit as a
// last-mile safety net; Amazon publishing (no sku given, falls back to product.asin) is unchanged.
const assert = require('assert');
const { buildListingBodies } = require('../services/ebayListingService');
const { cjSkuFor, finalizeEbaySku, requireAsinSku, MAX_EBAY_SKU } = require('../services/skuService');

const SETTINGS = { merchantLocationKey: 'l', paymentPolicyId: 'p', fulfillmentPolicyId: 'f', returnPolicyId: 'r', marketplaceId: 'EBAY_US' };
const product = { title: 'Cat Ear Hoody', description: 'Desc', images: ['https://img.example/1.jpg'] };
const VID = 'D4057F56-3F09-4541-8461-9D76D014846D'; // a real CJ variant id's shape

// ---------- cjSkuFor: built from the CJ variant id, capped at eBay's limit from creation - a draft's sku never changes shape later ----------
assert.strictEqual(cjSkuFor(VID), 'CJ-' + VID);
assert.throws(() => cjSkuFor(''), /CJ variant id is required/); assert.throws(() => cjSkuFor(null), /CJ variant id is required/);
const longVid = 'X'.repeat(80); // defensive only - a real CJ variant id is never this long
assert.strictEqual(cjSkuFor(longVid).length, MAX_EBAY_SKU, 'never longer than eBay allows, even for an unrealistically long id');
assert.ok(cjSkuFor(longVid).startsWith('CJ-XXX'), 'still starts with the "CJ-" prefix (the sku is cut at the end, not the start)');

// ---------- finalizeEbaySku: the last-mile safety net at publish time ----------
assert.strictEqual(finalizeEbaySku('CJ-' + VID), 'CJ-' + VID);
assert.strictEqual(finalizeEbaySku('  CJ-x  '), 'CJ-x', 'trimmed');
assert.strictEqual(finalizeEbaySku('Y'.repeat(80)).length, MAX_EBAY_SKU);
assert.throws(() => finalizeEbaySku(''), /eBay SKU is required/);
assert.throws(() => finalizeEbaySku(null), /eBay SKU is required/);

// ---------- publishing: a CJ sku is sent to eBay as it is - never run through the Amazon-only ASIN check ----------
const cjSku = cjSkuFor(VID);
const cjBodies = buildListingBodies({ product, sellPrice: 9.99, quantity: 3, categoryId: '9355', sellerSettings: SETTINGS, sku: cjSku });
assert.strictEqual(cjBodies.finalSku, cjSku);
assert.strictEqual(cjBodies.offerBody.sku, cjSku);

// a CJ sku long enough to have needed truncating still publishes (capped, not thrown)
const longCjBodies = buildListingBodies({ product, sellPrice: 9.99, quantity: 1, categoryId: '9355', sellerSettings: SETTINGS, sku: cjSkuFor(longVid) });
assert.strictEqual(longCjBodies.finalSku.length, MAX_EBAY_SKU);

// ---------- Amazon publishing: unchanged - a 10-character ASIN sku publishes as it always did, and an invalid one is still refused ----------
const amazonBodies = buildListingBodies({ product: { ...product, asin: 'B0ABC12345' }, sellPrice: 20, quantity: 1, categoryId: '9355', sellerSettings: SETTINGS, sku: 'B0ABC12345' });
assert.strictEqual(amazonBodies.finalSku, 'B0ABC12345');
// no sku passed at all (an older caller): still falls back to the Amazon ASIN, exactly as before
const fallbackBodies = buildListingBodies({ product: { ...product, asin: 'B0ABC12345' }, sellPrice: 20, quantity: 1, categoryId: '9355', sellerSettings: SETTINGS });
assert.strictEqual(fallbackBodies.finalSku, 'B0ABC12345');
assert.throws(() => requireAsinSku(cjSku), /Invalid Amazon ASIN/, 'requireAsinSku itself is untouched: a CJ sku is still never mistaken for an Amazon ASIN');
assert.throws(() => buildListingBodies({ product: { ...product, asin: '' }, sellPrice: 20, quantity: 1, categoryId: '9355', sellerSettings: SETTINGS }), /Amazon ASIN is required/, 'no sku and no asin: still refused, as before');

console.log('cj sku publish tests passed');
