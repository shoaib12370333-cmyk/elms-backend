// services/aliexpressAuthService.js: the IOP request signature (sorted params, path-prefixed for system APIs, HMAC-SHA256
// hex uppercase - straight from the docs' own CURL example), the authorize URL, and the token exchange/refresh calls.
const assert = require('assert');
const crypto = require('crypto');
process.env.ALIEXPRESS_APP_KEY = '12345678';
process.env.ALIEXPRESS_APP_SECRET = 'my-app-secret';
process.env.ALIEXPRESS_REDIRECT_URI = 'https://elms-backend.onrender.com/api/aliexpress-connect/callback';

const stub = (specifier, exports) => { const p = require.resolve(specifier); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

const calls = [];
function axiosFake(...args) { calls.push(args); return axiosFake.__next(...args); }
stub('axios', { post: (...args) => axiosFake(...args) });

const svc = require('../services/aliexpressAuthService');

(async () => {
  // ---------- signature: matches the documented algorithm by construction (independently re-derived here) ----------
  const params = { app_key: '12345678', timestamp: '1790532598983', sign_method: 'sha256', code: 'abc' };
  const expectedBase = '/auth/token/create' + Object.keys(params).sort().map((k) => `${k}${params[k]}`).join('');
  const expected = crypto.createHmac('sha256', 'my-app-secret').update(expectedBase, 'utf8').digest('hex').toUpperCase();
  assert.strictEqual(svc.sign('/auth/token/create', params, 'my-app-secret'), expected);
  assert.strictEqual(/^[0-9A-F]{64}$/.test(expected), true, 'sanity: a hex-uppercase SHA256 digest');

  // a business API path (no leading "/") is not prefixed
  const baseNoPrefix = Object.keys(params).sort().map((k) => `${k}${params[k]}`).join('');
  assert.strictEqual(svc.sign('aliexpress.ds.product.get', params, 'my-app-secret'),
    crypto.createHmac('sha256', 'my-app-secret').update(baseNoPrefix, 'utf8').digest('hex').toUpperCase());

  // ---------- authorize URL: client_id/redirect_uri from env - redirect_uri is the bare URL, no query string (AliExpress
  // matches it exactly against the App Console's registered callback, confirmed against a real app - see routes/aliexpressConnect.js for where the state actually goes instead: a cookie) ----------
  const url = svc.buildAuthorizationUrl();
  const u = new URL(url);
  assert.strictEqual(u.origin + u.pathname, 'https://api-sg.aliexpress.com/oauth/authorize');
  assert.strictEqual(u.searchParams.get('response_type'), 'code');
  assert.strictEqual(u.searchParams.get('force_auth'), 'true');
  assert.strictEqual(u.searchParams.get('client_id'), '12345678');
  const redirectUri = u.searchParams.get('redirect_uri');
  assert.strictEqual(redirectUri, 'https://elms-backend.onrender.com/api/aliexpress-connect/callback', 'the bare URL, no query string at all');

  // ---------- exchangeCodeForToken: POSTs form-urlencoded to GATEWAY + path with a valid signature, normalizes the response ----------
  axiosFake.__next = (targetUrl, body, config) => {
    assert.strictEqual(targetUrl, 'https://api-sg.aliexpress.com/auth/token/create');
    assert.strictEqual(config.headers['Content-Type'], 'application/x-www-form-urlencoded;charset=utf-8');
    const sent = new URLSearchParams(body);
    assert.strictEqual(sent.get('app_key'), '12345678');
    assert.strictEqual(sent.get('sign_method'), 'sha256');
    assert.strictEqual(sent.get('code'), 'my-code');
    const forVerify = {};
    for (const [k, v] of sent.entries()) if (k !== 'sign') forVerify[k] = v;
    const reBase = '/auth/token/create' + Object.keys(forVerify).sort().map((k) => `${k}${forVerify[k]}`).join('');
    const reSign = crypto.createHmac('sha256', 'my-app-secret').update(reBase, 'utf8').digest('hex').toUpperCase();
    assert.strictEqual(sent.get('sign'), reSign, 'the sent signature verifies against the same params');
    return Promise.resolve({ status: 200, data: {
      code: '0', access_token: 'AT1', refresh_token: 'RT1', expires_in: '3600', refresh_expires_in: '2592000',
      seller_id: '200042362', account: 'test1234@126.com',
    } });
  };
  const tokens = await svc.exchangeCodeForToken('my-code');
  assert.strictEqual(tokens.accessToken, 'AT1');
  assert.strictEqual(tokens.refreshToken, 'RT1');
  assert.strictEqual(tokens.sellerId, '200042362');
  assert.strictEqual(tokens.account, 'test1234@126.com');
  assert.ok(tokens.accessTokenExpiresAt instanceof Date);
  assert.ok(tokens.accessTokenExpiresAt.getTime() > Date.now(), 'expiry is in the future');

  // ---------- refreshAccessToken: same shape, hits /auth/token/refresh with refresh_token ----------
  axiosFake.__next = (targetUrl, body) => {
    assert.strictEqual(targetUrl, 'https://api-sg.aliexpress.com/auth/token/refresh');
    assert.strictEqual(new URLSearchParams(body).get('refresh_token'), 'RT1');
    return Promise.resolve({ status: 200, data: { code: '0', access_token: 'AT2', refresh_token: 'RT2', expires_in: '3600', refresh_expires_in: '0' } });
  };
  const refreshed = await svc.refreshAccessToken('RT1');
  assert.strictEqual(refreshed.accessToken, 'AT2');
  assert.strictEqual(refreshed.refreshTokenExpiresAt, null, 'refresh_expires_in of 0 means no expiry given');

  // ---------- AliExpress's own error shape is surfaced with its message ----------
  axiosFake.__next = () => Promise.resolve({ status: 200, data: { code: 'InvalidCode', message: 'Invalid Code' } });
  await assert.rejects(() => svc.exchangeCodeForToken('bad'), /Invalid Code/);

  console.log('aliexpress auth service tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
