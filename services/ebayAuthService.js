const axios = require('axios');
const { EBAY_TOKEN_URL } = require('../config/ebayEnvironment');

/**
 * eBay OAuth token endpoint - Production or Sandbox depending on EBAY_ENV
 * (see config/ebayEnvironment.js).
 */
const TOKEN_URL = EBAY_TOKEN_URL;

// Caches access tokens per refresh token, so we don't request a new one
// on every request for every user. Key: refreshToken, Value: { accessToken, expiresAt }.
const tokenCache = new Map();

/**
 * Returns a fresh (or cached) access token for a given eBay refresh token.
 * Each ELMS user has their own refresh token (from connecting their eBay
 * account), so this must always be called with that specific user's token.
 *
 * @param {string} refreshToken - the eBay refresh token to use
 */
async function getAccessToken(refreshToken) {
  if (!refreshToken) {
    throw new Error('An eBay refresh token is required. Has this user connected their eBay account?');
  }

  const now = Date.now();
  const cached = tokenCache.get(refreshToken);

  // If the cached token is still valid (with a 1-minute safety buffer)
  if (cached && now < cached.expiresAt - 60000) {
    return cached.accessToken;
  }

  const clientId = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('EBAY_CLIENT_ID or EBAY_CLIENT_SECRET is not set in the .env file.');
  }

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const params = new URLSearchParams();
  params.append('grant_type', 'refresh_token');
  params.append('refresh_token', refreshToken);
  // IMPORTANT: this must include every scope this access token will ever
  // need to be used for, space-separated - eBay only allows requesting a
  // SUBSET of what the user originally consented to, and any endpoint
  // that needs a scope not listed here will be rejected with that scope's
  // token unusable for it. Previously this only listed sell.inventory,
  // which is why every access token minted from a refresh token could
  // publish/manage listings but could NOT call the Taxonomy API (category
  // suggestions) - that API needs the generic api_scope below, which
  // wasn't being requested. Keep this in sync with the full scope list
  // in ebayUserAuthService.js that the user actually consents to.
  params.append('scope', [
    'https://api.ebay.com/oauth/api_scope',
    'https://api.ebay.com/oauth/api_scope/sell.inventory',
    'https://api.ebay.com/oauth/api_scope/sell.account',
    'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
    'https://api.ebay.com/oauth/api_scope/commerce.identity.readonly',
    'https://api.ebay.com/oauth/api_scope/commerce.message',
    'https://api.ebay.com/oauth/api_scope/commerce.notification.subscription',
  ].join(' '));

  let response;
  try {
    response = await axios.post(TOKEN_URL, params, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basicAuth}`,
      },
      timeout: 15000,
    });
  } catch (err) {
    const message =
      err.response?.data?.error_description ||
      err.response?.data?.error ||
      'Could not get an access token from eBay.';
    const wrapped = new Error(message);
    wrapped.statusCode = err.response?.status || 500;
    throw wrapped;
  }

  const accessToken = response.data.access_token;
  const expiresAt = now + response.data.expires_in * 1000;

  tokenCache.set(refreshToken, { accessToken, expiresAt });

  return accessToken;
}

// Caches the single application-level access token (client_credentials
// grant) - unlike getAccessToken above, this isn't per-user, since it
// represents ELMS's own app identity, not any particular seller's
// authorization.
let appTokenCache = null;

/**
 * Returns a fresh (or cached) application-level access token, using the
 * client_credentials grant. Used for eBay APIs that operate on
 * application-level data rather than a specific user's account - e.g.
 * fetching the public key used to verify notification signatures.
 */
async function getAppAccessToken() {
  const now = Date.now();
  if (appTokenCache && now < appTokenCache.expiresAt - 60000) {
    return appTokenCache.accessToken;
  }

  const clientId = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('EBAY_CLIENT_ID or EBAY_CLIENT_SECRET is not set in the .env file.');
  }

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const params = new URLSearchParams();
  params.append('grant_type', 'client_credentials');
  params.append('scope', 'https://api.ebay.com/oauth/api_scope');

  let response;
  try {
    response = await axios.post(TOKEN_URL, params, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basicAuth}`,
      },
      timeout: 15000,
    });
  } catch (err) {
    const message =
      err.response?.data?.error_description ||
      err.response?.data?.error ||
      'Could not get an application access token from eBay.';
    const wrapped = new Error(message);
    wrapped.statusCode = err.response?.status || 500;
    throw wrapped;
  }

  appTokenCache = {
    accessToken: response.data.access_token,
    expiresAt: now + response.data.expires_in * 1000,
  };

  return appTokenCache.accessToken;
}

module.exports = { getAccessToken, getAppAccessToken };
