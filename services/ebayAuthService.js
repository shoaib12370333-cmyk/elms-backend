const axios = require('axios');

/**
 * eBay OAuth token endpoint. Production only (per current project setup).
 */
const TOKEN_URL = 'https://api.ebay.com/identity/v1/oauth2/token';

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
  // Scope tells eBay what this token will be used for - inventory (listings).
  params.append('scope', 'https://api.ebay.com/oauth/api_scope/sell.inventory');

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

module.exports = { getAccessToken };
