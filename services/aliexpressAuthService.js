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
 * The authorize URL's docs show no "state" parameter, and AliExpress checks redirect_uri for an EXACT match against the App
 * Console's registered callback URL (confirmed against a real app: appending "?state=..." to it was rejected with "Redirect
 * uri does not match the callback url of the APP") - so, unlike eBay's OAuth, there is no query string available to carry
 * which ELMS user is mid-connect back to the callback. redirect_uri here is always the bare, fixed URL; routes/
 * aliexpressConnect.js carries the state in a short-lived cookie instead (set when /start redirects the browser to this
 * URL, read back when AliExpress redirects the browser to the callback - both first-party requests to ELMS's own domain).
 */

const { parseJsonKeepingLongIds } = require('./jsonLongInts');

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

/** Signs and POSTs (form-urlencoded) to GATEWAY + url, signing against signPath (see sign() above). Shared by system and business calls. */
async function postSigned(url, signPath, params) {
  const key = appKey();
  const secret = appSecret();
  if (!key || !secret) throw new Error('ALIEXPRESS_APP_KEY / ALIEXPRESS_APP_SECRET are not configured.');

  const clean = {};
  Object.entries(params || {}).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') clean[k] = v; });
  const withSystem = { ...clean, app_key: key, timestamp: String(Date.now()), sign_method: 'sha256' };
  const signature = sign(signPath, withSystem, secret);
  const body = new URLSearchParams({ ...withSystem, sign: signature });

  let res;
  try {
    res = await axios.post(GATEWAY + url, body.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
      timeout: 20000, validateStatus: () => true,
      // Ids are 16-17 digits: as plain JSON numbers they lose their last digits (12000027158136203 would read as ...204), which for an
      // order number means paying or reading ANOTHER order. Long integers are turned into strings before parsing (services/jsonLongInts.js).
      transformResponse: [(raw) => {
        if (typeof raw !== 'string') return raw;
        try { return parseJsonKeepingLongIds(raw); } catch (_) { return raw; } // not JSON: handed on as text, rejected just below
      }],
    });
  } catch (err) {
    throw new Error('Could not reach AliExpress: ' + err.message);
  }
  const data = res.data;
  if (!data || typeof data !== 'object') throw new Error(`AliExpress sent back something unexpected (HTTP ${res.status}).`);
  if (data.code && String(data.code) !== '0') {
    throw Object.assign(new Error(data.rsp_msg || data.message || `AliExpress error ${data.code}`), { aliCode: data.code });
  }
  return data;
}

/** A system-tool API (/auth/token/create, /auth/token/refresh) - called at GATEWAY + path directly. */
async function callSystemApi(path, params) {
  return postSigned(path, path, params);
}

/**
 * A business/DS API (e.g. aliexpress.ds.product.get) - called at GATEWAY + "/sync" with the API name in a "method" param and
 * the seller's access token in a "session" param (the "session" name is standard across Alibaba's IOP/TOP-protocol platforms
 * for this, matching how the docs' own IopClient demo passes accessToken as a separate argument to client.execute() - this
 * has NOT been confirmed against a real AliExpress call; see PRODUCTION-SETUP.md).
 */
async function callBusinessApi(method, accessToken, params) {
  const data = await postSigned('/sync', method, { ...params, method, session: accessToken });
  return data.result !== undefined ? data.result : data;
}

/** The URL to send the seller to for the AliExpress consent screen (routes/aliexpressConnect.js /start). redirect_uri must be
 * the exact, bare URL registered in the App Console - no query string, AliExpress matches it exactly. */
function buildAuthorizationUrl() {
  const params = new URLSearchParams({
    response_type: 'code',
    force_auth: 'true',
    redirect_uri: redirectBase(),
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

module.exports = { buildAuthorizationUrl, exchangeCodeForToken, refreshAccessToken, sign, callSystemApi, callBusinessApi, GATEWAY };
