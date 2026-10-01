// Which Amazon SITE a product was scraped from (UK, US, ...) is now stored once at import time (models/listingsModel.js
// upsertDraft -> sourceCountry), not just displayed as a badge re-derived from the URL on every read - so it can actually be
// filtered/queried (Drafts page, admin push-listings), and a UK-sourced import never gets silently treated as US or vice versa.
// The real routes/fetchProduct.js (saveProductAsDraft) runs on top of the real models/listingsModel.js; only the schemas (an
// in-memory stand-in, same shape as tests/sourceSeparation.test.js) and the image downloader are stand-ins.
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

stub('../models/usersModel', { spendCredit: async () => true, refundCredit: async () => {}, getPricingRule: async () => null });
const STORE = { id: 'acc1', marketplaceId: 'EBAY_GB' };
stub('../models/ebayAccountsModel', { getActiveEbayAccount: async () => STORE, getEbayAccountRefreshToken: async () => null });
stub('../services/imageStorageService', { materializeImageUrls: async ({ urls }) => urls || [] });

const { saveProductAsDraft } = require('../routes/fetchProduct');
const { supplierCountryFromUrl } = require('../models/listingsModel');
const USER = 'user1';
const product = (over = {}) => ({ asin: 'B0UKTEST01', title: 'Kettle', price: 20, currency: 'GBP', images: [], description: 'd', bulletPoints: [], specifications: [], ebayAspects: {}, ...over });

(async () => {
  // ---- supplierCountryFromUrl is a real, exported function (used directly by the db.js backfill migration) ----
  assert.strictEqual(supplierCountryFromUrl('https://www.amazon.co.uk/dp/B0X'), 'UK');
  assert.strictEqual(supplierCountryFromUrl('https://www.amazon.com/dp/B0X'), 'US');
  assert.strictEqual(supplierCountryFromUrl('https://www.amazon.de/dp/B0X'), 'DE');
  assert.strictEqual(supplierCountryFromUrl(null), null, 'no URL: unknown');
  assert.strictEqual(supplierCountryFromUrl('https://not-amazon.example/x'), null, 'not an Amazon URL: unknown');

  // ---- importing from a UK Amazon URL stores sourceCountry on the Listing ----
  let result = await saveProductAsDraft(USER, product({ asin: 'B0UKTEST01' }), 20, 'https://www.amazon.co.uk/dp/B0UKTEST01', {}, STORE);
  let draft = Listing.rows.find((r) => r._id === result.draft.id);
  assert.strictEqual(draft.sourceCountry, 'UK');

  // ---- a different ASIN imported from amazon.com instead gets 'US', never 'UK' by default/leakage ----
  result = await saveProductAsDraft(USER, product({ asin: 'B0USTEST01', currency: 'USD' }), 20, 'https://www.amazon.com/dp/B0USTEST01', {}, STORE);
  draft = Listing.rows.find((r) => r._id === result.draft.id);
  assert.strictEqual(draft.sourceCountry, 'US');

  // ---- re-fetching the SAME draft from a DIFFERENT Amazon site corrects sourceCountry (refreshed every fetch, like sku/importId - never seller-edited) ----
  result = await saveProductAsDraft(USER, product({ asin: 'B0UKTEST01' }), 20, 'https://www.amazon.de/dp/B0UKTEST01', {}, STORE);
  draft = Listing.rows.find((r) => r._id === result.draft.id);
  assert.strictEqual(draft.sourceCountry, 'DE', 'the same product, re-fetched from the German site, is now recorded as DE');

  // ---- no URL at all (e.g. an admin clone whose source Import never had one): sourceCountry is null, not a guess ----
  result = await saveProductAsDraft(USER, product({ asin: 'B0NOURL001' }), 20, null, {}, STORE);
  draft = Listing.rows.find((r) => r._id === result.draft.id);
  assert.strictEqual(draft.sourceCountry, null);

  console.log('source country tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
