// Live listings: what the seller changes in ELMS has to reach eBay, and what eBay holds afterwards has to be what ELMS shows.
// The real reviseActiveListing / fetchLiveListing run here against a small in-memory eBay (offers + inventory items), the way
// the Inventory API behaves: PUT replaces the whole object, GET returns it, and the offer's listingDescription wins over the item's.
const assert = require('assert');
const Module = require('module');
const sync = require('../services/liveListingSync');

// ---------------------------------------------------------------- pure helpers
const offer = { offerId: 'O1', sku: 'SKU1', marketplaceId: 'EBAY_GB', categoryId: '15052', availableQuantity: 3,
  pricingSummary: { price: { value: '19.99', currency: 'GBP' } }, listingDescription: '<p>Old description</p>',
  listingPolicies: { paymentPolicyId: 'P1', fulfillmentPolicyId: 'F1', returnPolicyId: 'R1' }, merchantLocationKey: 'LOC1', status: 'PUBLISHED', listing: { listingId: '1234567890' } };
const item = { condition: 'NEW', availability: { shipToLocationAvailability: { quantity: 3 } },
  product: { title: 'Old title', description: 'Old description', imageUrls: ['https://i/a.jpg', 'https://i/b.jpg'], aspects: { Brand: ['Nike'], Color: ['Black'], Material: ['Cotton'] }, brand: 'Nike', mpn: 'M-1' } };

const live = sync.normalizeLive(offer, item);
assert.strictEqual(live.title, 'Old title');
assert.strictEqual(live.description, '<p>Old description</p>', "the offer's listing description is what eBay shows");
assert.strictEqual(live.price, 19.99); assert.strictEqual(live.currency, 'GBP'); assert.strictEqual(live.quantity, 3);
assert.strictEqual(live.categoryId, '15052'); assert.strictEqual(live.policies.returnPolicyId, 'R1'); assert.strictEqual(live.merchantLocationKey, 'LOC1');
assert.deepStrictEqual(live.aspects.Brand, ['Nike']); assert.strictEqual(live.hasBrandField, true); assert.strictEqual(live.epid, null);
assert.deepStrictEqual(sync.normalizeLive(null, null).imageUrls, [], 'nothing to read: no crash');

// item specifics: the ones eBay holds stay, the sent ones replace theirs (any capitalisation), cleared ones go
assert.deepStrictEqual(sync.mergeAspects({ Brand: ['Nike'], Color: ['Black'], Material: ['Cotton'] }, { brand: ['Adidas'] }), { Color: ['Black'], Material: ['Cotton'], brand: ['Adidas'] });
assert.deepStrictEqual(sync.mergeAspects({ Brand: ['Nike'], Color: ['Black'] }, { Size: ['M'] }, ['color']), { Brand: ['Nike'], Size: ['M'] });
assert.deepStrictEqual(sync.mergeAspects(undefined, undefined), {});
assert.strictEqual(sync.firstValue({ brand: ['Adidas', 'x'] }, 'Brand'), 'Adidas');
assert.strictEqual(sync.firstValue({}, 'Brand'), null);
assert.deepStrictEqual(sync.aspectsForListing({ Brand: ['Nike'], Empty: [], Num: 5 }), { Brand: ['Nike'], Num: ['5'] });

// what eBay did not take
assert.deepStrictEqual(sync.compareLive({ title: 'Old title', price: 19.99, quantity: 3, categoryId: '15052', aspects: { brand: ['nike'] }, policies: { returnPolicyId: 'R1' }, merchantLocationKey: 'LOC1' }, live), [], 'everything kept: nothing reported');
let diff = sync.compareLive({ title: 'New title', price: 25, quantity: 5, categoryId: '999', aspects: { Brand: ['Adidas'], Color: ['Red'] }, clearAspects: ['Material'], imageCount: 4, policies: { paymentPolicyId: 'P9' }, merchantLocationKey: 'LOC9', description: '<b>New text</b>' }, live);
const fields = diff.map((d) => d.field).sort();
assert.deepStrictEqual(fields, ['aspect:Brand', 'aspect:Color', 'aspect:Material', 'category', 'description', 'images', 'location', 'policy:paymentPolicyId', 'price', 'quantity', 'title']);
const brand = diff.find((d) => d.field === 'aspect:Brand');
assert.strictEqual(brand.sent, 'Adidas'); assert.strictEqual(brand.ebay, 'Nike'); assert.ok(!/catalog/.test(brand.reason));
// a catalog-matched item keeps its own Brand: the reason says so
const catalog = sync.normalizeLive(offer, { ...item, product: { ...item.product, epid: '123456' } });
assert.ok(/catalog product/.test(sync.compareLive({ aspects: { Brand: ['Adidas'] } }, catalog)[0].reason));
assert.ok(!/catalog product/.test(sync.compareLive({ aspects: { Color: ['Red'] } }, catalog)[0].reason), 'only the product-defining ones');
assert.strictEqual(sync.compareLive({ title: 'x'.repeat(100) }, { ...live, title: 'x'.repeat(80) }).length, 0, 'eBay cuts the title at 80');
assert.deepStrictEqual(sync.compareLive({ title: 'a' }, null), []);

// ---------------------------------------------------------------- the service against an in-memory eBay
const clone = (o) => JSON.parse(JSON.stringify(o));
let ebay; let calls; let ignoreBrand = false;
function reset() { ebay = { offers: { O1: clone(offer) }, items: { SKU1: clone(item) } }; calls = []; ignoreBrand = false; }
const fakeAxios = async (cfg) => {
  const m = /\/sell\/inventory\/v1\/(offer|inventory_item)\/([^/?]+)/.exec(cfg.url);
  calls.push(cfg.method + ' ' + m[1]);
  const table = m[1] === 'offer' ? ebay.offers : ebay.items;
  const key = decodeURIComponent(m[2]);
  if (cfg.method === 'GET') return { data: clone(table[key]) };
  if (m[1] === 'inventory_item') {
    const next = clone(cfg.data);
    if (ignoreBrand) next.product.aspects.Brand = table[key].product.aspects.Brand; // catalog product: eBay keeps its own Brand
    table[key] = next;
  } else {
    table[key] = { offerId: key, ...clone(cfg.data), listing: table[key].listing, status: table[key].status };
  }
  return { data: undefined };
};
fakeAxios.post = fakeAxios;
const fakes = {
  axios: fakeAxios,
  './ebayAuthService': { getAccessToken: async () => 'token' },
  './currencyService': { convertAmount: async (amount, from, to) => ({ amount: Number((amount * 0.8).toFixed(2)), rate: 0.8, converted: from !== to }) },
};
const origLoad = Module._load;
Module._load = function (request, parent) {
  if (fakes[request] && parent && /ebayListingService\.js$/.test(parent.filename)) return fakes[request];
  return origLoad.apply(this, arguments);
};
const svc = require('../services/ebayListingService');
Module._load = origLoad;

(async () => {
  // ---- 1. the brand changes on eBay, everything else stays ----
  reset();
  let r = await svc.reviseActiveListing('rt', { offerId: 'O1', sku: 'SKU1', title: 'New title', aspects: { Brand: ['Adidas'] }, sellPrice: 19.99, quantity: 3 });
  let held = ebay.items.SKU1.product;
  assert.deepStrictEqual(held.aspects, { Brand: ['Adidas'], Color: ['Black'], Material: ['Cotton'] }, 'the other item specifics are kept, not wiped');
  assert.strictEqual(held.brand, 'Adidas', 'the brand product field follows the item specific');
  assert.strictEqual(held.mpn, 'M-1');
  assert.strictEqual(held.title, 'New title');
  assert.deepStrictEqual(held.imageUrls, ['https://i/a.jpg', 'https://i/b.jpg'], 'pictures not sent: untouched');
  assert.strictEqual(ebay.offers.O1.listingDescription, '<p>Old description</p>', 'description not sent: untouched');
  assert.strictEqual(r.live.aspects.Brand[0], 'Adidas', 'read back from eBay');
  assert.strictEqual(r.live.title, 'New title');
  assert.strictEqual(calls.filter((c) => c === 'GET offer').length, 2, 'offer read twice: before and after');
  assert.deepStrictEqual(sync.compareLive({ aspects: { Brand: ['Adidas'] }, title: 'New title' }, r.live), []);

  // ---- 2. the description reaches the listing (the offer's listingDescription is what buyers see) ----
  reset();
  r = await svc.reviseActiveListing('rt', { offerId: 'O1', sku: 'SKU1', description: '<p>Brand new text</p>', sellPrice: 19.99, quantity: 3 });
  assert.strictEqual(ebay.offers.O1.listingDescription, '<p>Brand new text</p>');
  assert.strictEqual(ebay.items.SKU1.product.description, '<p>Brand new text</p>');
  assert.strictEqual(r.live.description, '<p>Brand new text</p>');

  // ---- 3. clearing a specific, pictures, price, quantity, category ----
  reset();
  r = await svc.reviseActiveListing('rt', { offerId: 'O1', sku: 'SKU1', clearAspects: ['color'], images: ['https://i/c.jpg', 'ftp://bad', 'https://i/c.jpg'], sellPrice: 22.5, quantity: 7, categoryId: '999' });
  assert.deepStrictEqual(ebay.items.SKU1.product.aspects, { Brand: ['Nike'], Material: ['Cotton'] });
  assert.deepStrictEqual(ebay.items.SKU1.product.imageUrls, ['https://i/c.jpg'], 'valid, unique pictures only');
  assert.strictEqual(r.imageCount, 1);
  assert.strictEqual(ebay.offers.O1.pricingSummary.price.value, '22.50');
  assert.strictEqual(ebay.offers.O1.pricingSummary.price.currency, 'GBP');
  assert.strictEqual(ebay.offers.O1.availableQuantity, 7);
  assert.strictEqual(ebay.items.SKU1.availability.shipToLocationAvailability.quantity, 7);
  assert.strictEqual(ebay.offers.O1.categoryId, '999');
  assert.strictEqual(ebay.offers.O1.listingPolicies.paymentPolicyId, 'P1', 'policies untouched');

  // ---- 4. policies and item location ----
  reset();
  await svc.reviseActiveListing('rt', { offerId: 'O1', sku: 'SKU1', sellPrice: 19.99, quantity: 3, policies: { paymentPolicyId: 'P2', fulfillmentPolicyId: undefined, returnPolicyId: '' }, merchantLocationKey: 'elms-v2-gb-SW1A1AA' });
  assert.deepStrictEqual(ebay.offers.O1.listingPolicies, { paymentPolicyId: 'P2', fulfillmentPolicyId: 'F1', returnPolicyId: 'R1' }, 'only the chosen policy changes');
  assert.strictEqual(ebay.offers.O1.merchantLocationKey, 'elms-v2-gb-SW1A1AA');

  // ---- 5. a price in another currency is converted to the offer's currency ----
  reset();
  r = await svc.reviseActiveListing('rt', { offerId: 'O1', sku: 'SKU1', sellPrice: 25, priceCurrency: 'USD', quantity: 3 });
  assert.strictEqual(ebay.offers.O1.pricingSummary.price.value, '20.00', '25 USD at the stub rate 0.8');
  assert.strictEqual(r.pushedPrice, 20);
  reset();
  await svc.reviseActiveListing('rt', { offerId: 'O1', sku: 'SKU1', sellPrice: 25, priceCurrency: 'GBP', quantity: 3 });
  assert.strictEqual(ebay.offers.O1.pricingSummary.price.value, '25.00', 'same currency: as it is');

  // ---- 6. a catalog product keeps its own Brand: the read-back shows it, so it can be reported ----
  reset(); ignoreBrand = true; ebay.items.SKU1.product.epid = '777';
  r = await svc.reviseActiveListing('rt', { offerId: 'O1', sku: 'SKU1', aspects: { Brand: ['Adidas'], Color: ['Red'] }, sellPrice: 19.99, quantity: 3 });
  const notTaken = sync.compareLive({ aspects: { Brand: ['Adidas'], Color: ['Red'] } }, r.live);
  assert.deepStrictEqual(notTaken.map((d) => d.field), ['aspect:Brand']);
  assert.ok(/catalog/.test(notTaken[0].reason));
  assert.deepStrictEqual(r.live.aspects.Color, ['Red']);

  // clearing the Brand item specific takes the brand product field off too; MPN (not cleared, not an item specific here) stays
  reset();
  await svc.reviseActiveListing('rt', { offerId: 'O1', sku: 'SKU1', clearAspects: ['Brand'], sellPrice: 19.99, quantity: 3 });
  assert.ok(!('brand' in ebay.items.SKU1.product));
  assert.strictEqual(ebay.items.SKU1.product.mpn, 'M-1');

  // ---- 7. an item without the brand field does not get one added; validation ----
  reset(); delete ebay.items.SKU1.product.brand;
  await svc.reviseActiveListing('rt', { offerId: 'O1', sku: 'SKU1', aspects: { Brand: ['Adidas'] }, sellPrice: 19.99, quantity: 3 });
  assert.ok(!('brand' in ebay.items.SKU1.product));
  await assert.rejects(() => svc.reviseActiveListing('rt', { sku: 'SKU1', sellPrice: 1, quantity: 1 }), /offer ID/);
  await assert.rejects(() => svc.reviseActiveListing('rt', { offerId: 'O1', sellPrice: 1, quantity: 1 }), /SKU/);
  await assert.rejects(() => svc.reviseActiveListing('rt', { offerId: 'O1', sku: 'SKU1', sellPrice: 0, quantity: 1 }), /price/);
  await assert.rejects(() => svc.reviseActiveListing('rt', { offerId: 'O1', sku: 'SKU1', sellPrice: 1, quantity: 0 }), /quantity/);

  // ---- 8. fetchLiveListing ----
  reset();
  const l = await svc.fetchLiveListing('rt', { offerId: 'O1', sku: 'SKU1' });
  assert.strictEqual(l.title, 'Old title'); assert.strictEqual(l.listingId, '1234567890');
  await assert.rejects(() => svc.fetchLiveListing('rt', { offerId: 'O1' }), /SKU/);

  console.log('live listing sync tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
