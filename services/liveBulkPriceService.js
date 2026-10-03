/**
 * Changes the price of many LIVE listings at once, on eBay and in ELMS.
 *
 * Speed: one listing the ordinary way is four eBay calls (read the offer, write it back, read both again to check). eBay's Inventory API changes the
 * price of up to 25 offers in ONE call (bulk_update_price_quantity), several of those calls run at the same time, and each price is checked with one read
 * of its offer, so 1000 listings are about 40 calls + 1000 reads instead of 4000 calls.
 * Safety: the price of each listing is worked out from its own Amazon price by the pricing rule (services/bulkEditService planPrice, the same
 * as for drafts). A price counts as taken only when eBay's answer (a FLAT list, see takenBy) says so for that very offer AND the offer, read back,
 * shows it. Anything else (the whole call fails, an offer is missing from the answer, an offer is refused, the price does not show) sends THAT
 * listing the ordinary way (updateOfferPrice), which either sets the price and checks it or fails with eBay's own words. ELMS keeps its copy in step
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
const VERIFY_PARALLEL = 5; // offers read back at the same time, per group
const CALL_TIMEOUT_MS = 60 * 1000;
const LIVE_STATUSES = ['published', 'active'];

const ok = (code) => Number(code) >= 200 && Number(code) < 300;
const cents = (v) => Math.round(Number(v) * 100 + 1e-9);

// Replaceable for tests.
const deps = {
  request: (...args) => listing.ebayRequest(...args),
  single: (refreshToken, offerId, price) => listing.updateOfferPrice(refreshToken, offerId, price),
  verify: (refreshToken, offerId, price, marketplaceId) => listing.verifyOfferPrice(refreshToken, offerId, price, { marketplaceId }),
  convert: (amount, from, to) => convertAmount(amount, from, to),
};

/**
 * Is this offer's price taken, according to eBay's answer to the bulk call? eBay answers with a FLAT list, one entry per offer updated:
 * { responses: [{ sku, offerId, statusCode, errors?, warnings? }] } (its API reference, PriceQuantityResponse). The first version of this service
 * looked for answer.offers[] inside each entry, which eBay never sends, so no price was ever believed and every one went the ordinary way (production
 * log, 2026-10-03: "0 in bulk" on every run). Believed only when there is an entry for this very offer, and every entry of its SKU is a 2xx without errors.
 */
function takenBy(res, item) {
  const entries = (res && Array.isArray(res.responses) ? res.responses : []).filter((r) => r && String(r.sku) === String(item.sku));
  const mine = entries.filter((r) => String(r.offerId) === String(item.offerId));
  return mine.length > 0 && entries.every((r) => ok(r.statusCode) && !(Array.isArray(r.errors) && r.errors.length));
}

/**
 * Asks eBay for the new prices of listings of ONE store and marketplace with the bulk call (up to 25 offers). Returns the items eBay's answer says it took.
 * If the call as a whole fails (eBay's reference says both "up to 25" and "only one SKU per call"), each listing is tried in a call of its own before it is
 * given up to the ordinary way. A reason eBay gave, or an answer that cannot be read, is logged once per group.
 */
async function askBulk(refreshToken, marketplaceId, currency, items) {
  const send = (list) => deps.request(refreshToken, 'POST', '/sell/inventory/v1/bulk_update_price_quantity', {
    requests: list.map((i) => ({ sku: i.sku, offers: [{ offerId: i.offerId, price: { value: i.price.toFixed(2), currency } }] })),
  }, { marketplaceId, deadlineAt: Date.now() + CALL_TIMEOUT_MS, maxTimeoutMs: CALL_TIMEOUT_MS, timeoutMessage: 'eBay timed out while changing a group of prices.' });
  const answered = []; // [list of items, eBay's answer]
  try {
    answered.push([items, await send(items)]);
  } catch (err) {
    // One listing per call only when the refusal could be about the GROUP (a 400 "only one SKU per call", a 5xx, a timeout). A refused login (401/403) or
    // eBay saying slow down (429) is not helped by smaller calls. And three failures in a row end the tries (a dead endpoint or token costs a few calls, not
    // one per listing); the rest go the ordinary way.
    const worthTrying = items.length > 1 && ![401, 403, 429].includes(Number(err.statusCode));
    console.warn(`[bulk-price] the call for ${items.length} listing(s) failed (${err.message})${worthTrying ? '; trying one listing per call' : ''}`);
    if (worthTrying) {
      let inARow = 0;
      await mapPool(items, 3, async (item) => {
        if (inARow >= 3) return;
        try { answered.push([[item], await send([item])]); inARow = 0; } catch (e) { inARow += 1; /* this one goes the ordinary way */ }
      });
    }
  }
  const taken = [];
  for (const [list, res] of answered) {
    const before = taken.length;
    for (const item of list) if (takenBy(res, item)) taken.push(item);
    if (taken.length === before) console.warn(`[bulk-price] eBay took none of ${list.length} price(s) in its answer: ${JSON.stringify(res).slice(0, 300)}`);
  }
  return taken;
}

/**
 * Puts the new prices on eBay for listings of ONE store and marketplace. Returns a Map: listing id -> { ok: true } | { ok: false, error }.
 * A price is "in bulk" only when eBay's answer says it took it AND the offer, read back, shows it (verifyOfferPrice); everything else, and anything
 * unusual, goes the ordinary way (updateOfferPrice), which sets the price and checks it or fails with eBay's own words.
 */
async function pushChunk(refreshToken, marketplaceId, items, stats) {
  const out = new Map();
  const currency = (getMarketplaceConfig(marketplaceId) || {}).currency;
  const toSingle = [];
  const taken = currency ? await askBulk(refreshToken, marketplaceId, currency, items) : [];
  const takenIds = new Set(taken.map((i) => i.id));
  for (const item of items) if (!takenIds.has(item.id)) toSingle.push(item);
  await mapPool(taken, VERIFY_PARALLEL, async (item) => {
    let seen = false;
    try { seen = await deps.verify(refreshToken, item.offerId, item.price, marketplaceId); } catch (err) { seen = false; }
    if (seen) { out.set(item.id, { ok: true }); stats.bulk += 1; } else { toSingle.push(item); stats.unverified += 1; }
  });
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
  const stats = { bulk: 0, single: 0, failed: 0, unverified: 0 };
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
    console.log('[bulk-price] ' + push.length + ' prices for eBay in ' + chunks.length + ' group(s): ' + stats.bulk + ' in bulk, ' + stats.single + ' one by one, ' + stats.failed + ' refused (' + stats.unverified + ' that eBay said it took could not be read back and went one by one).');
  }
  return { results, summary: { changed: count('changed'), unchanged: count('unchanged'), skipped: count('skipped') } };
}

module.exports = { bulkLivePrice, deps, CHUNK, LIVE_STATUSES };
