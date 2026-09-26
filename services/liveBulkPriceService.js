/**
 * Changes the price of many LIVE listings at once, on eBay and in ELMS.
 *
 * Speed: one listing the ordinary way is two eBay calls (read the offer, write it back). eBay's Inventory API changes the price of up to
 * 25 offers in ONE call (bulk_update_price_quantity), and several of those calls run at the same time, so 1000 listings are about 40 calls.
 * Safety: the price of each listing is worked out from its own Amazon price by the pricing rule (services/bulkEditService planPrice, the same
 * as for drafts). Anything unusual in eBay's answer (the whole call fails, an offer is missing from the answer, an offer is refused) sends
 * THAT listing the ordinary way (updateOfferPrice), which either sets the price or fails with eBay's own words. ELMS keeps its copy in step
 * only for a price eBay took. A listing that cannot be changed is skipped with the reason; nothing is half-done.
 */
const listing = require('./ebayListingService');
const { planPrice, mapPool } = require('./bulkEditService');
const { getMarketplaceConfig } = require('../config/ebayMarketplaces');
const { sourceCurrency } = require('../config/amazonDomains');
const { convertAmount } = require('./currencyService');

const CHUNK = 25; // eBay's limit per bulk call
const CALLS_AT_ONCE = 4; // bulk calls running at the same time
const PLAN_PARALLEL = 20; // listings prepared / saved at the same time
const CALL_TIMEOUT_MS = 60 * 1000;
const LIVE_STATUSES = ['published', 'active'];

const ok = (code) => Number(code) >= 200 && Number(code) < 300;
const cents = (v) => Math.round(Number(v) * 100 + 1e-9);

// Replaceable for tests.
const deps = {
  request: (...args) => listing.ebayRequest(...args),
  single: (refreshToken, offerId, price) => listing.updateOfferPrice(refreshToken, offerId, price),
  convert: (amount, from, to) => convertAmount(amount, from, to),
};

/**
 * Puts the new prices on eBay for listings of ONE store and marketplace. Returns a Map: listing id -> { ok: true } | { ok: false, error }.
 */
async function pushChunk(refreshToken, marketplaceId, items, stats) {
  const out = new Map();
  const currency = (getMarketplaceConfig(marketplaceId) || {}).currency;
  const toSingle = [];
  let answers = null;
  if (currency) {
    try {
      const res = await deps.request(refreshToken, 'POST', '/sell/inventory/v1/bulk_update_price_quantity', {
        requests: items.map((i) => ({ sku: i.sku, offers: [{ offerId: i.offerId, price: { value: i.price.toFixed(2), currency } }] })),
      }, { marketplaceId, deadlineAt: Date.now() + CALL_TIMEOUT_MS, maxTimeoutMs: CALL_TIMEOUT_MS, timeoutMessage: 'eBay timed out while changing a group of prices.' });
      answers = new Map();
      for (const r of (res && Array.isArray(res.responses) ? res.responses : [])) if (r && r.sku) answers.set(String(r.sku), r);
    } catch (err) {
      answers = null; // the whole call failed: every listing of it goes the ordinary way
    }
  }
  for (const item of items) {
    const answer = answers && answers.get(String(item.sku));
    const offer = answer && Array.isArray(answer.offers) ? answer.offers.find((o) => String(o.offerId) === String(item.offerId)) : null;
    if (offer && ok(offer.statusCode)) { out.set(item.id, { ok: true }); stats.bulk += 1; } else toSingle.push(item);
  }
  await mapPool(toSingle, 3, async (item) => {
    try { await deps.single(refreshToken, item.offerId, item.price); out.set(item.id, { ok: true }); stats.single += 1; } catch (err) { out.set(item.id, { ok: false, error: err.message || 'eBay did not accept the price.' }); stats.failed += 1; }
  });
  return out;
}

/**
 * @param {{ userId: string, ids: string[], changes: { price: object } }} args changes as validated by bulkEditService.validateChanges
 * @returns {Promise<{ results: Array<{ id, title, status: 'changed'|'unchanged'|'skipped', diff?: Array, reason?: string }>, summary: { changed: number, unchanged: number, skipped: number } }>}
 */
async function bulkLivePrice({ userId, ids, changes }, d) {
  const found = await d.getListingsByIds(userId, ids);
  const ctx = { userId, getImportById: d.getImportById };
  const tokens = new Map();
  const tokenFor = async (accountId) => {
    if (!tokens.has(accountId)) tokens.set(accountId, Promise.resolve(d.getRefreshToken(userId, accountId)).catch(() => null));
    return tokens.get(accountId);
  };

  const results = new Array(ids.length);
  const push = []; // listings whose price has to change on eBay
  // ---- 1. what each listing becomes ----
  await mapPool(ids, PLAN_PARALLEL, async (id, index) => {
    const skip = (title, reason) => { results[index] = { id, title, status: 'skipped', reason }; };
    try {
      const l = found.get(String(id));
      if (!l) return skip(null, 'Not found.');
      const title = l.title || l.sku || id;
      if (!LIVE_STATUSES.includes(String(l.status || '').toLowerCase())) return skip(title, 'Only live listings are changed here. A draft is changed with Bulk edit on the Drafts page.');
      if (!l.ebay_offer_id || !l.sku) return skip(title, 'This listing has no eBay offer to change.');
      if (!l.ebay_account_id) return skip(title, 'No eBay account is connected to this listing.');
      const refreshToken = await tokenFor(l.ebay_account_id);
      if (!refreshToken) return skip(title, 'The connected eBay account is missing its connection. Reconnect it in Settings.');
      const plan = await planPrice(l, changes, ctx);
      if (plan.error) return skip(title, plan.error);
      if (!plan.diff.length) return void (results[index] = { id, title, status: 'unchanged', diff: [] });
      const before = l.sell_price == null ? null : Number(l.sell_price);
      if (before !== null && cents(before) === cents(plan.fields.sellPrice)) { // the price is the same: only the rule kept with the listing changes (nothing to send to eBay)
        await d.updateListing(userId, id, { ...plan.fields, markDraftCustomized: false });
        return void (results[index] = { id, title, status: 'unchanged', diff: [] });
      }
      // The offer is in the store's currency; the price is in the Amazon site's. Converted when they differ (no exchange rate = this listing is skipped, never a number in the wrong currency).
      const marketplaceId = l.marketplace_id || 'EBAY_US';
      const storeCurrency = (getMarketplaceConfig(marketplaceId) || {}).currency || null;
      const fromCurrency = sourceCurrency(l.amazon_url, l.currency);
      let price = plan.fields.sellPrice;
      if (storeCurrency && fromCurrency && storeCurrency !== fromCurrency) {
        try { price = Number((await deps.convert(price, fromCurrency, storeCurrency)).amount); } catch (err) { return skip(title, 'The exchange rate ' + fromCurrency + ' to ' + storeCurrency + ' could not be loaded. Try again in a minute.'); }
      }
      if (!(price > 0)) return skip(title, 'The new price would be zero.');
      push.push({ index, id, title, sku: l.sku, offerId: l.ebay_offer_id, price, refreshToken, marketplaceId, plan });
    } catch (err) {
      skip(null, err.message || 'Could not change the price.');
    }
  });

  // ---- 2. eBay: 25 prices per call, several calls at once ----
  const stats = { bulk: 0, single: 0, failed: 0 };
  const groups = new Map();
  for (const item of push) {
    const key = item.refreshToken + '|' + item.marketplaceId;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const chunks = [];
  for (const items of groups.values()) for (let i = 0; i < items.length; i += CHUNK) chunks.push(items.slice(i, i + CHUNK));
  const answered = await mapPool(chunks, CALLS_AT_ONCE, async (chunk) => {
    try { return await pushChunk(chunk[0].refreshToken, chunk[0].marketplaceId, chunk, stats); } catch (err) { return new Map(chunk.map((i) => [i.id, { ok: false, error: err.message || 'eBay did not accept the price.' }])); }
  });
  const outcome = new Map();
  answered.forEach((m) => m.forEach((v, k) => outcome.set(k, v)));

  // ---- 3. ELMS keeps a copy of what eBay took ----
  await mapPool(push, PLAN_PARALLEL, async (item) => {
    const r = outcome.get(item.id);
    if (!r || !r.ok) { results[item.index] = { id: item.id, title: item.title, status: 'skipped', reason: 'eBay did not take the new price: ' + ((r && r.error) || 'no answer') }; return; }
    try {
      await d.updateListing(userId, item.id, { ...item.plan.fields, lastRepricedAt: new Date(), markDraftCustomized: false });
    } catch (err) {
      console.warn('[bulk-price] eBay has the new price of ' + item.sku + ' but ELMS could not save its copy: ' + err.message);
    }
    results[item.index] = { id: item.id, title: item.title, status: 'changed', diff: item.plan.diff };
  });

  const count = (s) => results.filter((r) => r.status === s).length;
  if (process.env.NODE_ENV !== 'test' && push.length) {
    console.log('[bulk-price] ' + push.length + ' prices for eBay in ' + chunks.length + ' group(s): ' + stats.bulk + ' in bulk, ' + stats.single + ' one by one, ' + stats.failed + ' refused.');
  }
  return { results, summary: { changed: count('changed'), unchanged: count('unchanged'), skipped: count('skipped') } };
}

module.exports = { bulkLivePrice, deps, CHUNK, LIVE_STATUSES };
