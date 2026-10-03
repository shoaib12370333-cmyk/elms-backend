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

// ---------------------------------------------------------------------------------------------------------------------------
// Placing and following an order (AE-Dropshipper). Shapes below are from AliExpress's own API reference pages (openservice.
// aliexpress.com/doc/api.htm, 2026-10-03): aliexpress.ds.order.create ("Create and Pay"), aliexpress.ds.order.afterpay,
// aliexpress.trade.ds.order.get and aliexpress.ds.order.tracking.get. NOT yet run against a real account.
// ---------------------------------------------------------------------------------------------------------------------------

const moneyOf = (v) => { const n = Number(v); return v !== null && v !== undefined && v !== '' && Number.isFinite(n) ? n : null; };

/**
 * aliexpress.ds.order.create's answer -> { orderIds }. Anything else throws an Error carrying `rejected`:
 *   rejected = true   AliExpress ANSWERED and refused (error_code / error_msg): nothing was placed - safe to correct and try again
 *   rejected = false  it is unclear (an empty answer, or "success" without an order number): the order MAY exist - the seller must look
 *                     at their AliExpress orders before trying again, or the same item is bought twice
 */
function parseCreateOrderAnswer(answer) {
  const body = answer && answer.result && answer.order_list === undefined ? answer.result : answer;
  const unclear = (message) => Object.assign(new Error(message), { rejected: false });
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw unclear('AliExpress sent back an empty answer. Check your AliExpress orders before trying again.');
  // An AliExpress order number is a long run of digits. null / 0 / 'null' / text are not numbers: such an entry is never stored as "the order".
  const listed = Array.isArray(body.order_list) ? body.order_list : [];
  const ids = listed.map((x) => String(x)).filter((x) => /^\d{6,}$/.test(x));
  const flagged = body.is_success !== undefined && body.is_success !== null;
  const success = flagged && asBool(body.is_success);
  if (success && ids.length && ids.length === listed.length) return { orderIds: ids };
  if (success) throw unclear('AliExpress said the order was created but did not give its number. Check your AliExpress orders before trying again.');
  // A REFUSAL needs evidence: AliExpress said, in so many words, that it did not succeed (is_success exactly false), gave no order number at
  // all, and gave a reason. Every other answer ({}, a missing flag, '' / 0 / 'no', an error_response of some other shape, a failure that still
  // lists an order number) is NOT proof that nothing was placed - and calling it a refusal lets the seller retry and buy the same item twice.
  const statedFalse = body.is_success === false || String(body.is_success).trim().toLowerCase() === 'false';
  if (statedFalse && !listed.length && (body.error_code || body.error_msg)) {
    throw Object.assign(new Error(body.error_msg || 'AliExpress did not create the order.'), { aliCode: String(body.error_code || 'ORDER_NOT_CREATED'), rejected: true });
  }
  throw unclear('AliExpress sent back an answer ELMS cannot read. Check your AliExpress orders before trying again.');
}

// Gateway error codes that mean the request was turned away BEFORE any order logic ran (signature, app key, session, parameters,
// permissions, call limit): nothing was placed. Any other gateway code - e.g. a "remote service error", which can come back after the
// order was already created - is unclear.
const PRE_DISPATCH_GATEWAY_CODES = /^(IncompleteSignature|InvalidSignature|InvalidAppKey|InvalidApp|MissingAppKey|MissingParameter|InvalidParameter|InvalidApiPath|IllegalAccessToken|InvalidAccessToken|InvalidSession|AccessTokenExpired|InsufficientPermission|AppApiCallLimit|ApiCallLimit|AUTH_TYPE_UNSUPPORTED)$/i;

/**
 * Places ONE AliExpress order (not paid yet: payment.try_to_pay is "false", the seller pays as a separate, confirmed step - payOrder).
 * @param {{ items: Array<{ productId, skuAttr?, quantity, logisticsServiceName }>, address: object, outOrderId?: string, payCurrency?: string }} order
 *   address = the object aliexpress.ds.order.create calls logistics_address (contact_person, full_name, address, address2, city, province, zip, country, mobile_no, phone_country, locale)
 * @returns {Promise<{ orderIds: string[] }>} or throws - see parseCreateOrderAnswer for what `err.rejected` means
 */
async function createOrder(userId, { items, address, outOrderId, payCurrency } = {}) {
  if (!Array.isArray(items) || !items.length) throw Object.assign(new Error('Nothing to order.'), { rejected: true });
  let token;
  try { token = await ensureToken(userId); } catch (err) { err.rejected = true; throw err; } // never connected / token refresh failed: nothing was sent
  const request = {
    product_items: items.map((i) => ({
      product_id: String(i.productId),
      product_count: String(i.quantity),
      logistics_service_name: i.logisticsServiceName,
      ...(i.skuAttr ? { sku_attr: i.skuAttr } : {}),
    })),
    logistics_address: address,
    ...(outOrderId ? { out_order_id: String(outOrderId) } : {}),
  };
  const extend = { payment: { try_to_pay: 'false', ...(payCurrency ? { pay_currency: payCurrency } : {}) } };
  let answer;
  try {
    answer = await callBusinessApi('aliexpress.ds.order.create', token, {
      param_place_order_request4_open_api_d_t_o: JSON.stringify(request),
      ds_extend_request: JSON.stringify(extend),
    });
  } catch (err) {
    // A gateway refusal of the kinds listed above is certain: nothing was placed. Any other gateway code, and no answer at all (a network
    // failure, a timeout), is unclear: the order may have been placed, so `rejected` stays unset.
    if (err.aliCode && PRE_DISPATCH_GATEWAY_CODES.test(String(err.aliCode))) err.rejected = true;
    throw err;
  }
  return parseCreateOrderAnswer(answer);
}

/**
 * Pays an order that was created unpaid (aliexpress.ds.order.afterpay).
 * @returns {Promise<{ paid: boolean, message: string|null }>} paid:false = AliExpress ANSWERED that it did not take the payment (a stated no)
 * Throws an Error carrying `rejected`: true = the request was turned away before any payment logic ran (not connected, signature, session,
 * permissions) so nothing was paid; otherwise (no answer, an answer ELMS cannot read) it is unclear whether the payment went through.
 */
async function payOrder(userId, aeOrderId) {
  let token;
  try { token = await ensureToken(userId); } catch (err) { err.rejected = true; throw err; } // never connected / token refresh failed: nothing was sent
  let answer;
  try {
    answer = await callBusinessApi('aliexpress.ds.order.afterpay', token, { req: JSON.stringify({ order_id: String(aeOrderId) }) });
  } catch (err) {
    if (err.aliCode && PRE_DISPATCH_GATEWAY_CODES.test(String(err.aliCode))) err.rejected = true;
    throw err;
  }
  if (answer === true || String(answer).toLowerCase() === 'true') return { paid: true, message: null };
  if (answer === false || String(answer).toLowerCase() === 'false') return { paid: false, message: null };
  // A "no" needs evidence, like a refusal at order creation: an explicit false flag, or a response code that is present and is not a success
  // code. A message alone proves nothing ({ rsp_code: '200', rsp_msg: 'success' } and { success: true, msg: 'ok' } carry messages too).
  if (answer && typeof answer === 'object' && !Array.isArray(answer)) {
    const message = answer.rsp_msg || answer.msg || null;
    const code = answer.rsp_code !== undefined && answer.rsp_code !== null ? String(answer.rsp_code).trim() : '';
    const flags = [answer.success, answer.is_success].filter((v) => v !== undefined && v !== null);
    const statedFalse = flags.length > 0 && flags.every((v) => v === false || String(v).trim().toLowerCase() === 'false');
    // ...and a code that says the SYSTEM failed (5xx, timeout, busy, internal error, unknown) is not a decline either: the payment may still be processing.
    const failureCode = code !== '' && !/^(0|200|10000|ok|success)$/i.test(code) && !/^(5\d\d|.*(system|time.?out|internal|busy|unknown|unavailable|retry|error).*)$/i.test(code);
    if ((statedFalse || failureCode) && !flags.some((v) => v === true || String(v).trim().toLowerCase() === 'true')) return { paid: false, message: message ? String(message) : null };
  }
  // Nothing in the answer says whether the payment happened ({}, nothing, a success-shaped object, something else): not a "no".
  throw Object.assign(new Error('AliExpress sent back an answer ELMS cannot read. Check the order on AliExpress before paying again.'), { rejected: false });
}

/** An aliexpress.trade.ds.order.get answer, reduced to what ELMS shows: status, total, whether/when it was paid, the shipments' numbers. null when there is nothing. */
function normalizeOrderDetail(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const total = raw.order_amount || raw.user_order_amount || {};
  return {
    status: raw.order_status ? String(raw.order_status) : null,
    logisticsStatus: raw.logistics_status ? String(raw.logistics_status) : null,
    amount: moneyOf(total.amount),
    currency: total.currency_code ? String(total.currency_code).toUpperCase() : null,
    paidAt: raw.order_paidtime_string ? String(raw.order_paidtime_string) : null,
    createdAt: raw.gmt_create ? String(raw.gmt_create) : null,
    payTimeoutSeconds: asDays(raw.pay_timeout_second),
    logistics: (Array.isArray(raw.logistics_info_list) ? raw.logistics_info_list : [])
      .map((l) => ({ service: l && l.logistics_service ? String(l.logistics_service) : null, number: l && l.logistics_no ? String(l.logistics_no) : null }))
      .filter((l) => l.number),
    lines: (Array.isArray(raw.child_order_list) ? raw.child_order_list : []).map((c) => ({
      productId: c && c.product_id ? String(c.product_id) : null,
      skuId: c && c.sku_id ? String(c.sku_id) : null,
      quantity: moneyOf(c && c.product_count),
      endReason: c && c.end_reason ? String(c.end_reason) : null,
    })),
  };
}

/** One order's current state at AliExpress (aliexpress.trade.ds.order.get). @returns {Promise<object|null>} see normalizeOrderDetail */
async function getOrderDetail(userId, aeOrderId) {
  const token = await ensureToken(userId);
  const answer = await callBusinessApi('aliexpress.trade.ds.order.get', token, { single_order_query: JSON.stringify({ order_id: String(aeOrderId) }) });
  return normalizeOrderDetail(answer);
}

/** The shipments of an order (aliexpress.ds.order.tracking.get): [{ trackingNumber, carrier, etaMs, lastEvent }], [] while there is none yet. */
async function getOrderTracking(userId, aeOrderId) {
  const token = await ensureToken(userId);
  const answer = await callBusinessApi('aliexpress.ds.order.tracking.get', token, { ae_order_id: String(aeOrderId), language: 'en_US' });
  const body = answer && answer.data === undefined && answer.result ? answer.result : answer;
  const lines = body && body.data && Array.isArray(body.data.tracking_detail_line_list) ? body.data.tracking_detail_line_list : [];
  return lines.map((l) => {
    const nodes = Array.isArray(l && l.detail_node_list) ? l.detail_node_list : [];
    const last = nodes.slice().sort((a, b) => Number(b.time_stamp) - Number(a.time_stamp))[0];
    const eta = Number(l && l.eta_time_stamps);
    return {
      trackingNumber: l && l.mail_no ? String(l.mail_no) : null,
      carrier: (l && (l.carrier_name || l.cp_name)) ? String(l.carrier_name || l.cp_name) : null,
      etaMs: Number.isFinite(eta) && eta > 0 ? eta : null,
      lastEvent: last && last.tracking_detail_desc ? String(last.tracking_detail_desc) : null,
    };
  }).filter((x) => x.trackingNumber);
}

module.exports = {
  ensureToken, getProductDetail, quoteShipping, createOrder, payOrder, getOrderDetail, getOrderTracking,
  _shippingFeeOf: shippingFeeOf, _usableDeliveryOptions: usableDeliveryOptions, _cheapestOption: cheapestOption,
  _parseCreateOrderAnswer: parseCreateOrderAnswer, _normalizeOrderDetail: normalizeOrderDetail,
};
