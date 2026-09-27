// services/aliexpressImportService.js: extractAliexpressProductId (URL and bare-id forms), listSkus/normalizeAliexpressProduct
// (AliExpress's aliexpress.ds.product.get response shape, from the docs' own sample JSON), and the duplicate-in-this-store
// check in saveAliexpressProductAsDraft. Real service code runs; only the model/credit layers underneath are stand-ins.
const assert = require('assert');

const { extractAliexpressProductId, listSkus, normalizeAliexpressProduct, destCountryFor } = require('../services/aliexpressImportService');

// ---------- extractAliexpressProductId ----------
assert.strictEqual(extractAliexpressProductId('https://www.aliexpress.com/item/1005003784285827.html'), '1005003784285827');
assert.strictEqual(extractAliexpressProductId('  1005003784285827  '), '1005003784285827');
assert.strictEqual(extractAliexpressProductId('https://aliexpress.us/item/1005003784285827.html?spm=a2g0o'), '1005003784285827');
assert.strictEqual(extractAliexpressProductId('not a link'), null);
assert.strictEqual(extractAliexpressProductId(''), null);
assert.strictEqual(extractAliexpressProductId(null), null);

// ---------- destCountryFor: the eBay marketplace's own country, never guessed ----------
assert.strictEqual(destCountryFor('EBAY_GB'), 'GB');
assert.strictEqual(destCountryFor(undefined), 'US');

// ---------- listSkus / normalizeAliexpressProduct: the docs' own sample JSON response shape ----------
const DETAIL = {
  ae_item_sku_info_dtos: [{
    sku_id: '12000027158136202',
    offer_sale_price: '3.94',
    sku_price: '3.94',
    sku_available_stock: '57',
    currency_code: 'USD',
    ae_sku_property_dtos: [
      { sku_property_value: 'green', sku_image: 'https://ae04.alicdn.com/kf/Hba46.jpg', sku_property_name: 'Lenses Color', property_value_definition_name: 'Black Green', property_value_id: '175', sku_property_id: '73' },
    ],
  }],
  ae_multimedia_info_dto: { image_urls: 'https://ae04.alicdn.com/kf/H1.jpg;https://ae04.alicdn.com/kf/H2.jpg' },
  ae_item_base_info_dto: { product_id: '4000903675543', subject: 'FUQIAN Polarized Sunglasses', detail: '<div>Desc</div>', currency_code: 'CNY' },
  ae_item_properties: [{ attr_name: 'Brand Name', attr_value: 'FUQIAN' }],
};

const skus = listSkus(DETAIL);
assert.strictEqual(skus.length, 1);
assert.strictEqual(skus[0].skuId, '12000027158136202');
assert.strictEqual(skus[0].label, 'Black Green');
assert.strictEqual(skus[0].price, 3.94);
assert.strictEqual(skus[0].inventory, 57);

const product = normalizeAliexpressProduct(DETAIL, DETAIL.ae_item_sku_info_dtos[0]);
assert.strictEqual(product.aliexpressProductId, '4000903675543');
assert.strictEqual(product.aliexpressSkuId, '12000027158136202');
assert.strictEqual(product.title, 'FUQIAN Polarized Sunglasses - Black Green');
assert.strictEqual(product.price, 3.94);
assert.strictEqual(product.currency, 'USD', "the sku's own currency wins over the item's (CNY)");
assert.strictEqual(product.brand, 'FUQIAN');
assert.strictEqual(product.inventory, 57);
assert.deepStrictEqual(product.images, ['https://ae04.alicdn.com/kf/Hba46.jpg', 'https://ae04.alicdn.com/kf/H1.jpg', 'https://ae04.alicdn.com/kf/H2.jpg'], 'the sku image first, then the gallery, no duplicates');
assert.strictEqual(product.description, '<div>Desc</div>');

// a sku with no property (single-sku product - "sku_attr I got is empty" FAQ case): label is null, no sku_image to lead with
const soloSku = { sku_id: 'S1', offer_sale_price: '10', currency_code: 'USD' };
const soloProduct = normalizeAliexpressProduct({ ...DETAIL, ae_item_sku_info_dtos: [soloSku] }, soloSku);
assert.strictEqual(soloProduct.title, 'FUQIAN Polarized Sunglasses', 'no sku label to append when the sku has no properties');
assert.deepStrictEqual(soloProduct.images, ['https://ae04.alicdn.com/kf/H1.jpg', 'https://ae04.alicdn.com/kf/H2.jpg'], 'falls back to just the gallery');

console.log('aliexpress import service tests passed');
