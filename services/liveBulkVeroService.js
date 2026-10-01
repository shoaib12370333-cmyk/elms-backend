/**
 * Removes the seller's own VeRO (trademark/brand) words from many LIVE listings at once, and pushes each cleaned
 * title/description/item-specifics to eBay (services/ebayListingService.js reviseActiveListing) - unlike the Drafts
 * bulk VeRO button, which only ever saves ELMS's own copy (a draft has nothing live on eBay yet to update).
 */
const { createMatcher } = require('./veroService');
const { getVeroWordsOf } = require('./veroSettingsService');
const { cleanVeroTerms } = require('./veroCleanerService');
const { mapPool } = require('./bulkEditService');
const { getAiSettings } = require('../models/settingsModel');
const { hasCredits, spendCredit, refundCredit } = require('../models/usersModel');
const { ACTION_COSTS } = require('../config/actionCosts');
const AiUsage = require('../models/schemas/AiUsage');

const PARALLEL = 3; // one AI call + one eBay revise (two eBay round trips) per listing - modest, like liveBulkRestockService
const LIVE_STATUSES = ['published', 'sold']; // still live on eBay; a sold-out listing is "live in principle" (models/schemas/Listing.js)

// Replaceable for tests.
const deps = {
  revise: (refreshToken, args) => require('./ebayListingService').reviseActiveListing(refreshToken, args),
};

/** Only the item-specific values that actually changed - eBay only needs to be told what's different. */
function diffAspects(before, after) {
  const changed = {};
  for (const [name, values] of Object.entries(after || {})) {
    if (JSON.stringify(values) !== JSON.stringify((before || {})[name])) changed[name] = values;
  }
  return changed;
}

/**
 * @param {{ userId: string, ids: string[] }} args
 * @returns {Promise<{
 *   results: Array<{ id, title, status: 'changed'|'clean'|'skipped'|'failed'|'no_credits', reason?, removed? }>,
 *   summary: { changed: number, clean: number, skipped: number, failed: number, no_credits: number }
 * }>}
 * clean = already had no VeRO words (nothing to do, not a problem); skipped = could not even be tried (not found, no
 * eBay offer, no connected account); failed = tried, but the AI or eBay refused.
 */
async function bulkVeroCleanLive({ userId, ids }, d) {
  const settings = await getAiSettings();
  if (!settings.aiTitleEnabled) {
    const err = new Error('This AI feature is turned off by the administrator.');
    err.statusCode = 403;
    throw err;
  }
  const words = await getVeroWordsOf(userId);
  const vero = createMatcher(words);
  const cost = Number(ACTION_COSTS.AI_TITLE || 0);

  const found = await d.getListingsByIds(userId, ids);
  const tokens = new Map();
  const tokenFor = async (accountId) => {
    if (!tokens.has(accountId)) tokens.set(accountId, Promise.resolve(d.getRefreshToken(userId, accountId)).catch(() => null));
    return tokens.get(accountId);
  };

  const results = new Array(ids.length);
  await mapPool(ids, PARALLEL, async (id, index) => {
    const l = found.get(String(id));
    const title = l ? (l.title || l.sku || id) : null;
    const mark = (status, reason) => { results[index] = { id, title, status, reason }; };
    if (!l) return mark('skipped', 'Not found.');
    if (!LIVE_STATUSES.includes(String(l.status || '').toLowerCase())) return mark('skipped', 'Only a live (or sold-out) listing can be cleaned here. A draft is cleaned from the Drafts page.');
    if (!l.ebay_offer_id || !l.sku) return mark('skipped', 'This listing has no eBay offer to update.');
    if (!l.ebay_account_id) return mark('skipped', 'No eBay account is connected to this listing.');

    const scan = vero.scanListing({ title: l.title, description: l.description, aspects: l.ebay_aspects });
    if (!scan.terms.length) return mark('clean', 'No VeRO words found.');

    const refreshToken = await tokenFor(l.ebay_account_id);
    if (!refreshToken) return mark('skipped', 'The connected eBay account is missing its connection. Reconnect it in Settings.');

    if (!((await hasCredits(userId, cost)) && (await spendCredit(userId, cost)))) return mark('no_credits', `Not enough credits (needs ${cost}).`);

    let cleaned;
    try {
      cleaned = await cleanVeroTerms({ title: l.title, description: l.description, aspects: l.ebay_aspects || {} }, words);
    } catch (err) {
      await refundCredit(userId, cost);
      AiUsage.create({ userId, kind: 'vero', ok: false, credits: 0 }).catch(() => {});
      return mark('failed', err.message || 'The AI request failed.');
    }
    const data = cleaned.data;
    if (!String(data.title || '').trim()) {
      await refundCredit(userId, cost);
      return mark('failed', 'The title is only a protected word. Open it and write a new title first.');
    }
    AiUsage.create({ userId, kind: 'vero', ok: true, credits: cost, model: cleaned.usage?.model, inputTokens: cleaned.usage?.inputTokens, outputTokens: cleaned.usage?.outputTokens }).catch(() => {});

    const aspects = diffAspects(l.ebay_aspects, data.aspects);
    try {
      await deps.revise(refreshToken, {
        offerId: l.ebay_offer_id,
        sku: l.sku,
        title: data.title,
        description: data.description,
        aspects: Object.keys(aspects).length ? aspects : undefined,
        sellPrice: l.sell_price,
        priceCurrency: l.currency,
        quantity: l.quantity,
        categoryId: l.category_id,
      });
    } catch (err) {
      await refundCredit(userId, cost);
      return mark('failed', err.message || 'eBay did not accept the cleaned listing.');
    }
    await d.updateListing(userId, id, { title: data.title, description: data.description, ebayAspects: { ...(l.ebay_aspects || {}), ...aspects } });
    results[index] = { id, title: data.title, status: 'changed', removed: data.removed || [] };
  });

  const count = (s) => results.filter((r) => r.status === s).length;
  return { results, summary: { changed: count('changed'), clean: count('clean'), skipped: count('skipped'), failed: count('failed'), no_credits: count('no_credits') } };
}

module.exports = { bulkVeroCleanLive, deps, LIVE_STATUSES };
