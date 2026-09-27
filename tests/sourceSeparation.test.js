// Amazon and CJdropshipping must never mix (the whole point of sourcePlatform): this runs one Amazon import and one CJ import
// for the SAME user and store side by side, then checks that neither wrote the other's fields, called the other's API, or was
// charged the other's credit key - and that "is this already imported" is checked per source, never cross-source.
// The real routes/fetchProduct.js (saveProductAsDraft) and services/cjImportService.js (saveCjProductAsDraft) run on top of
// the real models/listingsModel.js and models/importsModel.js; only the schemas (an in-memory stand-in), the image
// downloader and the CJ network calls are stand-ins.
const assert = require('assert');

const stub = (specifier, exports) => { const p = require.resolve(specifier); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

// ---------------- a minimal in-memory Listing/Import collection: only what upsertDraft/upsertCjDraft/findListingInStore/
// findCjListingInStore/createImport/createCjImport actually call (findOne, findOneAndUpdate, create) ----------------
function matches(doc, q) {
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined) continue;
    if (v === null) { if (doc[k] !== null && doc[k] !== undefined) return false; continue; }
    if (String(doc[k]) !== String(v)) return false;
  }
  return true;
}
function withToObject(doc) {
  Object.defineProperty(doc, 'toObject', { value: () => ({ ...doc }), enumerable: false, configurable: true });
  return doc;
}
function makeCollection() {
  const rows = [];
  let seq = 1;
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

// ---------------- credits: which key (a distinct sentinel per action, so a mix-up cannot hide behind two costs both being 1) was actually spent ----------------
const { ACTION_COSTS: REAL_COSTS } = require('../config/actionCosts');
stub('../config/actionCosts', { ACTION_COSTS: { ...REAL_COSTS, AMAZON_IMPORT: 3, CJ_IMPORT: 7 }, ACTION_COST_METADATA: [] });
const spends = [];
stub('../models/usersModel', {
  spendCredit: async (userId, amount) => { spends.push({ userId, amount }); return true; },
  refundCredit: async () => {},
  getPricingRule: async () => null,
});

// ---------------- the store both imports land in ----------------
const STORE = { id: 'acc1', marketplaceId: 'EBAY_US' };
stub('../models/ebayAccountsModel', { getActiveEbayAccount: async () => STORE, getEbayAccountRefreshToken: async () => null });

// ---------------- no real image downloads ----------------
stub('../services/imageStorageService', { materializeImageUrls: async ({ urls }) => (Array.isArray(urls) ? urls.slice(0, 5) : []) });

// ---------------- the CJ network: never called by the Amazon path, and the only thing the CJ path calls for product data ----------------
const cjCalls = [];
stub('../services/cjAdapter', {
  getProductDetail: async (userId, opts) => { cjCalls.push(['getProductDetail', userId, opts]); throw new Error('not used directly in this test'); },
  calcFreight: async (userId, opts) => { cjCalls.push(['calcFreight', userId, opts]); return { cost: 2.5, carrier: 'CJPacket', days: '7-12' }; },
});

const { saveProductAsDraft } = require('../routes/fetchProduct');
const { saveCjProductAsDraft } = require('../services/cjImportService');
const USER = 'user1';

const amazonProduct = { asin: 'B0TESTASIN', title: 'Amazon Widget', price: 20, currency: 'USD', images: ['https://img/a.jpg'], description: 'an Amazon product', bulletPoints: ['b1'], specifications: [], ebayAspects: { Brand: ['Acme'] } };
const cjProduct = { cjProductId: 'PID1', cjVariantId: 'VID1', variantSku: 'CJSKU-BLACK', title: 'CJ Widget', price: 9.5, currency: 'USD', images: ['https://img/c.jpg'], description: 'a CJ product', inventories: [{ countryCode: 'US', totalInventory: 40 }] };

(async () => {
  // ---------- run both side by side ----------
  const amazonResult = await saveProductAsDraft(USER, { ...amazonProduct }, 20, null, {}, STORE);
  const cjResult = await saveCjProductAsDraft(USER, { ...cjProduct }, 15, {}, STORE);

  // ---------- credits: each source charged its OWN key, never the other's ----------
  assert.deepStrictEqual(spends, [{ userId: USER, amount: 3 }, { userId: USER, amount: 7 }], 'Amazon charged AMAZON_IMPORT (3), CJ charged CJ_IMPORT (7) - never crossed or coincidentally equal');

  // ---------- the CJ API was called only by the CJ import, never by the Amazon one ----------
  assert.ok(cjCalls.length >= 1, 'the CJ import quoted freight');
  assert.ok(cjCalls.every((c) => c[0] === 'calcFreight'), 'only calcFreight was used (the freight quote), never getProductDetail - saveCjProductAsDraft is handed an already-fetched product, exactly like saveProductAsDraft');

  // ---------- the two listings never share a field ----------
  const amazonDraft = Listing.rows.find((r) => r._id === amazonResult.draft.id);
  const cjDraft = Listing.rows.find((r) => r._id === cjResult.draft.id);
  assert.strictEqual(amazonDraft.sourcePlatform, 'amazon');
  assert.strictEqual(amazonDraft.sku, 'B0TESTASIN');
  assert.strictEqual(amazonDraft.cjProductId, undefined, 'an Amazon listing never gets a cjProductId');
  assert.strictEqual(amazonDraft.cjVariantId, undefined);
  assert.strictEqual(amazonDraft.cjShippingCost, undefined, 'Amazon profit is never touched by CJ shipping');

  assert.strictEqual(cjDraft.sourcePlatform, 'cj');
  assert.strictEqual(cjDraft.sku, 'CJ-VID1', 'the sku is "CJ-" + the CJ variant id (never the supplier\'s own variant sku text) - can never collide with an Amazon ASIN sku');
  assert.strictEqual(cjDraft.cjProductId, 'PID1');
  assert.strictEqual(cjDraft.cjVariantId, 'VID1');
  assert.strictEqual(cjDraft.cjShippingCost, 2.5, "the CJ listing's own shipping cost, quoted by cjAdapter.calcFreight");

  const amazonImport = Import.rows.find((r) => r._id === amazonResult.importId);
  const cjImport = Import.rows.find((r) => r._id === cjResult.importId);
  assert.strictEqual(amazonImport.asin, 'B0TESTASIN');
  assert.strictEqual(amazonImport.cjProductId, undefined);
  assert.strictEqual(cjImport.asin, undefined, 'a CJ import never gets an asin');
  assert.strictEqual(cjImport.amazonUrl, undefined, 'a CJ import never gets an Amazon URL');
  assert.strictEqual(cjImport.cjProductId, 'PID1');

  // ---------- duplicate checks are per source: a same-store re-import of ONE source never blocks (or is blocked by) the other ----------
  const { findListingInStore, findCjListingInStore } = require('../models/listingsModel');
  assert.ok(await findListingInStore(USER, 'B0TESTASIN', STORE.id), 'the Amazon listing is found by its own asin/sku');
  assert.strictEqual(await findListingInStore(USER, 'PID1', STORE.id), null, "the CJ product's own id is never mistaken for an Amazon sku");
  assert.ok(await findCjListingInStore(USER, 'PID1', 'VID1', STORE.id), 'the CJ listing is found by its own cjProductId+cjVariantId');
  assert.strictEqual(await findCjListingInStore(USER, 'B0TESTASIN', 'B0TESTASIN', STORE.id), null, "an Amazon asin is never mistaken for a CJ product/variant id");

  // a second CJ import of the SAME product+variant is blocked, but re-importing a DIFFERENT Amazon ASIN is unaffected by it
  await assert.rejects(() => saveCjProductAsDraft(USER, { ...cjProduct }, 15, {}, STORE), (err) => err.statusCode === 409 && err.alreadyListed === true);
  const otherAmazon = { ...amazonProduct, asin: 'B0OTHERONE' };
  const secondAmazon = await saveProductAsDraft(USER, otherAmazon, 20, null, {}, STORE);
  assert.strictEqual(secondAmazon.draft.sku, 'B0OTHERONE', 'a different Amazon product imports fine - the CJ duplicate above never touched it');

  console.log('source separation tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
