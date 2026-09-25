const { ebayAppGet } = require('./ebayRestClient');

const CACHE_MS = 60 * 1000;
let cache = null; // { at, rows }

/**
 * eBay's own numbers for how much of each daily API allowance ELMS has used (Analytics API, getRateLimits). It answers for every
 * RESTful API and the old Trading API, as the application (an application token; no seller has to reconnect).
 * Turns the nested answer into one flat row per limit, busiest first.
 *
 * @returns {Array<{ apiContext: string, apiName: string, apiVersion: string|null, resource: string, count: number|null,
 *   limit: number, remaining: number|null, used: number, percent: number, reset: string|null, windowSeconds: number|null }>}
 */
function parseRateLimits(data) {
  const rows = [];
  for (const api of Array.isArray(data?.rateLimits) ? data.rateLimits : []) {
    for (const resource of Array.isArray(api.resources) ? api.resources : []) {
      for (const rate of Array.isArray(resource.rates) ? resource.rates : []) {
        const limit = Number(rate.limit);
        if (!Number.isFinite(limit) || limit <= 0) continue;
        const remaining = Number.isFinite(Number(rate.remaining)) && rate.remaining !== null ? Number(rate.remaining) : null;
        const count = Number.isFinite(Number(rate.count)) && rate.count !== null && rate.count !== undefined ? Number(rate.count) : null;
        // "used" comes from the count when eBay sends it, otherwise from what is left of the limit
        const used = count !== null ? count : (remaining !== null ? Math.max(0, limit - remaining) : 0);
        rows.push({
          apiContext: String(api.apiContext || ''),
          apiName: String(api.apiName || ''),
          apiVersion: api.apiVersion ? String(api.apiVersion) : null,
          resource: String(resource.name || ''),
          count,
          limit,
          remaining,
          used,
          percent: Math.min(100, Math.round((used / limit) * 100)),
          reset: rate.reset || null,
          windowSeconds: Number.isFinite(Number(rate.timeWindow)) ? Number(rate.timeWindow) : null,
        });
      }
    }
  }
  return rows.sort((a, b) => b.used / b.limit - a.used / a.limit);
}

/** Today's eBay call usage of the whole application, cached for a minute (this call has its own daily allowance too). */
async function fetchRateLimits({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.rows;
  const rows = parseRateLimits(await ebayAppGet('/developer/analytics/v1_beta/rate_limit/'));
  cache = { at: Date.now(), rows };
  return rows;
}

function clearRateLimitCache() { cache = null; }

module.exports = { fetchRateLimits, parseRateLimits, clearRateLimitCache };
