// CJdropshipping (services/cjAdapter.js): the token exchange, the per-account rate-limit queue (one seller never waits behind
// another, but a single seller's own calls are always spaced out), product search/detail normalization, and the freight
// quote. The real adapter code runs; only axios (the actual HTTP call) and the CJ-credential storage are stand-ins.
const assert = require('assert');
process.env.CJ_MIN_INTERVAL_MS = '40'; // read once at module load, below - fast enough for a test, still enough to prove ordering

const stub = (specifier, exports) => { const p = require.resolve(specifier); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

const calls = []; // every axios call this test made: { config, at }
const scripted = new Map(); // path -> array of responses/throwers consumed in order; default: a generic success
function axiosFake(config) {
  calls.push({ config, at: Date.now() });
  const key = config.url.replace('https://developers.cjdropshipping.com/api2.0/v1', '').split('?')[0];
  const queue = scripted.get(key);
  const next = queue && queue.length ? queue.shift() : { data: { code: 200, result: true, data: {} } };
  if (typeof next === 'function') return Promise.resolve(next(config));
  if (next instanceof Error) return Promise.reject(next);
  return Promise.resolve(next);
}
stub('axios', axiosFake);

const creds = new Map(); // userId -> stored credentials, exactly what getCjCredentials/setCjCredentials would hold decrypted
stub('../models/usersModel', {
  setCjCredentials: async (userId, apiKey, tokens) => {
    creds.set(userId, { apiKey, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, accessTokenExpiresAt: tokens.accessTokenExpiryDate ? new Date(tokens.accessTokenExpiryDate) : null, refreshTokenExpiresAt: tokens.refreshTokenExpiryDate ? new Date(tokens.refreshTokenExpiryDate) : null });
    return true;
  },
  setCjTokens: async (userId, tokens) => {
    const c = creds.get(userId);
    Object.assign(c, { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, accessTokenExpiresAt: tokens.accessTokenExpiryDate ? new Date(tokens.accessTokenExpiryDate) : null });
  },
  getCjCredentials: async (userId) => creds.get(userId) || null,
  clearCjCredentials: async (userId) => { creds.delete(userId); },
});

const cjAdapter = require('../services/cjAdapter');

const FAR_FUTURE = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
const NEAR_EXPIRY = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // inside the 1-day refresh margin

(async () => {
  // ---------- connect: validates the key by asking for a token, stores it (never in plain text - that's usersModel's job, stubbed here) ----------
  scripted.set('/authentication/getAccessToken', [{ data: { code: 200, result: true, data: { openId: 1, accessToken: 'AT1', accessTokenExpiryDate: FAR_FUTURE, refreshToken: 'RT1', refreshTokenExpiryDate: FAR_FUTURE } } }]);
  await cjAdapter.connect('u1', '  my-cj-key  ');
  assert.strictEqual(calls[0].config.method, 'POST');
  assert.strictEqual(calls[0].config.url, 'https://developers.cjdropshipping.com/api2.0/v1/authentication/getAccessToken');
  assert.strictEqual(calls[0].config.data.apiKey, 'my-cj-key', 'the key is trimmed before it is sent');
  assert.strictEqual(creds.get('u1').accessToken, 'AT1');
  await assert.rejects(() => cjAdapter.connect('u2', '  '), /API key/i, 'an empty key never reaches CJ');

  // a key CJ refuses: the error message is CJ's own, and nothing is stored
  scripted.set('/authentication/getAccessToken', [{ data: { code: 1601000, result: false, message: 'User not find' } }]);
  await assert.rejects(() => cjAdapter.connect('u2', 'bad-key'), /User not find/);
  assert.strictEqual(creds.has('u2'), false);

  // ---------- ensureToken: a fresh token is reused, a near-expiry one is refreshed and the new pair is stored ----------
  calls.length = 0;
  await cjAdapter.searchProducts('u1', { keyword: 'x' }); // access token far from expiry: no refresh call
  assert.strictEqual(calls.length, 1, 'one call only - the token was not refreshed');
  assert.strictEqual(calls[0].config.headers['CJ-Access-Token'], 'AT1');

  creds.get('u1').accessTokenExpiresAt = new Date(NEAR_EXPIRY);
  scripted.set('/authentication/refreshAccessToken', [{ data: { code: 200, result: true, data: { accessToken: 'AT2', accessTokenExpiryDate: FAR_FUTURE, refreshToken: 'RT2', refreshTokenExpiryDate: FAR_FUTURE } } }]);
  calls.length = 0;
  await cjAdapter.searchProducts('u1', { keyword: 'x' });
  assert.strictEqual(calls.length, 2, 'a refresh call, then the real call');
  assert.strictEqual(calls[0].config.url.endsWith('/authentication/refreshAccessToken'), true);
  assert.strictEqual(calls[1].config.headers['CJ-Access-Token'], 'AT2', 'the refreshed token is used right away');
  assert.strictEqual(creds.get('u1').accessToken, 'AT2', 'the refreshed pair is stored');

  // ---------- the rate-limit queue: one seller's own calls are spaced out, two sellers never wait on each other ----------
  scripted.set('/product/listV2', []); // default generic success answers every call
  calls.length = 0;
  await Promise.all([cjAdapter.searchProducts('u1', {}), cjAdapter.searchProducts('u1', {})]);
  const u1Calls = calls.filter((c) => c.config.url.includes('listV2')).sort((a, b) => a.at - b.at);
  assert.ok(u1Calls[1].at - u1Calls[0].at >= 35, `u1's two calls were spaced at least ~CJ_MIN_INTERVAL_MS apart, got ${u1Calls[1].at - u1Calls[0].at}ms`);

  scripted.set('/authentication/getAccessToken', [{ data: { code: 200, result: true, data: { accessToken: 'AT3', accessTokenExpiryDate: FAR_FUTURE, refreshToken: 'RT3', refreshTokenExpiryDate: FAR_FUTURE } } }]);
  await cjAdapter.connect('u3', 'key3');
  // u1's queue already has a recent `last` (the pacing test just above), so its own next call still waits its ~40ms - that is
  // correct, per-account pacing. What must NOT happen is u3 waiting on IT: u3's own queue has never been used, so its call
  // must go out right away, well before u1's (delayed) call does.
  calls.length = 0;
  const t1 = Date.now();
  const u3Done = cjAdapter.searchProducts('u3', {}).then(() => Date.now() - t1);
  const u1Done = cjAdapter.searchProducts('u1', {}).then(() => Date.now() - t1);
  const [u3Elapsed, u1Elapsed] = await Promise.all([u3Done, u1Done]);
  assert.ok(u3Elapsed < 20, `u3's first-ever call went out immediately (${u3Elapsed}ms), not spaced by u1's queue`);
  assert.ok(u1Elapsed >= 20, `u1's own queue still paced its call (${u1Elapsed}ms) - the two queues are independent, not that neither paces`);

  // ---------- product search: CJ's nested { content: [{ productList }] } shape, normalized ----------
  scripted.set('/product/listV2', [{ data: { code: 200, result: true, data: { pageSize: 20, pageNumber: 1, totalRecords: 1, totalPages: 1, content: [{ productList: [{ id: 'PID1', nameEn: 'Cat Ear Hoody', bigImage: 'https://img/x.jpg', sellPrice: '11.85', deliveryCycle: '3-5', threeCategoryName: 'Hoodies', addMarkStatus: 1, warehouseInventoryNum: 500 }] }] } } }]);
  const found = await cjAdapter.searchProducts('u1', { keyword: 'hoodie', page: 1, size: 20 });
  assert.deepStrictEqual(found, { total: 1, page: 1, pages: 1, products: [{ cjProductId: 'PID1', title: 'Cat Ear Hoody', image: 'https://img/x.jpg', price: 11.85, currency: 'USD', deliveryCycle: '3-5', category: 'Hoodies', freeShipping: true, inventory: 500 }] });
  const qs = new URL(calls[calls.length - 1].config.url).searchParams;
  assert.strictEqual(qs.get('keyWord'), 'hoodie');

  // ---------- product detail: pid/productSku/variantSku, and the "no variants" case ----------
  scripted.set('/product/query', [{ data: { code: 200, result: true, data: { pid: 'PID1', productNameEn: 'Cat Ear Hoody', bigImage: 'https://img/x.jpg', variants: [{ vid: 'VID1', variantSku: 'CJHOODY-BLACK', variantSellPrice: 9.5, inventories: [{ countryCode: 'CN', totalInventory: 100 }] }] } } }]);
  const detail = await cjAdapter.getProductDetail('u1', { pid: 'PID1' });
  assert.strictEqual(detail.variants[0].vid, 'VID1');
  assert.strictEqual(new URL(calls[calls.length - 1].config.url).searchParams.get('pid'), 'PID1');

  scripted.set('/product/query', [{ data: { code: 200, result: true, data: { pid: 'PID2', variants: [] } } }]);
  await assert.rejects(() => cjAdapter.getProductDetail('u1', { pid: 'PID2' }), /does not have that product/);
  await assert.rejects(() => cjAdapter.getProductDetail('u1', {}), /product id, product SKU or variant SKU is required/);

  // ---------- freight: the cheapest quote wins; a downstream failure returns null rather than throwing ----------
  scripted.set('/logistic/freightCalculate', [{ data: { code: 200, result: true, data: [
    { logisticAging: '5-10', logisticPrice: 6.2, logisticName: 'Slow Post' },
    { logisticAging: '2-5', logisticPrice: 4.71, logisticName: 'USPS+' },
  ] } }]);
  const freight = await cjAdapter.calcFreight('u1', { vid: 'VID1', quantity: 2, endCountryCode: 'US' });
  assert.deepStrictEqual(freight, { cost: 4.71, carrier: 'USPS+', days: '2-5' }, 'the cheapest of several quotes is picked');
  const freightBody = calls[calls.length - 1].config.data;
  assert.deepStrictEqual(freightBody, { startCountryCode: 'CN', endCountryCode: 'US', products: [{ vid: 'VID1', quantity: 2 }] });

  scripted.set('/logistic/freightCalculate', [{ data: { code: 1600300, result: false, message: 'Param error' } }]);
  const noQuote = await cjAdapter.calcFreight('u1', { vid: 'VID1', quantity: 1, endCountryCode: 'XX' });
  assert.strictEqual(noQuote, null, 'a failed quote is null, never a thrown error (an import/reprice must not fail just because shipping could not be quoted)');

  // ---------- disconnect: best-effort logout, then the stored credentials are gone ----------
  scripted.set('/authentication/logout', [{ data: { code: 200, result: true, data: true } }]);
  await cjAdapter.disconnect('u1');
  assert.strictEqual(creds.has('u1'), false);
  await cjAdapter.disconnect('nobody'); // never connected: must not throw (Disconnect is idempotent)

  // ---------- ensureToken: never connected ----------
  await assert.rejects(() => cjAdapter.searchProducts('never-connected', {}), /not connected/);

  console.log('cj adapter tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
