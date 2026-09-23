// Package weight (for CALCULATED-shipping policies), leaf-category preflight and the scheduled publisher.
const assert = require('node:assert/strict');
const Module = require('module');
const { extractPackageInfo, toEbayPackageWeightAndSize, parseWeight, parseDimensions } = require('../services/packageInfoService');

// ---- parsing Amazon spec text ----
assert.deepEqual(parseWeight('1.2 pounds'), { value: 1.2, unit: 'POUND' });
assert.deepEqual(parseWeight('9.6 Ounces'), { value: 9.6, unit: 'OUNCE' });
assert.deepEqual(parseWeight('590 g'), { value: 590, unit: 'GRAM' });
assert.deepEqual(parseWeight('1,250 grams'), { value: 1250, unit: 'GRAM' });
assert.deepEqual(parseWeight('2 kg'), { value: 2, unit: 'KILOGRAM' });
assert.equal(parseWeight('3 gallons'), null, '"g" inside a word is not grams');
assert.deepEqual(parseDimensions('8.5 x 6 x 3 inches'), { length: 8.5, width: 6, height: 3, unit: 'INCH' });
assert.deepEqual(parseDimensions('20 x 10 x 5 cm'), { length: 20, width: 10, height: 5, unit: 'CENTIMETER' });
assert.equal(parseDimensions('8 x 6 x 3'), null, 'no unit -> not guessed');

// Package weight beats item weight; weight after ";" in Package Dimensions is read.
let info = extractPackageInfo([{ name: 'Item Weight', value: '1 pounds' }, { name: 'Package Weight', value: '1.4 pounds' }]);
assert.deepEqual(info.weight, { value: 1.4, unit: 'POUND' });
info = extractPackageInfo([{ name: 'Package Dimensions', value: '7.9 x 5.4 x 2.5 inches; 12 Ounces' }]);
assert.deepEqual(info.weight, { value: 12, unit: 'OUNCE' });
assert.deepEqual(info.dimensions, { length: 7.9, width: 5.4, height: 2.5, unit: 'INCH' });
assert.deepEqual(toEbayPackageWeightAndSize(info), { weight: { value: 12, unit: 'OUNCE' }, dimensions: { length: 7.9, width: 5.4, height: 2.5, unit: 'INCH' } });
assert.equal(toEbayPackageWeightAndSize(extractPackageInfo([{ name: 'Color', value: 'Black' }])), null);
assert.equal(toEbayPackageWeightAndSize(extractPackageInfo(undefined)), null);

// ---- publishListing sends packageWeightAndSize in the inventory item ----
const calls = [];
const fakeAxios = async (cfg) => {
  calls.push(cfg);
  const url = cfg.url;
  if (cfg.method === 'GET' && /\/offer\?/.test(url)) return { data: { offers: [] } };
  if (cfg.method === 'POST' && /\/offer$/.test(url)) return { data: { offerId: 'o1' } };
  if (/\/publish$/.test(url)) return { data: { listingId: 'L1' } };
  return { data: {} };
};
fakeAxios.post = async () => ({ data: {} });
const origLoad = Module._load;
Module._load = function (request, parent) {
  if (parent && /ebayListingService\.js/.test(parent.filename)) {
    if (request === 'axios') return fakeAxios;
    if (request === './ebayAuthService') return { getAccessToken: async () => 'token' };
  }
  return origLoad.apply(this, arguments);
};
const { publishListing } = require('../services/ebayListingService');
Module._load = origLoad;

(async () => {
  const settings = { merchantLocationKey: 'loc', paymentPolicyId: 'p', fulfillmentPolicyId: 'f', returnPolicyId: 'r', marketplaceId: 'EBAY_US' };
  const product = { asin: 'B000000001', title: 'Test product title', images: ['https://x.example/a.jpg'] };
  const weight = { weight: { value: 12, unit: 'OUNCE' } };
  await publishListing({ refreshToken: 'rt', product, sellPrice: 20, quantity: 1, categoryId: '9355', sku: 'AMZ-B000000001', sellerSettings: settings, packageWeightAndSize: weight });
  const put = calls.find((c) => c.method === 'PUT' && /inventory_item/.test(c.url));
  assert.deepEqual(put.data.packageWeightAndSize, weight);

  calls.length = 0;
  await publishListing({ refreshToken: 'rt', product, sellPrice: 20, quantity: 1, categoryId: '9355', sku: 'AMZ-B000000001', sellerSettings: settings });
  const put2 = calls.find((c) => c.method === 'PUT' && /inventory_item/.test(c.url));
  assert.ok(!('packageWeightAndSize' in put2.data), 'not sent when unknown');

  // ---- leaf-category preflight ----
  let info2 = { isLeaf: true, name: 'Cell Phones', childNames: [] };
  const taxonomyFake = { getCategoryInfo: async () => { if (info2 instanceof Error) throw info2; return info2; }, getItemAspectsForCategory: async () => ({ aspects: [] }) };
  Module._load = function (request, parent) {
    if (parent && /publishPreflightService\.js/.test(parent.filename) && request === './ebayTaxonomyService') return taxonomyFake;
    return origLoad.apply(this, arguments);
  };
  const { assertUsableCategory } = require('../services/publishPreflightService');
  await assertUsableCategory({ categoryId: '9355', marketplaceId: 'EBAY_US' });
  info2 = { isLeaf: false, name: 'Cell Phones & Accessories', childNames: ['Cases', 'Chargers'] };
  await assert.rejects(() => assertUsableCategory({ categoryId: '15032', marketplaceId: 'EBAY_US' }), /too general.*Cases, Chargers/);
  info2 = Object.assign(new Error('nope'), { statusCode: 404 });
  await assert.rejects(() => assertUsableCategory({ categoryId: '1', marketplaceId: 'EBAY_US' }), /does not recognise category 1/);
  info2 = Object.assign(new Error('timeout'), { statusCode: 500 });
  await assertUsableCategory({ categoryId: '9355', marketplaceId: 'EBAY_US' }); // unreachable taxonomy never blocks

  // ---- scheduled publisher hands due listings to the normal pipeline ----
  const processed = [];
  const errors = [];
  const dueSnake = { id: 'l1', userId: 'u1', sku: 'S1', ebay_account_id: 'a1', status: 'scheduled' };
  Module._load = function (request, parent) {
    if (parent && /scheduledPublisher\.js/.test(parent.filename)) {
      if (request === '../services/publishQueueService') return { processOneQueuedListing: async (l) => { processed.push(l); } };
      if (request === '../models/listingsModel') return {
        listScheduledDue: async () => [dueSnake, { ...dueSnake, id: 'l2' }],
        claimScheduledForPublishing: async (u, id) => (id === 'l1' ? { ...dueSnake, status: 'publishing' } : null),
        markError: async (...a) => { errors.push(a); },
      };
      if (request === '../services/jobLockService') return { acquireLock: async () => true };
    }
    return origLoad.apply(this, arguments);
  };
  const { runScheduledPublish } = require('../jobs/scheduledPublisher');
  Module._load = origLoad;
  await runScheduledPublish();
  assert.equal(processed.length, 1, 'only the listing this run actually claimed is published');
  assert.equal(processed[0].id, 'l1');
  assert.equal(errors.length, 0, 'no bogus "no eBay account" error (old camelCase bug)');

  console.log('package + category + scheduler tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
