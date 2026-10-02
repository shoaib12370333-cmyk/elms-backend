// AliExpress shipping on the listing: an import quotes it (services/aliexpressImportService.js) and keeps it on the draft with what the
// quote said about delivery; a failed quote never blocks the import and is never stored as 0; the profit counts the source's OWN
// shipping (AliExpress's for an AliExpress listing, CJ's for a CJ one, none for Amazon); a refresh from the stock monitor goes through
// updateListing. The real service and the real models/listingsModel.js run; the schemas (in memory), the credit layer, the image
// downloader and the AliExpress network are stand-ins.
const assert = require('assert');

const stub = (specifier, exports) => { const p = require.resolve(specifier); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

function matches(doc, q) {
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined) continue;
    if (v === null) { if (doc[k] !== null && doc[k] !== undefined) return false; continue; }
    if (String(doc[k]) !== String(v)) return false;
  }
  return true;
}
const withToObject = (doc) => { Object.defineProperty(doc, 'toObject', { value: () => ({ ...doc }), enumerable: false, configurable: true }); return doc; };
function makeCollection() {
  const rows = []; let seq = 1;
  return {
    rows,
    findOne: async (q) => rows.find((d) => matches(d, q)) || null,
    findOneAndUpdate: async (filter, update, opts = {}) => {
      let doc = rows.find((d) => matches(d, filter));
      if (!doc && opts.upsert) { doc = withToObject({ _id: 'id' + (seq += 1) }); rows.push(doc); }
      if (doc) Object.assign(doc, update);
      return doc || null;
    },
    create: async (data) => { const doc = withToObject({ _id: 'id' + (seq += 1), createdAt: new Date(), ...data }); rows.push(doc); return doc; },
  };
}
const Listing = makeCollection();
const Import = makeCollection();
stub('../models/schemas/Listing', Listing);
stub('../models/schemas/Import', Import);
stub('../models/usersModel', { spendCredit: async () => true, refundCredit: async () => {}, getPricingRule: async () => null });
let store = { id: 'acc1', marketplaceId: 'EBAY_US' };
stub('../models/ebayAccountsModel', { getActiveEbayAccount: async () => store, getEbayAccountRefreshToken: async () => null });
stub('../services/imageStorageService', { materializeImageUrls: async ({ urls }) => (Array.isArray(urls) ? urls.slice(0, 5) : []) });

const quoteCalls = [];
let quoteBehaviour = async () => null;
stub('../services/aliexpressAdapter', { getProductDetail: async () => { throw new Error('not used in this test'); }, quoteShipping: async (userId, opts) => { quoteCalls.push({ userId, ...opts }); return quoteBehaviour(); } });

const M = require('../models/listingsModel');
const { saveAliexpressProductAsDraft } = require('../services/aliexpressImportService');
const USER = 'user1';
const product = (n, extra) => ({ aliexpressProductId: 'P' + n, aliexpressSkuId: 'S' + n, title: 'Widget ' + n, price: 10, currency: 'USD', images: ['https://img/a.jpg'], description: 'd', inventory: 5, ...extra });
const QUOTE = { cost: 2.4, currency: 'USD', free: false, carrier: 'AliExpress Standard Shipping', code: 'STD', minDays: 7, maxDays: 15, guaranteedDays: 60, shipFrom: 'CN', tracking: true, optionCount: 2 };

(async () => {
  // ---------- an import quotes the shipping for THIS sku into the store's country in the listing's currency, and keeps it with the delivery facts ----------
  quoteBehaviour = async () => QUOTE;
  store = { id: 'acc1', marketplaceId: 'EBAY_GB' };
  const r1 = await saveAliexpressProductAsDraft(USER, product(1), 20, null, store);
  assert.deepStrictEqual(quoteCalls, [{ userId: USER, productId: 'P1', skuId: 'S1', shipToCountry: 'GB', currency: 'USD' }]);
  assert.strictEqual(r1.aliexpressShipping.cost, 2.4, 'the import answer carries the quote');
  const row1 = Listing.rows.find((x) => x._id === r1.draft.id);
  assert.strictEqual(row1.aliexpressShippingCost, 2.4);
  assert.strictEqual(row1.aliexpressDelivery.carrier, 'AliExpress Standard Shipping');
  assert.strictEqual(row1.aliexpressDelivery.minDays, 7);
  assert.strictEqual(row1.aliexpressDelivery.maxDays, 15);
  assert.strictEqual(row1.aliexpressDelivery.shipFrom, 'CN');
  assert.strictEqual(row1.aliexpressDelivery.tracking, true);
  assert.ok(row1.aliexpressDelivery.quotedAt instanceof Date);
  assert.ok(!('optionCount' in row1.aliexpressDelivery) && !('code' in row1.aliexpressDelivery), 'only the delivery facts worth keeping');
  assert.strictEqual(row1.cjShippingCost, undefined, 'an AliExpress listing never gets CJ shipping');
  // ...and the serialized listing exposes it
  assert.strictEqual(r1.draft.aliexpress_shipping_cost, 2.4);
  assert.strictEqual(r1.draft.aliexpress_delivery.min_days, 7);
  assert.strictEqual(r1.draft.aliexpress_delivery.max_days, 15);
  assert.strictEqual(r1.draft.aliexpress_delivery.carrier, 'AliExpress Standard Shipping');
  assert.strictEqual(r1.draft.aliexpress_delivery.ship_from, 'CN');

  // ---------- free shipping is a real 0 ----------
  quoteBehaviour = async () => ({ ...QUOTE, cost: 0, free: true });
  const r2 = await saveAliexpressProductAsDraft(USER, product(2), 20, null, store);
  assert.strictEqual(Listing.rows.find((x) => x._id === r2.draft.id).aliexpressShippingCost, 0);
  assert.strictEqual(r2.draft.aliexpress_shipping_cost, 0, 'free shipping reads as 0, not as unknown');
  assert.strictEqual(r2.draft.aliexpress_delivery.free, true);

  // ---------- no usable quote: the import still works, and the cost is UNKNOWN (null), never 0 ----------
  quoteBehaviour = async () => null;
  const r3 = await saveAliexpressProductAsDraft(USER, product(3), 20, null, store);
  const row3 = Listing.rows.find((x) => x._id === r3.draft.id);
  assert.ok(row3, 'the draft was saved');
  assert.strictEqual(row3.aliexpressShippingCost, undefined, 'nothing written');
  assert.strictEqual(r3.draft.aliexpress_shipping_cost, null);
  assert.strictEqual(r3.draft.aliexpress_delivery, null);
  assert.strictEqual(r3.aliexpressShipping, null);

  // ---------- a quote that blows up never blocks the import either ----------
  quoteBehaviour = async () => { throw new Error('AliExpress down'); };
  const r4 = await saveAliexpressProductAsDraft(USER, product(4), 20, null, store);
  assert.ok(Listing.rows.find((x) => x._id === r4.draft.id));
  assert.strictEqual(r4.draft.aliexpress_shipping_cost, null);

  // ---------- a nonsense quote is not stored ----------
  for (const bad of [{ ...QUOTE, cost: -1 }, { ...QUOTE, cost: 'abc' }, { ...QUOTE, cost: null }, { ...QUOTE, cost: '' }]) assert.strictEqual(M.shippingFieldsFromQuote(bad), null, JSON.stringify(bad.cost));
  assert.strictEqual(M.shippingFieldsFromQuote(null), null);

  // ---------- the stock monitor's refresh goes through updateListing, replacing both fields; null clears them ----------
  const id = r1.draft.id;
  await M.updateListing(USER, id, { aliexpressShipping: { ...QUOTE, cost: 3.1, minDays: 9, maxDays: 20 } });
  assert.strictEqual(Listing.rows.find((x) => x._id === id).aliexpressShippingCost, 3.1);
  assert.strictEqual(Listing.rows.find((x) => x._id === id).aliexpressDelivery.maxDays, 20);
  await M.updateListing(USER, id, { aliexpressShipping: { cost: 'abc' } });
  assert.strictEqual(Listing.rows.find((x) => x._id === id).aliexpressShippingCost, 3.1, 'an unusable quote never wipes a good figure');
  await M.updateListing(USER, id, { aliexpressShipping: null });
  assert.strictEqual(Listing.rows.find((x) => x._id === id).aliexpressShippingCost, null, 'only an explicit null clears it');
  assert.strictEqual(Listing.rows.find((x) => x._id === id).aliexpressDelivery, null);

  // ---------- profit: each source counts ITS OWN shipping, never the other's ----------
  assert.strictEqual(M.sourceShippingCostOf({ sourcePlatform: 'aliexpress', aliexpressShippingCost: 2.4, cjShippingCost: 9 }), 2.4);
  assert.strictEqual(M.sourceShippingCostOf({ sourcePlatform: 'cj', aliexpressShippingCost: 2.4, cjShippingCost: 9 }), 9);
  assert.strictEqual(M.sourceShippingCostOf({ sourcePlatform: 'amazon', aliexpressShippingCost: 2.4 }), undefined, 'an Amazon listing has no source shipping');
  assert.strictEqual(M.listingProfitAmount(20, 10, null, 2.4), 7.6, 'sell - cost - shipping');
  assert.strictEqual(M.listingProfitAmount(20, 10, null, null), 10, 'unknown shipping is not subtracted');
  assert.strictEqual(M.listingProfitAmount(20, 10, null, 0), 10, 'free shipping: nothing to subtract');
  assert.strictEqual(M.listingProfitAmount(20, 10, null, undefined), 10, 'Amazon: exactly as before');

  // a REAL AliExpress quote replaces the delivery cost a Margin rule only guessed - the same shipping is never charged twice
  const rule = { feePercent: 10, feeFixed: 0, shipping: 3 };
  assert.strictEqual(M.hasQuotedShipping({ sourcePlatform: 'aliexpress', aliexpressShippingCost: 2.4 }), true);
  assert.strictEqual(M.hasQuotedShipping({ sourcePlatform: 'aliexpress', aliexpressShippingCost: 0 }), true, 'free shipping is a real quote too');
  assert.strictEqual(M.hasQuotedShipping({ sourcePlatform: 'aliexpress', aliexpressShippingCost: null }), false);
  assert.strictEqual(M.hasQuotedShipping({ sourcePlatform: 'cj', cjShippingCost: 2.4 }), false, 'CJ keeps its existing behaviour');
  assert.strictEqual(M.hasQuotedShipping({ sourcePlatform: 'amazon' }), false);
  assert.ok(Math.abs(M.listingProfitAmount(20, 10, rule, 2.4, true) - 5.6) < 1e-9, '20 - (10 + 2.4) - 10% fee: the rule\'s guessed 3 is NOT also taken off');
  assert.ok(Math.abs(M.listingProfitAmount(20, 10, rule, 2.4, false) - 2.6) < 1e-9, 'without a real quote the rule\'s own shipping still counts, exactly as before');
  assert.ok(Math.abs(M.listingProfitAmount(20, 10, rule, 0, true) - 8) < 1e-9, 'a free-shipping quote: nothing for shipping at all');
  assert.ok(Math.abs(M.listingProfitAmount(20, 10, rule) - 5) < 1e-9, 'Amazon with a rule: unchanged (3 shipping + 10% fee)');

  console.log('aliexpress shipping draft tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
