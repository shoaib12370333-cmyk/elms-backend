const axios = require('axios');

/**
 * CJdropshipping (developers.cjdropshipping.com) - a second, separate product source next to Amazon. Nothing in this file is
 * shared with the Amazon-facing services (canopyAmazonService, easyparserAmazonService): every seller's CJ account is their
 * own (their own API key, their own access/refresh tokens - see models/usersModel.js getCjCredentials/setCjCredentials), and
 * every call here goes to CJ's API only, never eBay's or Amazon's.
 *
 * Token mechanism (CJ docs -> Start -> Get Access-token): a seller's API key is exchanged once for an access token (life 180
 * days) and a refresh token (life 180 days); the access token is sent as the CJ-Access-Token header on every call and is
 * refreshed a day before it expires, never on every call (the token endpoint itself is rate-limited to 1 call/second, same as
 * everything else).
 *
 * Rate limit (CJ docs -> Start -> Interface Call Restrictions): a Free-tier account is limited to 1 request/second. This file
 * queues every call per CJ account (per user), spaced at least CJ_MIN_INTERVAL_MS apart, so ELMS never trips that limit -
 * whatever the seller's actual CJ plan.
 */

const BASE = 'https://developers.cjdropshipping.com/api2.0/v1';
const MIN_INTERVAL_MS = Number(process.env.CJ_MIN_INTERVAL_MS) || 1100; // > 1 request/second, the Free-tier limit
const REFRESH_MARGIN_MS = 24 * 60 * 60 * 1000; // refresh the access token a day before it actually expires

// One promise-chain queue per CJ account (keyed by userId, or userId+':auth' for the token endpoints, which have their own
// 1/second limit) - one seller's calls never wait behind another seller's, but a single seller's calls are always spaced out.
const queues = new Map(); // key -> { chain: Promise, last: number (ms) }

function runQueued(key, fn) {
  const q = queues.get(key) || { chain: Promise.resolve(), last: 0 };
  const run = q.chain.then(async () => {
    const wait = q.last + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    q.last = Date.now();
    return fn();
  });
  q.chain = run.catch(() => {}); // one failed call never breaks the queue for the calls behind it
  queues.set(key, q);
  return run;
}

async function cjFetch(path, { method = 'GET', token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['CJ-Access-Token'] = token;
  let res;
  try {
    res = await axios({ method, url: BASE + path, headers, data: body, timeout: 20000, validateStatus: () => true });
  } catch (err) {
    throw new Error('Could not reach CJdropshipping: ' + err.message);
  }
  const data = res.data;
  if (!data || typeof data !== 'object') throw new Error('CJdropshipping sent back something unexpected (HTTP ' + res.status + ').');
  if (data.result === false || (data.code && data.code !== 200)) {
    throw Object.assign(new Error(data.message || ('CJdropshipping error ' + (data.code ?? res.status))), { cjCode: data.code });
  }
  return data.data;
}

/** Exchanges a seller's own CJ API key for an access/refresh token pair (also how a pasted key is validated on Connect). */
async function getAccessToken(apiKey) {
  return cjFetch('/authentication/getAccessToken', { method: 'POST', body: { apiKey } });
}

async function refreshAccessToken(refreshToken) {
  return cjFetch('/authentication/refreshAccessToken', { method: 'POST', body: { refreshToken } });
}

/** Best effort only - Disconnect must succeed locally even if CJ's own logout call fails or times out. */
async function logout(token) {
  try {
    await cjFetch('/authentication/logout', { method: 'POST', token });
  } catch (err) {
    console.warn('[cj] logout call failed (disconnecting locally anyway):', err.message);
  }
}

/** A valid access token for this user, refreshing it first when it is near expiry. Throws (409) when CJ was never connected. */
async function ensureToken(userId) {
  const { getCjCredentials, setCjTokens } = require('../models/usersModel');
  const creds = await getCjCredentials(userId);
  if (!creds) throw Object.assign(new Error('CJdropshipping is not connected for this account.'), { statusCode: 409 });
  const expiresSoon = !creds.accessTokenExpiresAt || creds.accessTokenExpiresAt.getTime() - Date.now() < REFRESH_MARGIN_MS;
  if (!expiresSoon) return creds.accessToken;
  const refreshed = await runQueued(String(userId) + ':auth', () => refreshAccessToken(creds.refreshToken));
  await setCjTokens(userId, refreshed);
  return refreshed.accessToken;
}

/** Every ordinary (non-auth) CJ call goes through here: gets/refreshes the token, then runs on this user's queue. */
async function call(userId, path, opts = {}) {
  const token = await ensureToken(userId);
  return runQueued(String(userId), () => cjFetch(path, { ...opts, token }));
}

/** Connects a seller's own CJ account: validates the key by asking CJ for a token, then stores everything encrypted. Never logs, and never returns, the key or a token in plain text. */
async function connect(userId, apiKey) {
  const key = String(apiKey || '').trim();
  if (!key) throw new Error('Enter your CJdropshipping API key.');
  const tokens = await runQueued(String(userId) + ':auth', () => getAccessToken(key));
  const { setCjCredentials } = require('../models/usersModel');
  await setCjCredentials(userId, key, tokens);
  return { connectedAt: new Date() };
}

async function disconnect(userId) {
  const { getCjCredentials, clearCjCredentials } = require('../models/usersModel');
  const creds = await getCjCredentials(userId).catch(() => null);
  if (creds?.accessToken) await logout(creds.accessToken);
  await clearCjCredentials(userId);
}

/**
 * Keyword/category search of the CJ catalog ("Find products on CJ"), a light, already-normalized page - never the seller's
 * Amazon or eBay data, only what CJ returned. page 1.., size 1..100 (CJ's own limits).
 */
async function searchProducts(userId, { keyword = '', categoryId = null, page = 1, size = 20 } = {}) {
  const qs = new URLSearchParams();
  if (keyword) qs.set('keyWord', String(keyword).trim().slice(0, 200));
  if (categoryId) qs.set('categoryId', String(categoryId));
  qs.set('page', String(Math.min(1000, Math.max(1, Number(page) || 1))));
  qs.set('size', String(Math.min(100, Math.max(1, Number(size) || 20))));
  const data = await call(userId, '/product/listV2?' + qs.toString());
  const rows = (data?.content || []).flatMap((c) => c.productList || []);
  return {
    total: data?.totalRecords || 0,
    page: data?.pageNumber || Number(qs.get('page')),
    pages: data?.totalPages || 1,
    products: rows.map((p) => ({
      cjProductId: p.id,
      title: p.nameEn || null,
      image: p.bigImage || null,
      price: Number(p.sellPrice) || null,
      currency: 'USD',
      deliveryCycle: p.deliveryCycle || null,
      category: p.threeCategoryName || null,
      freeShipping: p.addMarkStatus === 1,
      inventory: p.warehouseInventoryNum ?? null,
    })),
  };
}

/** Full detail of one CJ product, every variant included (vid, SKU, price, inventory per country) - looked up by pid, CJ's own product SKU, or one variant's SKU. */
async function getProductDetail(userId, { pid, productSku, variantSku, countryCode } = {}) {
  const qs = new URLSearchParams();
  if (pid) qs.set('pid', String(pid));
  else if (productSku) qs.set('productSku', String(productSku));
  else if (variantSku) qs.set('variantSku', String(variantSku));
  else throw new Error('A CJ product id, product SKU or variant SKU is required.');
  if (countryCode) qs.set('countryCode', String(countryCode));
  const data = await call(userId, '/product/query?' + qs.toString());
  if (!data || !Array.isArray(data.variants) || !data.variants.length) throw new Error('CJdropshipping does not have that product.');
  return data;
}

/**
 * The cheapest CJ shipping quote for one variant into a country, in USD (services/cjAdapter.js calcFreight -> Listing.cjShippingCost,
 * used by the CJ import price and the CJ stock/price monitor). null when CJ has no shipping method for that lane rather than
 * throwing, so a quote failure skips repricing for this run instead of failing the whole check.
 */
async function calcFreight(userId, { vid, quantity = 1, startCountryCode = 'CN', endCountryCode }) {
  if (!vid) throw new Error('A CJ variant id is required to quote shipping.');
  if (!endCountryCode) throw new Error('A destination country is required to quote CJ shipping.');
  let quotes;
  try {
    quotes = await call(userId, '/logistic/freightCalculate', {
      method: 'POST',
      body: { startCountryCode, endCountryCode, products: [{ vid, quantity: Math.max(1, Number(quantity) || 1) }] },
    });
  } catch (err) {
    console.warn(`[cj] freight quote failed for ${vid} -> ${endCountryCode}: ${err.message}`);
    return null;
  }
  if (!Array.isArray(quotes) || !quotes.length) return null;
  const cheapest = quotes.reduce((min, q) => (Number(q.logisticPrice) < Number(min.logisticPrice) ? q : min), quotes[0]);
  const cost = Number(cheapest.logisticPrice);
  return Number.isFinite(cost) ? { cost, carrier: cheapest.logisticName || null, days: cheapest.logisticAging || null } : null;
}

module.exports = {
  getAccessToken,
  refreshAccessToken,
  connect,
  disconnect,
  ensureToken,
  searchProducts,
  getProductDetail,
  calcFreight,
  _runQueued: runQueued, // exported for tests only
  _queues: queues, // exported for tests only (asserting the queue never mixes two users, and resetting between tests)
};
