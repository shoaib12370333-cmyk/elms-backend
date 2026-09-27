const crypto = require('crypto');
const axios = require('axios');

/**
 * AliExpress Open Platform (developers.aliexpress.com) uses Alibaba's IOP protocol - the same family CJ/Lazada open
 * platforms use, but called over plain REST here (the official SDKs are Java/PHP/.NET/Ruby/Python only, no Node.js one).
 *
 * Signing (from the docs' own CURL example: app_key, timestamp, sign_method=sha256, sign, plus the API's own params):
 *   1. Sort every request parameter (never the "sign" one itself) by name, ASCII order.
 *   2. Concatenate them as name+value, back to back, no separators: "name1value1name2value2...".
 *   3. For a system-tool API (its path starts with "/", e.g. /auth/token/create) prepend that path to the string first.
 *   4. sign = HMAC-SHA256(key: appSecret, message: that string), hex, UPPERCASE.
 *
 * The authorize URL's docs show no "state" parameter, and AliExpress's OAuth (unlike eBay's) gives no other way to carry
 * which ELMS user is mid-connect back to the callback. So the state token is appended to redirect_uri itself as a query
 * string - AliExpress redirects back to whatever redirect_uri was sent, with "code" added on, so the state survives the
 * round trip. This is unverified against a real AliExpress app until the first real "Connect AliExpress" attempt: if
 * AliExpress requires an exact match against the App Console's registered redirect_uri (not just a prefix), the first
 * connect attempt will show a redirect_uri-mismatch error instead of ELMS's own callback page - see PRODUCTION-SETUP.md.
 */

const GATEWAY = 'https://api-sg.aliexpress.com';

function appKey() { return process.env.ALIEXPRESS_APP_KEY; }
function appSecret() { return process.env.ALIEXPRESS_APP_SECRET; }
function redirectBase() {
  const base = process.env.ALIEXPRESS_REDIRECT_URI || `${String(process.env.BACKEND_PUBLIC_URL || '').replace(/\/+$/, '')}/api/aliexpress-connect/callback`;
  if (!base || !/^https?:\/\//i.test(base)) throw new Error('ALIEXPRESS_REDIRECT_URI (or BACKEND_PUBLIC_URL) is not configured.');
  return base;
}

function sign(path, params, secret) {
  const base = Object.keys(params).sort()
    .map((k) => `${k}${params[k]}`).join('');
  const message = path && path.startsWith('/') ? path + base : base;
  return crypto.createHmac('sha256', secret).update(message, 'utf8').digest('hex').toUpperCase();
}

/** A system-tool API (/auth/token/create, /auth/token/refresh) - called at GATEWAY + path directly, form-urlencoded POST. */
async function callSystemApi(path, params) {
  const key = appKey();
  const secret = appSecret();
  if (!key || !secret) throw new Error('ALIEXPRESS_APP_KEY / ALIEXPRESS_APP_SECRET are not configured.');

  const withSystem = { ...params, app_key: key, timestamp: String(Date.now()), sign_method: 'sha256' };
  const signature = sign(path, withSystem, secret);
  const body = new URLSearchParams({ ...withSystem, sign: signature });

  let res;
  try {
    res = await axios.post(GATEWAY + path, body.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
      timeout: 20000, validateStatus: () => true,
    });
  } catch (err) {
    throw new Error('Could not reach AliExpress: ' + err.message);
  }
  const data = res.data;
  if (!data || typeof data !== 'object') throw new Error(`AliExpress sent back something unexpected (HTTP ${res.status}).`);
  if (data.code && String(data.code) !== '0') {
    throw Object.assign(new Error(data.message || `AliExpress error ${data.code}`), { aliCode: data.code });
  }
  return data;
}

/** The URL to send the seller to for the AliExpress consent screen (routes/aliexpressConnect.js /start). */
function buildAuthorizationUrl(state) {
  const redirectUri = `${redirectBase()}?state=${encodeURIComponent(state)}`;
  const params = new URLSearchParams({
    response_type: 'code',
    force_auth: 'true',
    redirect_uri: redirectUri,
    client_id: appKey(),
  });
  return `${GATEWAY}/oauth/authorize?${params.toString()}`;
}

function tokenResult(data) {
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    accessTokenExpiresAt: Number(data.expires_in) ? new Date(Date.now() + Number(data.expires_in) * 1000) : null,
    refreshTokenExpiresAt: Number(data.refresh_expires_in) ? new Date(Date.now() + Number(data.refresh_expires_in) * 1000) : null,
    sellerId: data.seller_id || data.user_id || null,
    account: data.account || data.user_nick || null,
  };
}

/** Exchanges the "code" AliExpress returned to the callback for an access/refresh token pair. The code expires in 3 minutes. */
async function exchangeCodeForToken(code) {
  const data = await callSystemApi('/auth/token/create', { code });
  return tokenResult(data);
}

/** Refreshes an access token. The refresh token's own expiry is not reset by this - see usage notes in the docs. */
async function refreshAccessToken(refreshToken) {
  const data = await callSystemApi('/auth/token/refresh', { refresh_token: refreshToken });
  return tokenResult(data);
}

module.exports = { buildAuthorizationUrl, exchangeCodeForToken, refreshAccessToken, sign, callSystemApi, GATEWAY };
