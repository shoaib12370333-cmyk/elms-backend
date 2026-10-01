// generatePostalCode's in-memory cache is keyed by city/state/country - a seller can generate a postal code for a different
// city on every call, so without a cap this would grow for as long as the process runs (same shape of leak as the eBay
// taxonomy cache). This only checks the cap/eviction, not the geocoding logic itself (covered elsewhere by using it).
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

stub('services/postalCodeService', { lookupPostalCode: async () => true });

const axios = require('axios');
axios.get = async (url, config) => {
  if (String(url).includes('/search')) return { data: [{ lat: '40.0', lon: '-75.0', address: { city: 'Springfield', state: 'IL' } }] };
  if (String(url).includes('/reverse')) return { data: { address: { city: 'Springfield', state: 'IL', postcode: '62701' } } };
  throw new Error('unexpected request: ' + url + ' ' + JSON.stringify(config?.params));
};

const P = require('../services/postalGeneratorService');

(async () => {
  for (let i = 0; i < 2000; i++) P._cache.set('filler:' + i, { at: Date.now(), value: {} });
  const oldestKey = P._cache.keys().next().value;

  await P.generatePostalCode('US', 'Springfield', 'IL');
  assert.ok(P._cache.size <= 2000, 'the cache never grows past its cap: ' + P._cache.size);
  assert.ok(!P._cache.has(oldestKey), 'the oldest entry was evicted to make room');

  console.log('postal generator cache tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
