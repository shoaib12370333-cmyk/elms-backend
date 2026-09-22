// Checks getCachedProduct: a hit within the admin-set window is reused, a hit past it is
// treated as a miss (even though the row itself may still exist until the DB's own cleanup
// backstop removes it - see models/schemas/ProductCache.js).
const assert = require('assert');
const Module = require('module');

let stored = null;
let limits = { productCacheDays: 7 };

const fakes = {
  '../models/schemas/ProductCache': {
    findOne: (q) => ({ lean: async () => (stored && stored.asin === q.asin && stored.domain === q.domain ? stored : null) }),
  },
  '../models/settingsModel': { getLimits: async () => limits },
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (fakes[request] && parent && /productCacheService/.test(parent.filename)) return fakes[request];
  return origLoad.apply(this, arguments);
};
const { getCachedProduct } = require('../services/productCacheService');
Module._load = origLoad;

(async () => {
  assert.strictEqual(await getCachedProduct('B1', 'US'), null, 'no row -> miss');

  stored = { asin: 'B1', domain: 'us', product: { title: 'Widget' }, fetchedAt: new Date() };
  assert.deepStrictEqual(await getCachedProduct('b1', 'US'), { title: 'Widget' }, 'case-insensitive hit, fresh row');

  stored.fetchedAt = new Date(Date.now() - 6.9 * 24 * 60 * 60 * 1000);
  assert.deepStrictEqual(await getCachedProduct('B1', 'US'), { title: 'Widget' }, 'still within the 7-day window');

  stored.fetchedAt = new Date(Date.now() - 7.1 * 24 * 60 * 60 * 1000);
  assert.strictEqual(await getCachedProduct('B1', 'US'), null, 'past the 7-day window -> treated as a miss');

  // an admin who raised the window to 30 days keeps the same (now-stale-by-7-day-standards) row usable
  limits = { productCacheDays: 30 };
  assert.deepStrictEqual(await getCachedProduct('B1', 'US'), { title: 'Widget' }, 'admin raised the window to 30 days');

  console.log('product cache tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
