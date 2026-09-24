const axios = require('axios');
const { EBAY_API_BASE_URL } = require('../config/ebayEnvironment');
const { getMarketplaceConfig } = require('../config/ebayMarketplaces');

/**
 * What a product sells for on eBay right now: the public Browse API (eBay's search) asked with ELMS's own application token -
 * no seller account is involved and nothing is listed or changed. One search per product and marketplace, kept for a while,
 * and limited per day, so a busy day cannot use up ELMS's eBay quota.
 *
 * A search by barcode (GTIN) finds the same product; a search by title words finds similar ones, so the answer says which it was.
 */

const CACHE_TTL_MS = 20 * 60 * 1000;
const CACHE_MAX = 500;
const DAILY_BUDGET = Number(process.env.EBAY_MARKET_DAILY_BUDGET) || 3000;
const SEARCH_LIMIT = 50;
const QUERY_WORDS = 6;


const EBAY_HOST = /^https:\/\/([a-z0-9-]+\.)*ebay\.[a-z.]+\//i;
const clip = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
const round2 = (n) => Math.round(n * 100) / 100;

function fail(reason, message) {
  return { available: false, reason, message };
}

/** The words of a title that a buyer would type: no brackets, no separators, the first few. */
function keywordsOf(title) {
  const cleaned = String(title || '')
    .replace(/[([][^)\]]*[)\]]/g, ' ')
    .replace(/[|/,;:!?"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.split(' ').filter(Boolean).slice(0, QUERY_WORDS).join(' ');
}

/** A barcode as digits (8 to 14 of them), or null. */
function gtinOf(value) {
  const m = String(value == null ? '' : value).match(/\d{8,14}/);
  return m ? m[0] : null;
}

const median = (sorted) => {
  const n = sorted.length;
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
};

/** What buyers pay in total for one item (price + the delivery it says, when it says one). */
function totalOf(item) {
  const price = Number(item && item.price && item.price.value);
  if (!Number.isFinite(price) || price <= 0) return null;
  let ship = 0;
  const option = Array.isArray(item.shippingOptions) ? item.shippingOptions[0] : null;
  const cost = option && option.shippingCost && Number(option.shippingCost.value);
  if (Number.isFinite(cost) && cost > 0 && (!option.shippingCost.currency || option.shippingCost.currency === item.price.currency)) ship = cost;
  return { price, ship, total: price + ship, currency: item.price.currency };
}

/**
 * The numbers a seller wants from a page of search results.
 * Items in another currency are left out; when there are enough, prices far from the middle (accessories, lots of 20) are too.
 */
function summarize(data, currency, exact) {
  const items = (Array.isArray(data && data.itemSummaries) ? data.itemSummaries : [])
    .map((item) => ({ item, t: totalOf(item) }))
    .filter((x) => x.t && (!currency || x.t.currency === currency));
  let kept = items;
  if (items.length >= 8) {
    const mid = median(items.map((x) => x.t.total).sort((a, b) => a - b));
    kept = items.filter((x) => x.t.total >= mid * 0.35 && x.t.total <= mid * 3);
  }
  const total = Number.isFinite(Number(data && data.total)) ? Number(data.total) : items.length;
  if (!kept.length) return { available: true, exact, total, count: 0, currency, min: null, median: null, max: null, sellers: 0, cheapest: [] };
  const totals = kept.map((x) => x.t.total).sort((a, b) => a - b);
  const sellers = new Set(kept.map((x) => (x.item.seller && x.item.seller.username) || '').filter(Boolean));
  const cheapest = kept
    .slice()
    .sort((a, b) => a.t.total - b.t.total)
    .slice(0, 3)
    .map(({ item, t }) => ({
      title: clip(item.title, 90),
      price: round2(t.price),
      shipping: t.ship ? round2(t.ship) : 0,
      seller: clip(item.seller && item.seller.username, 60) || null,
      url: EBAY_HOST.test(String(item.itemWebUrl || '')) ? item.itemWebUrl : null,
    }));
  return { available: true, exact, total, count: kept.length, currency: currency || kept[0].t.currency, min: round2(totals[0]), median: round2(median(totals)), max: round2(totals[totals.length - 1]), sellers: sellers.size, cheapest };
}

function today() { return new Date().toISOString().slice(0, 10); }

/**
 * @param {{ getToken?: Function, http?: { get: Function }, now?: Function }} [deps] stand-ins for tests
 */
function createMarketService(deps = {}) {
  const cache = new Map();    // key -> { at, data }
  const inflight = new Map(); // key -> Promise (the same search asked twice at once is one call)
  const budget = { day: '', used: 0 };
  const dailyBudget = deps.dailyBudget || DAILY_BUDGET;
  const getToken = deps.getToken || (() => require('./ebayAuthService').getAppAccessToken());
  const http = deps.http || axios;
  const now = deps.now || Date.now;

  async function search(token, marketplaceId, query, filter) {
    const params = { limit: SEARCH_LIMIT, ...query };
    if (filter) params.filter = filter;
    const res = await http.get(`${EBAY_API_BASE_URL}/buy/browse/v1/item_summary/search`, {
      params,
      headers: { Authorization: `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': marketplaceId, Accept: 'application/json' },
      timeout: 15000,
    });
    return res.data;
  }

  async function lookup({ marketplaceId, title, gtin }) {
    const mp = getMarketplaceConfig(marketplaceId);
    if (!mp) return fail('unsupported', 'eBay prices are not available for this marketplace.');
    const code = gtinOf(gtin);
    const words = keywordsOf(title);
    if (!code && !words) return fail('no_query', 'The product has no title to search with.');

    let token;
    try {
      token = await getToken();
    } catch (_) {
      return fail('not_configured', 'eBay prices are not available right now.');
    }

    const attempts = code ? [{ gtin: code }, { q: words }] : [{ q: words }];
    const filters = ['buyingOptions:{FIXED_PRICE},conditions:{NEW}', 'buyingOptions:{FIXED_PRICE}', ''];
    for (const query of attempts) {
      if (!query.gtin && !query.q) continue;
      for (const filter of filters) {
        let data;
        try {
          data = await search(token, marketplaceId, query, filter);
        } catch (err) {
          const status = err && err.response && err.response.status;
          if (status === 400) {
            if (filter) continue; // this filter is not understood here: ask with less
            if (query.gtin && attempts.length > 1) break; // a barcode eBay does not take: the title words
          }
          if (status === 429) return fail('busy', 'eBay is busy right now. Try again in a few minutes.');
          return fail('unavailable', 'eBay prices could not be loaded right now.');
        }
        const summary = summarize(data, mp.currency, !!query.gtin);
        // A barcode that matches nothing falls back to the title words.
        if (query.gtin && summary.count === 0 && attempts.length > 1) break;
        return { ...summary, marketplaceId, query: query.gtin ? { gtin: query.gtin } : { q: query.q } };
      }
    }
    return { available: true, exact: false, total: 0, count: 0, currency: mp.currency, min: null, median: null, max: null, sellers: 0, cheapest: [], marketplaceId, query: { q: words } };
  }

  /** The market for one product on one marketplace: kept for 20 minutes, one search at a time per product, limited per day. */
  async function marketFor({ marketplaceId, title, gtin }) {
    const key = [String(marketplaceId || '').toUpperCase(), gtinOf(gtin) || keywordsOf(title).toLowerCase()].join('|');
    const hit = cache.get(key);
    if (hit && now() - hit.at < CACHE_TTL_MS) return hit.data;
    if (inflight.has(key)) return inflight.get(key);

    if (budget.day !== today()) { budget.day = today(); budget.used = 0; }
    if (budget.used >= dailyBudget) return fail('busy', 'eBay prices are used up for today. Try again tomorrow.');
    budget.used += 1;

    const run = lookup({ marketplaceId: String(marketplaceId || '').toUpperCase(), title, gtin })
      .then((data) => {
        if (data.available) {
          cache.set(key, { at: now(), data });
          if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
        }
        return data;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, run);
    return run;
  }

  return { marketFor, lookup };
}

const shared = createMarketService();

module.exports = { createMarketService, marketFor: shared.marketFor, summarize, keywordsOf, gtinOf, totalOf, DAILY_BUDGET };
