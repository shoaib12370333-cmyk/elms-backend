// An AliExpress listing's sku ("AE-" + its own AliExpress sku id - never the supplier's own sku_code/barcode text) follows the
// same rule cjSkuFor already does (tests/cjSkuPublish.test.js), and publishes through the same generic finalizeEbaySku path
// (services/ebayListingService.js buildListingBodies) - never forced through the Amazon-only ASIN check.
const assert = require('assert');
const { buildListingBodies } = require('../services/ebayListingService');
const { aliSkuFor, finalizeEbaySku, cjSkuFor, requireAsinSku, MAX_EBAY_SKU } = require('../services/skuService');

const SETTINGS = { merchantLocationKey: 'l', paymentPolicyId: 'p', fulfillmentPolicyId: 'f', returnPolicyId: 'r', marketplaceId: 'EBAY_US' };
const product = { title: 'Polarized Sunglasses', description: 'Desc', images: ['https://img.example/1.jpg'] };
const SKU_ID = '12000027158136202'; // a real AliExpress sku_id's shape

// ---------- aliSkuFor: built from the AliExpress sku id, capped at eBay's limit from creation ----------
assert.strictEqual(aliSkuFor(SKU_ID), 'AE-' + SKU_ID);
assert.throws(() => aliSkuFor(''), /AliExpress sku id is required/);
assert.throws(() => aliSkuFor(null), /AliExpress sku id is required/);
const longSkuId = '9'.repeat(80); // defensive only - a real AliExpress sku_id is never this long
assert.strictEqual(aliSkuFor(longSkuId).length, MAX_EBAY_SKU, 'never longer than eBay allows, even for an unrealistically long id');
assert.ok(aliSkuFor(longSkuId).startsWith('AE-999'), 'still starts with the "AE-" prefix (the sku is cut at the end, not the start)');

// ---------- an AliExpress sku never collides with a CJ or Amazon sku's prefix ----------
assert.notStrictEqual(aliSkuFor(SKU_ID), cjSkuFor(SKU_ID), 'the "AE-" and "CJ-" prefixes keep the two sources apart even for the same raw id');
assert.throws(() => requireAsinSku(aliSkuFor(SKU_ID)), /Invalid Amazon ASIN/, 'an AliExpress sku is never mistaken for an Amazon ASIN');

// ---------- publishing: an AliExpress sku is sent to eBay as it is - never run through the Amazon-only ASIN check ----------
const aliSku = aliSkuFor(SKU_ID);
const aliBodies = buildListingBodies({ product, sellPrice: 14.99, quantity: 5, categoryId: '9355', sellerSettings: SETTINGS, sku: aliSku });
assert.strictEqual(aliBodies.finalSku, aliSku);
assert.strictEqual(aliBodies.offerBody.sku, aliSku);

// a sku long enough to have needed truncating still publishes (capped, not thrown)
const longAliBodies = buildListingBodies({ product, sellPrice: 14.99, quantity: 1, categoryId: '9355', sellerSettings: SETTINGS, sku: aliSkuFor(longSkuId) });
assert.strictEqual(longAliBodies.finalSku.length, MAX_EBAY_SKU);

assert.strictEqual(finalizeEbaySku(aliSku), aliSku);

console.log('aliexpress sku publish tests passed');
