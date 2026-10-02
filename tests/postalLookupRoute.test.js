// routes/sellerSettings.js GET /postal-lookup: resolves a postal code the seller TYPED themselves (not generated),
// using the same resolveLocation() the PUT settings save uses right before accepting it - so what this endpoint
// shows always agrees with what Save will actually do. Previously called the separate, weaker lookupPostalCode
// directly, which skipped resolveLocation's GB outward-code completion and could disagree with Save.
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

stub('middleware/requireAuth', { requireAuth: (req, res, next) => { req.userId = 'u1'; next(); } });

const axios = require('axios');
let getImpl;
axios.get = async (url, config) => getImpl(String(url), config);

const router = require('../routes/sellerSettings');
const routeHandler = (p, method) => {
  const l = router.stack.find((x) => x.route && x.route.path === p && x.route.methods[method]);
  assert.ok(l, `route ${method.toUpperCase()} ${p} exists`);
  return l.route.stack[l.route.stack.length - 1].handle;
};
const call = async (handler, { query = {} } = {}) => {
  const out = { status: 200 };
  const res = { status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; } };
  await handler({ query, userId: 'u1' }, res);
  return out;
};

(async () => {
  const handler = routeHandler('/postal-lookup', 'get');

  // ---- missing params ----
  let out = await call(handler, { query: {} });
  assert.strictEqual(out.status, 400);

  // ---- a plain US zip code: resolveLocation's cleanPostalCode accepts the format, Zippopotam fills in the city ----
  getImpl = async (url) => {
    if (url.includes('zippopotam')) return { data: { places: [{ 'place name': 'New York', state: 'New York' }], country: 'United States' } };
    throw new Error('unexpected request: ' + url);
  };
  out = await call(handler, { query: { country: 'US', postalCode: '10001' } });
  assert.strictEqual(out.status, 200);
  assert.strictEqual(out.body.location.postalCode, '10001');
  assert.strictEqual(out.body.location.city, 'New York');
  assert.strictEqual(out.body.location.countryName, 'United States', 'countryName is now included, matching generatePostalCode\'s shape');
  assert.strictEqual(out.body.location.complete, true);

  // ---- a UK OUTWARD code only (e.g. "SW1A") - resolveLocation completes it to a real full postcode via postcodes.io,
  // something the old lookupPostalCode-direct implementation never did ----
  getImpl = async (url, config) => {
    if (url === 'https://api.postcodes.io/postcodes' && config?.params?.q === 'SW1A') return { data: { result: [{ postcode: 'SW1A 1AA', admin_district: 'Westminster', region: 'London' }] } };
    throw new Error('unexpected request: ' + url + ' ' + JSON.stringify(config?.params));
  };
  out = await call(handler, { query: { country: 'GB', postalCode: 'SW1A' } });
  assert.strictEqual(out.status, 200);
  assert.strictEqual(out.body.location.postalCode, 'SW1A 1AA', 'completed to a real full postcode');
  assert.strictEqual(out.body.location.completedFrom, 'SW1A');
  assert.strictEqual(out.body.location.countryName, 'United Kingdom');

  // ---- a GB outward code with nothing found for it: not a hard error, { complete: false } ----
  getImpl = async (url, config) => {
    if (url === 'https://api.postcodes.io/postcodes' && config?.params?.q === 'ZZ9') return { data: { result: [] } };
    throw new Error('unexpected request: ' + url + ' ' + JSON.stringify(config?.params));
  };
  out = await call(handler, { query: { country: 'GB', postalCode: 'ZZ9' } });
  assert.strictEqual(out.status, 200, 'an unresolved code is a normal answer, not an HTTP error');
  assert.strictEqual(out.body.location.complete, false);

  // ---- an unsupported country throws from normalizeCountry, surfaced as a 400 ----
  out = await call(handler, { query: { country: 'ZZ', postalCode: '123' } });
  assert.strictEqual(out.status, 400);

  console.log('postal-lookup route tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
