// fulfillmentPolicyUsesCalculatedShipping's in-memory cache is keyed by marketplace+policy id - bounded in practice (a
// seller has only a handful of fulfillment policies), but never evicts on its own either, so it's capped the same way
// as the other in-memory caches. This only checks the cap, not the shipping-cost-type logic (covered elsewhere).
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

stub('services/ebayAuthService', { getAccessToken: async () => 'AT' });
const axiosPath = require.resolve('axios');
require.cache[axiosPath] = { id: axiosPath, filename: axiosPath, loaded: true, exports: async () => ({ data: { shippingOptions: [{ costType: 'FLAT_RATE' }] } }) };

const { fulfillmentPolicyUsesCalculatedShipping, _policyCostTypeCache } = require('../services/ebayListingService');

(async () => {
  for (let i = 0; i < 2000; i++) _policyCostTypeCache.set('filler:' + i, { value: false, at: Date.now() });
  const oldestKey = _policyCostTypeCache.keys().next().value;

  await fulfillmentPolicyUsesCalculatedShipping('rt', 'POLICY_NEW', 'EBAY_US');
  assert.ok(_policyCostTypeCache.size <= 2000, 'the cache never grows past its cap: ' + _policyCostTypeCache.size);
  assert.ok(!_policyCostTypeCache.has(oldestKey), 'the oldest entry was evicted to make room');

  console.log('policy cost type cache tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
