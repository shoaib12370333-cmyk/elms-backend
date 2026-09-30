// Checks getCachedProduct: a hit within the admin-set window is reused, a hit past it is
// treated as a miss (even though the row itself may still exist until the DB's own cleanup
// backstop removes it - see models/schemas/ProductCache.js). Also checks that a product with
// no images is never cached, and an already-cached one is treated as a miss (self-healing).
const assert = require('assert');
const Module = require('module');

let stored = null;
let limits = { productCacheDays: 7 };
let upserted = null;

const fakes = {
  '../models/schemas/ProductCache': {
    findOne: (q) => ({ lean: async () => (stored && stored.asin === q.asin && stored.domain === q.domain ? stored : null) }),
    findOneAndUpdate: async (k, update) => { upserted = { ...k, ...update }; return upserted; },
  },
  '../models/settingsModel': { getLimits: async () => limits },
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (fakes[request] && parent && /productCacheService/.test(parent.filename)) return fakes[request];
  return origLoad.apply(this, arguments);
};
const { getCachedProduct, setCachedProduct } = require('../services/productCacheService');
Module._load = origLoad;

const WIDGET = { title: 'Widget', images: ['https://example.com/widget.jpg'] };

(async () => {
  assert.strictEqual(await getCachedProduct('B1', 'US'), null, 'no row -> miss');

  stored = { asin: 'B1', domain: 'us', product: WIDGET, fetchedAt: new Date() };
  assert.deepStrictEqual(await getCachedProduct('b1', 'US'), WIDGET, 'case-insensitive hit, fresh row');

  stored.fetchedAt = new Date(Date.now() - 6.9 * 24 * 60 * 60 * 1000);
  assert.deepStrictEqual(await getCachedProduct('B1', 'US'), WIDGET, 'still within the 7-day window');

  stored.fetchedAt = new Date(Date.now() - 7.1 * 24 * 60 * 60 * 1000);
  assert.strictEqual(await getCachedProduct('B1', 'US'), null, 'past the 7-day window -> treated as a miss');

  // an admin who raised the window to 30 days keeps the same (now-stale-by-7-day-standards) row usable
  limits = { productCacheDays: 30 };
  assert.deepStrictEqual(await getCachedProduct('B1', 'US'), WIDGET, 'admin raised the window to 30 days');

  // a product with no images is never written to the cache - a bad/incomplete provider answer must never poison
  // every later import of the same ASIN for the rest of the cache window.
  upserted = null;
  await setCachedProduct('B2', 'US', { title: 'No Photos' }, 'canopy');
  assert.strictEqual(upserted, null, 'a product with no images at all is not cached');
  await setCachedProduct('B2', 'US', { title: 'No Photos', images: [] }, 'canopy');
  assert.strictEqual(upserted, null, 'a product with an empty images array is not cached either');
  await setCachedProduct('B2', 'US', WIDGET, 'canopy');
  assert.ok(upserted, 'a product with at least one image is cached normally');

  // an entry that somehow ended up in the cache with no images (written before this guard existed, say) is
  // treated as a miss too, so the very next import retries the provider instead of repeating the same gap forever.
  stored = { asin: 'B3', domain: 'us', product: { title: 'No Photos', images: [] }, fetchedAt: new Date() };
  assert.strictEqual(await getCachedProduct('B3', 'US'), null, 'an already-cached image-less product self-heals to a miss');

  console.log('product cache tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
