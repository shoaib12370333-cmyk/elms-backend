// services/aliexpressAdapter.js: ensureToken (a fresh token is reused, a near-expiry one is refreshed once even under
// concurrent calls) and getProductDetail (the "no such product" case). The real adapter code runs; only
// aliexpressAuthService's network calls and the AliExpress-credential storage are stand-ins.
const assert = require('assert');

let unhandled = 0;
process.on('unhandledRejection', () => { unhandled += 1; });

const stub = (specifier, exports) => { const p = require.resolve(specifier); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

const creds = new Map(); // userId -> { accessToken, refreshToken, accessTokenExpiresAt }
let refreshCalls = 0;
stub('../services/aliexpressAuthService', {
  callBusinessApi: async (method, accessToken, params) => {
    if (params.product_id === 'missing') return {};
    return { ae_item_base_info_dto: { subject: 'Widget', product_id: params.product_id }, ae_item_sku_info_dtos: [{ sku_id: 'S1' }], calledWith: { method, accessToken, params } };
  },
  refreshAccessToken: async (refreshToken) => {
    refreshCalls++;
    await new Promise((r) => setTimeout(r, 20)); // a real HTTP call takes some time - long enough for a second concurrent ensureToken to arrive mid-refresh
    if (refreshToken === 'RT-fail') throw new Error('refresh failed');
    if (refreshToken === 'RT-no-new-rt') return { accessToken: 'AT-fresh', accessTokenExpiresAt: new Date(Date.now() + 3600 * 1000) }; // an answer without a refresh token
    return { accessToken: 'AT-new-from-' + refreshToken, refreshToken: 'RT-new', accessTokenExpiresAt: new Date(Date.now() + 3600 * 1000) };
  },
});
stub('../models/usersModel', {
  getAliexpressCredentials: async (userId) => creds.get(userId) || null,
  setAliexpressTokens: async (userId, tokens) => { creds.set(userId, { ...creds.get(userId), accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, accessTokenExpiresAt: tokens.accessTokenExpiresAt }); },
});

const adapter = require('../services/aliexpressAdapter');

const FAR_FUTURE = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
const NEAR_EXPIRY = new Date(Date.now() + 5 * 60 * 1000); // inside the 30-minute refresh margin

(async () => {
  // ---------- ensureToken: never connected ----------
  await assert.rejects(() => adapter.ensureToken('nobody'), /not connected/);

  // ---------- a fresh token is reused, never refreshed ----------
  creds.set('u1', { accessToken: 'AT1', refreshToken: 'RT1', accessTokenExpiresAt: FAR_FUTURE });
  const token = await adapter.ensureToken('u1');
  assert.strictEqual(token, 'AT1');
  assert.strictEqual(refreshCalls, 0);

  // ---------- a near-expiry token is refreshed, and the new pair is stored ----------
  creds.set('u1', { accessToken: 'AT1', refreshToken: 'RT1', accessTokenExpiresAt: NEAR_EXPIRY });
  const refreshed = await adapter.ensureToken('u1');
  assert.strictEqual(refreshed, 'AT-new-from-RT1');
  assert.strictEqual(refreshCalls, 1);
  assert.strictEqual(creds.get('u1').accessToken, 'AT-new-from-RT1', 'the refreshed pair is stored');

  // ---------- concurrent calls on a near-expiry token share ONE refresh, never two ----------
  creds.set('u2', { accessToken: 'AT2', refreshToken: 'RT2', accessTokenExpiresAt: NEAR_EXPIRY });
  refreshCalls = 0;
  const [a, b] = await Promise.all([adapter.ensureToken('u2'), adapter.ensureToken('u2')]);
  assert.strictEqual(refreshCalls, 1, 'only one refresh call for two concurrent callers');
  assert.strictEqual(a, b);

  // ---------- getProductDetail: normalizes through callBusinessApi, ship_to_country/currency/language defaults ----------
  creds.set('u3', { accessToken: 'AT3', refreshToken: 'RT3', accessTokenExpiresAt: FAR_FUTURE });
  const detail = await adapter.getProductDetail('u3', { productId: '123' });
  assert.strictEqual(detail.ae_item_base_info_dto.subject, 'Widget');
  assert.strictEqual(detail.calledWith.method, 'aliexpress.ds.product.get');
  assert.strictEqual(detail.calledWith.accessToken, 'AT3');
  assert.strictEqual(detail.calledWith.params.ship_to_country, 'US');
  assert.strictEqual(detail.calledWith.params.target_currency, 'USD');

  await assert.rejects(() => adapter.getProductDetail('u3', { productId: 'missing' }), (err) => {
    assert.match(err.message, /does not have that product/);
    assert.strictEqual(err.productMissing, true, 'callers can tell "this product is gone" from "AliExpress did not answer"');
    assert.strictEqual(err.statusCode, 404);
    return true;
  });
  await assert.rejects(() => adapter.getProductDetail('u3', {}), /product id is required/);

  // ---------- a refresh answer without a refresh token keeps the old one (the new access token is not lost, nothing throws on encrypt(undefined)) ----------
  creds.set('u5', { accessToken: 'AT5', refreshToken: 'RT-no-new-rt', accessTokenExpiresAt: NEAR_EXPIRY });
  assert.strictEqual(await adapter.ensureToken('u5'), 'AT-fresh');
  assert.strictEqual(creds.get('u5').refreshToken, 'RT-no-new-rt', 'the refresh token we had is kept');

  // ---------- a FAILED refresh rejects to its caller - and raises no second, unhandled rejection from the side branch that clears the in-flight entry ----------
  creds.set('u4', { accessToken: 'AT4', refreshToken: 'RT-fail', accessTokenExpiresAt: NEAR_EXPIRY });
  await assert.rejects(() => adapter.ensureToken('u4'), /refresh failed/);
  await new Promise((r) => setTimeout(r, 30)); // unhandled rejections are reported a tick later
  assert.strictEqual(unhandled, 0, 'no unhandled rejection');
  // ...and the next call tries again (the failed entry was cleared)
  await assert.rejects(() => adapter.ensureToken('u4'), /refresh failed/);

  console.log('aliexpress adapter tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
