// A draft made by a server-side import (website single / list, background list, the extension's bulk import) keeps ALL the product's pictures,
// not only the main one; drafts that were already made without a gallery show the pictures of the import they came from.
const assert = require('assert');
const path = require('path');
const Module = require('module');
process.env.EASYPARSER_API_KEY = 'test-key';
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

const GALLERY = ['https://m.media-amazon.com/images/I/A.jpg', 'https://m.media-amazon.com/images/I/B.jpg', 'https://m.media-amazon.com/images/I/C.jpg'];
const drafts = [];
stub('models/schemas/Settings', { findOne: () => { const p = Promise.resolve({ toObject: () => ({ key: 'global' }) }); p.lean = async () => ({ key: 'global' }); return p; }, create: async () => ({ toObject: () => ({}) }), findOneAndUpdate: async () => ({ toObject: () => ({}) }) });
stub('models/usersModel', { getPricingRule: async () => null, hasCredits: async () => true, spendCredit: async () => true, refundCredit: async () => {}, getUserById: async () => ({ id: 'u1', role: 'user', creditBalance: 10 }) });
stub('models/ebayAccountsModel', { listEbayAccounts: async () => [], getActiveEbayAccount: async () => ({ id: 'a'.repeat(24), label: 'UK', marketplaceId: 'EBAY_GB' }), getEbayAccountById: async () => null });
stub('models/listingsModel', { listListingsBySkus: async () => [], listListingsBySku: async () => [], findListingInStore: async () => null, upsertDraft: async (u, fields) => { drafts.push(fields); return { id: 'D1' }; } });
stub('models/importsModel', { createImport: async () => ({ id: 'IMP1' }), updateImportImages: async () => {} });
stub('services/imageStorageService', { materializeImageUrls: async ({ urls }) => urls });
stub('services/productCacheService', { getCachedProduct: async () => null, setCachedProduct: async () => {} });
const realCanopy = require('../services/canopyAmazonService');
stub('services/canopyAmazonService', { ...realCanopy, fetchProductByUrl: async (url) => ({ asin: realCanopy.extractAsinFromUrl(url), title: 'Widget', price: 8, currency: 'GBP', images: GALLERY, bulletPoints: [], specifications: [], sourceUrl: url }) });
stub('middleware/requireAuth', { requireAuth: (req, res, next) => next() });
stub('services/veroSettingsService', { getVeroWordsOf: async () => [] });

const fetchRoutes = require('../routes/fetchProduct');
const handler = (() => { const l = fetchRoutes.stack.find((x) => x.route && x.route.path === '/' && x.route.methods.post); return l.route.stack[l.route.stack.length - 1].handle; })();

(async () => {
  // ---------- a new server-side import saves the whole gallery on the draft ----------
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await handler({ userId: 'u1', body: { amazonUrl: 'https://www.amazon.co.uk/dp/B0IMAGES01', markupPercent: 20 }, headers: {}, protocol: 'https', get: () => 'x' }, res);
  assert.strictEqual(res.body.success, true, res.body.error);
  assert.deepStrictEqual(drafts[0].images, GALLERY, 'all three pictures, not only the main one');
  assert.strictEqual(drafts[0].mainImage, GALLERY[0]);

  // ---------- a draft made before this, with no gallery of its own, shows the import's pictures ----------
  const orig = Module._load;
  Module._load = function (request, parent) { if (request === './schemas/Listing' && parent && /listingsModel\.js/.test(parent.filename)) return {}; return orig.apply(this, arguments); };
  delete require.cache[require.resolve('../models/listingsModel')];
  const { withImportFallback } = require('../models/listingsModel');
  Module._load = orig;
  const importDoc = (images) => ({ importId: { product: { brand: 'Acme', images, variants: [] } } });

  let row = withImportFallback({ images: [], main_image: GALLERY[0] }, importDoc([...GALLERY, 'javascript:alert(1)', 'data:image/png;base64,AAA', null, 42]));
  assert.deepStrictEqual(row.images, GALLERY, 'the import gallery, real web links only');
  row = withImportFallback({ images: undefined }, importDoc(GALLERY));
  assert.deepStrictEqual(row.images, GALLERY, 'a draft with no images field at all');
  row = withImportFallback({ images: ['https://x/own.jpg'] }, importDoc(GALLERY));
  assert.deepStrictEqual(row.images, ['https://x/own.jpg'], 'a gallery the draft already has is never replaced');
  row = withImportFallback({ images: [] }, importDoc([]));
  assert.deepStrictEqual(row.images, [], 'an import with no pictures leaves it empty');
  row = withImportFallback({ images: [] }, { importId: null });
  assert.deepStrictEqual(row.images, [], 'no import: untouched');
  row = withImportFallback({ images: [] }, importDoc(Array.from({ length: 40 }, (_, i) => 'https://m.media-amazon.com/images/I/' + i + '.jpg')));
  assert.strictEqual(row.images.length, 24, 'at most 24, as everywhere else');

  console.log('draft images: all good');
})().catch((err) => { console.error(err); process.exit(1); });
