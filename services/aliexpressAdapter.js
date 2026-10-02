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

// ---------------------------------------------------------------------------------------------------------------------------
// Shipping quote (aliexpress.ds.freight.query, "Delivery/Freight API" - AE-Dropshipper). Shapes below are from AliExpress's own
// API reference page for it (openservice.aliexpress.com/doc/api.htm, 2026-10-03): ONE required parameter, `queryDeliveryReq`, an
// object sent as a JSON string (quantity, shipToCountry, productId, selectedSkuId, language, currency ...); the answer is
// { result: { msg, code: "200", success: "true", delivery_options: [ { code, company, shipping_fee_cent, shipping_fee_currency,
// shipping_fee_format, free_shipping, min_delivery_days, max_delivery_days, guaranteed_delivery_days, ship_from_country, tracking,
// ... } ] } } (callBusinessApi hands back the inner `result`). Its documented error codes are DELIVERY_NOT_AVAILABLE_TO_YOUR_ADDRESS
// and DELIVERY_INFO_EMPTY. NOT yet run against a real account.
// ---------------------------------------------------------------------------------------------------------------------------

// A shipping fee above this (in the requested currency) is not believed when AliExpress gave no price tag to check it against.
const MAX_BELIEVABLE_SHIPPING = 1000;

/** The number inside a price tag like "US $1.99" or "1,99 EUR", or null. */
function numberFromPriceTag(text) {
  if (typeof text !== 'string') return null;
  const m = text.replace(/\s/g, '').match(/-?\d[\d.,]*/);
  if (!m) return null;
  let t = m[0];
  if (t.includes(',') && !t.includes('.')) t = t.replace(',', '.'); // "1,99"
  else t = t.replace(/,/g, ''); // "1,299.50"
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

const asBool = (v) => v === true || String(v).toLowerCase() === 'true';
const asDays = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n) : null; };

/**
 * One delivery option's shipping fee in the major unit of its currency (dollars, not cents), or null when it cannot be trusted.
 * The field is named `shipping_fee_cent` but AliExpress's own sample shows "1.99" next to the price tag "US $1.99", i.e. dollars -
 * so it is read as dollars, and CROSS-CHECKED against the price tag: if they agree, fine; if the tag says 1.99 while the number says
 * 199 the number really was cents and the tag wins; any other disagreement is not guessed at. A factor of 100 on a shipping cost
 * would wreck every profit figure, which is why this is not left to the field name alone.
 */
function shippingFeeOf(option) {
  if (asBool(option.free_shipping)) return 0;
  // Only a real number or a non-blank numeric string is a fee: Number([]), Number(' ') and Number(false) are all 0, which would read as free shipping.
  const raw = option.shipping_fee_cent;
  const fee = typeof raw === 'number' ? raw : (typeof raw === 'string' && raw.trim() !== '' ? Number(raw.trim()) : null);
  const feeOk = fee !== null && Number.isFinite(fee) && fee >= 0;
  const shown = numberFromPriceTag(option.shipping_fee_format);
  if (feeOk && shown !== null) {
    if (Math.abs(fee - shown) < 0.01) return fee;
    if (Math.abs(fee / 100 - shown) < 0.01) return shown;
    return null;
  }
  if (feeOk) return fee <= MAX_BELIEVABLE_SHIPPING ? fee : null;
  return shown !== null && shown >= 0 ? shown : null;
}

/** AliExpress's delivery_options -> usable options in the requested currency only (a fee in another currency is never compared or stored). */
function usableDeliveryOptions(options, currency) {
  const want = String(currency || '').toUpperCase();
  return (Array.isArray(options) ? options : []).map((o) => {
    if (!o || typeof o !== 'object') return null;
    const optionCurrency = String(o.shipping_fee_currency || want).toUpperCase();
    if (want && optionCurrency !== want) return null;
    // An option AliExpress says has no stock to send it with is not a usable quote (a missing figure is fine - it is not always given).
    const stock = typeof o.available_stock === 'number' ? o.available_stock : (typeof o.available_stock === 'string' && o.available_stock.trim() !== '' ? Number(o.available_stock) : null);
    if (stock !== null && Number.isFinite(stock) && stock <= 0) return null;
    const cost = shippingFeeOf(o);
    if (cost === null) return null;
    return {
      cost: Number(cost.toFixed(2)),
      currency: optionCurrency || null,
      free: asBool(o.free_shipping),
      carrier: o.company ? String(o.company) : (o.code ? String(o.code) : null),
      code: o.code ? String(o.code) : null,
      minDays: asDays(o.min_delivery_days),
      maxDays: asDays(o.max_delivery_days),
      guaranteedDays: asDays(o.guaranteed_delivery_days),
      shipFrom: o.ship_from_country ? String(o.ship_from_country) : null,
      tracking: o.tracking === undefined || o.tracking === null ? null : asBool(o.tracking),
    };
  }).filter(Boolean);
}

/** The cheapest option; of equal price, the faster one (an option with no delivery time given sorts last). */
function cheapestOption(options) {
  return options.reduce((best, o) => {
    if (!best) return o;
    if (o.cost !== best.cost) return o.cost < best.cost ? o : best;
    return (o.maxDays ?? Infinity) < (best.maxDays ?? Infinity) ? o : best;
  }, null);
}

/**
 * The cheapest AliExpress shipping quote for ONE sku into a country, in the given currency - what the seller pays AliExpress to
 * send it (stored on the listing as Listing.aliexpressShippingCost and counted in its profit, like CJ's calcFreight). Returns
 * { cost, currency, free, carrier, minDays, maxDays, guaranteedDays, shipFrom, tracking, optionCount }, or null when there is no
 * usable quote (AliExpress cannot deliver there, no options, a fee in another currency, a failed call): like calcFreight it never
 * throws, so a quote problem skips the shipping figure instead of failing an import or a stock check.
 */
async function quoteShipping(userId, { productId, skuId, shipToCountry, currency = 'USD', quantity = 1 } = {}) {
  const pid = String(productId || '').trim();
  const sid = String(skuId || '').trim();
  if (!pid || !sid || !shipToCountry) return null;
  try {
    const token = await ensureToken(userId);
    const request = {
      quantity: String(Math.max(1, Math.trunc(Number(quantity)) || 1)),
      shipToCountry,
      productId: pid,
      selectedSkuId: sid,
      language: 'en_US',
      currency,
    };
    const answer = await callBusinessApi('aliexpress.ds.freight.query', token, { queryDeliveryReq: JSON.stringify(request) });
    const body = answer && answer.result && !answer.delivery_options ? answer.result : answer;
    if (!body || String(body.success).toLowerCase() === 'false') {
      console.warn(`[aliexpress] shipping quote refused for ${pid}/${sid} -> ${shipToCountry}: ${(body && (body.msg || body.code)) || 'no answer'}`);
      return null;
    }
    const usable = usableDeliveryOptions(body.delivery_options, currency);
    const best = cheapestOption(usable);
    if (!best) {
      console.warn(`[aliexpress] no usable shipping option for ${pid}/${sid} -> ${shipToCountry} (${Array.isArray(body.delivery_options) ? body.delivery_options.length : 0} returned).`);
      return null;
    }
    return { ...best, optionCount: usable.length };
  } catch (err) {
    console.warn(`[aliexpress] shipping quote failed for ${pid}/${sid} -> ${shipToCountry}: ${err.message}`);
    return null;
  }
}

module.exports = { ensureToken, getProductDetail, quoteShipping, _shippingFeeOf: shippingFeeOf, _usableDeliveryOptions: usableDeliveryOptions, _cheapestOption: cheapestOption };
