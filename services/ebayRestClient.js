const axios = require('axios');
const { getAccessToken, getAppAccessToken } = require('./ebayAuthService');
const { EBAY_API_BASE_URL } = require('../config/ebayEnvironment');
const { getMarketplaceConfig } = require('../config/ebayMarketplaces');
const { retryWithBackoff } = require('./retryService');

/**
 * A read-only GET to eBay's REST APIs, either as one seller (their refresh token) or as ELMS itself (application token).
 * Used by the "status" style reads (selling limits, listing violations, rate limits): they only show information, so a failure
 * is turned into an error with a readable message and the eBay status code, and never touches anything on eBay.
 */
async function get(accessToken, path, { marketplaceId = null, timeout = 15000 } = {}) {
  const locale = marketplaceId ? getMarketplaceConfig(marketplaceId)?.locale : null;
  const makeRequest = () => axios.get(`${EBAY_API_BASE_URL}${path}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(marketplaceId ? { 'X-EBAY-C-MARKETPLACE-ID': marketplaceId } : {}),
      ...(locale ? { 'Accept-Language': locale } : {}),
    },
    timeout,
  });
  try {
    return (await retryWithBackoff(makeRequest, { maxAttempts: 2 })).data;
  } catch (err) {
    const ebayErrors = err.response?.data?.errors || err.response?.data?.error_description;
    const message = Array.isArray(ebayErrors) && ebayErrors.length
      ? ebayErrors.map((e) => e.longMessage || e.message).filter(Boolean).join('; ')
      : (typeof ebayErrors === 'string' && ebayErrors) || err.message || 'The eBay API request failed.';
    const wrapped = new Error(message);
    wrapped.statusCode = err.response?.status || 500;
    wrapped.ebayErrors = Array.isArray(ebayErrors) ? ebayErrors : undefined;
    throw wrapped;
  }
}

/** GET as one seller. */
async function ebayUserGet(refreshToken, path, options) {
  return get(await getAccessToken(refreshToken), path, options);
}

/** GET as the ELMS application (for data that belongs to the app, not to a seller). */
async function ebayAppGet(path, options) {
  return get(await getAppAccessToken(), path, options);
}

module.exports = { ebayUserGet, ebayAppGet };
