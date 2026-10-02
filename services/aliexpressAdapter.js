const { callBusinessApi, refreshAccessToken } = require('./aliexpressAuthService');

/**
 * AliExpress product fetch (aliexpress.ds.product.get) - the AliExpress counterpart of services/cjAdapter.js. Nothing here
 * shares a field, a call or a credit key with Amazon or CJ; every seller's connection is their own (models/usersModel.js
 * getAliexpressCredentials/setAliexpressTokens, from routes/aliexpressConnect.js's OAuth flow, not a pasted key like CJ).
 *
 * Rate limit: the docs' FAQ gives an overall 500 QPS with a 1-2% throttling error rate, nothing like CJ's strict 1/second -
 * so, unlike cjAdapter.js, ordinary calls are not queued/paced here. Only a token refresh is serialized per user, so two
 * near-simultaneous calls with a near-expired token never both refresh (and overwrite each other's new refresh token).
 */

const REFRESH_MARGIN_MS = 30 * 60 * 1000; // refresh 30 minutes before expiry (the docs recommend refreshing this early)
const refreshChains = new Map(); // userId -> in-flight refresh promise, so concurrent calls share one refresh

/** A valid access token for this user, refreshing it first when it is near expiry. Throws (409) when AliExpress was never connected. */
async function ensureToken(userId) {
  const { getAliexpressCredentials, setAliexpressTokens } = require('../models/usersModel');
  const creds = await getAliexpressCredentials(userId);
  if (!creds) throw Object.assign(new Error('AliExpress is not connected for this account.'), { statusCode: 409 });
  const expiresSoon = !creds.accessTokenExpiresAt || creds.accessTokenExpiresAt.getTime() - Date.now() < REFRESH_MARGIN_MS;
  if (!expiresSoon) return creds.accessToken;

  const key = String(userId);
  let chain = refreshChains.get(key);
  if (!chain) {
    chain = (async () => {
      const refreshed = await refreshAccessToken(creds.refreshToken);
      // Should a refresh answer ever omit the refresh token, keep the one we have rather than lose the new access token over it.
      await setAliexpressTokens(userId, { ...refreshed, refreshToken: refreshed.refreshToken || creds.refreshToken });
      return refreshed.accessToken;
    })();
    refreshChains.set(key, chain);
    // .catch: a failed refresh already rejects `chain` to its callers; this side branch must not raise a second, unhandled rejection.
    chain.finally(() => { if (refreshChains.get(key) === chain) refreshChains.delete(key); }).catch(() => {});
  }
  return chain;
}

/**
 * Full detail of one AliExpress product (every sku/variant included), by its numeric product id. shipToCountry matters:
 * "The price calculation logic depends on the user's account data" and varies by destination country per the docs.
 */
async function getProductDetail(userId, { productId, shipToCountry = 'US', targetCurrency = 'USD', targetLanguage = 'en' } = {}) {
  const id = String(productId || '').trim();
  if (!id) throw new Error('An AliExpress product id is required.');
  const token = await ensureToken(userId);
  const result = await callBusinessApi('aliexpress.ds.product.get', token, {
    product_id: id,
    ship_to_country: shipToCountry,
    target_currency: targetCurrency,
    target_language: targetLanguage,
    remove_personal_benefit: 'false',
  });
  // productMissing: callers that watch a product over time (jobs/stockMonitor.js) tell "this product is gone" from "AliExpress did not answer".
  if (!result || !result.ae_item_base_info_dto) throw Object.assign(new Error('AliExpress does not have that product.'), { statusCode: 404, productMissing: true });
  return result;
}

module.exports = { ensureToken, getProductDetail };
