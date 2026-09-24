const { getListingById, updateListing } = require('../models/listingsModel');
const { getImportById } = require('../models/importsModel');
const { getEbayAccountById } = require('../models/ebayAccountsModel');
const { getItemAspectsForCategory, suggestCategories } = require('./ebayTaxonomyService');
const { fillItemSpecifics } = require('./aspectFillerService');
const { checkAspects } = require('./publishPreflightService');
const { withCredits } = require('./creditService');
const { ACTION_COSTS } = require('../config/actionCosts');
const AiUsage = require('../models/schemas/AiUsage');

// item specifics as { name: [values] } whatever shape they were saved in
const asLists = (obj) => {
  const out = {};
  for (const [name, v] of Object.entries(obj && typeof obj === 'object' ? obj : {})) {
    const vals = (Array.isArray(v) ? v : [v]).map((x) => String(x ?? '').trim()).filter(Boolean);
    if (vals.length) out[name] = vals;
  }
  return out;
};

async function marketplaceOf(userId, listing) {
  if (listing.marketplace_id) return listing.marketplace_id;
  if (listing.ebay_account_id) {
    const account = await getEbayAccountById(userId, listing.ebay_account_id).catch(() => null);
    if (account && account.marketplaceId) return account.marketplaceId;
  }
  return 'EBAY_US';
}

/**
 * AI fills the eBay item specifics of ONE draft and saves them, so publishing does not stop on a missing specific.
 *  - picks eBay's suggested category first when the draft has none,
 *  - never overwrites what the seller already typed,
 *  - runs the SAME checks publishing runs (values matched to eBay's list, "Does not apply" / "Unbranded" where eBay accepts it)
 *    before saving, so what is saved is what eBay accepts,
 *  - a required specific that nothing can fill is reported by name (missing), not left for the publish to fail on.
 * Costs ACTION_COSTS.AI_ASPECTS credits (whatever the admin set) - charged first, given back when the AI or the save fails.
 * A draft that cannot be filled at all (no category, not a draft...) is skipped, and one where the AI adds nothing new is
 * not charged: only a draft that really got new specifics costs credits.
 *
 * @returns {Promise<{ id, title, status: 'filled'|'nothing'|'skipped'|'failed'|'no_credits', filled?, missing?, reason?, categoryId?, creditsUsed }>}
 */
async function fillDraftAspects(userId, id) {
  const skip = (title, reason) => ({ id, title, status: 'skipped', reason, creditsUsed: 0 });
  const listing = await getListingById(userId, id);
  if (!listing) return skip(null, 'Not found.');
  const title = listing.title || listing.sku || id;
  if (!['draft', 'error'].includes(listing.status)) return skip(title, 'Only drafts can be filled here.');
  if (String(listing.title || '').trim().length < 3) return skip(title, 'This draft has no title yet.');

  const marketplaceId = await marketplaceOf(userId, listing);
  let categoryId = listing.category_id || null;
  let categoryName = '';
  let pickedCategory = false;
  if (!categoryId) {
    try {
      const top = (await suggestCategories(null, listing.title, marketplaceId)).topSuggestion;
      if (top && top.categoryId) { categoryId = String(top.categoryId); categoryName = top.categoryName || ''; pickedCategory = true; }
    } catch (err) {
      return skip(title, 'No eBay category is set and eBay could not suggest one (' + err.message + ').');
    }
    if (!categoryId) return skip(title, 'No eBay category is set and eBay had no suggestion. Choose one in the editor.');
  }

  let defs;
  try {
    defs = (await getItemAspectsForCategory(null, categoryId, marketplaceId)).aspects || [];
  } catch (err) {
    return skip(title, err.statusCode === 404 || err.statusCode === 400 ? 'eBay does not know category ' + categoryId + ' on ' + marketplaceId + '. Pick the category again in the editor.' : 'eBay\'s item specifics could not be loaded (' + err.message + '). Try again in a minute.');
  }
  if (!defs.length) return skip(title, 'This eBay category has no item specifics to fill.');

  let product = null;
  if (listing.import_id) {
    const record = await getImportById(userId, listing.import_id).catch(() => null);
    product = record ? record.product : null;
  }
  const facts = {
    title: listing.title,
    description: listing.description || (product && product.description) || '',
    bulletPoints: (Array.isArray(listing.bullet_points) && listing.bullet_points.length ? listing.bullet_points : product && product.bulletPoints) || [],
    specifications: (Array.isArray(listing.specifications) && listing.specifications.length ? listing.specifications : product && product.specifications) || [],
  };
  const existing = asLists(listing.ebay_aspects && Object.keys(listing.ebay_aspects).length ? listing.ebay_aspects : product && product.ebayAspects);
  const cost = Number(ACTION_COSTS.AI_ASPECTS || 0);

  try {
    const out = await withCredits(userId, cost, async () => {
      const ai = await fillItemSpecifics({ ...facts, categoryName, aspects: defs, existing });
      const merged = { ...existing, ...ai.data.values };
      const checked = await checkAspects({ categoryId, marketplaceId, product: { ...facts, ebayAspects: merged }, aspectsOnly: true });
      const final = checked.aspects || merged;
      const changed = JSON.stringify(final) !== JSON.stringify(existing);
      if (!changed) {
        // The AI found nothing to add: no specifics are saved, so nothing is charged (withCredits gives the credit back).
        if (pickedCategory) await updateListing(userId, id, { categoryId });
        const nothing = new Error('Nothing new to fill.');
        nothing.nothingToFill = true;
        nothing.missing = checked.missing;
        throw nothing;
      }
      await updateListing(userId, id, { ebayAspects: final, ...(pickedCategory ? { categoryId } : {}) });
      return { ai, missing: checked.missing, filled: Object.keys(final).filter((k) => !existing[k]).length };
    });
    AiUsage.create({ userId, kind: 'aspects', ok: true, credits: cost, model: out.ai.usage?.model, inputTokens: out.ai.usage?.inputTokens, outputTokens: out.ai.usage?.outputTokens }).catch(() => {});
    return { id, title, status: 'filled', filled: out.filled, missing: out.missing, categoryId: pickedCategory ? categoryId : undefined, creditsUsed: cost };
  } catch (err) {
    if (err.nothingToFill) return { id, title, status: 'nothing', filled: 0, missing: err.missing || [], creditsUsed: 0 };
    if (err.outOfCredits) return { id, title, status: 'no_credits', reason: err.message, creditsUsed: 0 };
    AiUsage.create({ userId, kind: 'aspects', ok: false, credits: 0 }).catch(() => {});
    console.error('[bulk-aspects]', id, err.message);
    return { id, title, status: 'failed', reason: err.message || 'The AI request failed.', creditsUsed: 0 };
  }
}

/**
 * The editor's "Fill with AI" button: the same AI fill, then the same checks publishing runs, so the values that appear in the
 * boxes are ones eBay accepts (a required specific gets "Does not apply" / "Unbranded" where eBay allows it, a value that is not
 * on eBay's list is dropped) and the names still empty afterwards come back in data.missing. With a categoryId the whole list of
 * allowed values is loaded here (the editor only holds the first 100 of each).
 */
async function fillEditorAspects({ title, description, bulletPoints, specifications, categoryName, aspects, existing, categoryId, marketplaceId }) {
  let defs = aspects;
  if (categoryId && marketplaceId) {
    try { defs = (await getItemAspectsForCategory(null, categoryId, marketplaceId)).aspects || aspects; } catch (_) { defs = aspects; }
  }
  const have = asLists(existing);
  const out = await fillItemSpecifics({ title, description, bulletPoints, specifications, categoryName, aspects: defs, existing: have });
  if (!categoryId || !marketplaceId) return out;
  try {
    const checked = await checkAspects({ categoryId, marketplaceId, product: { title, description, bulletPoints, specifications, ebayAspects: { ...have, ...out.data.values } }, aspectsOnly: true });
    if (checked.aspects) {
      const values = {};
      for (const [name, vals] of Object.entries(checked.aspects)) if (!have[name]) values[name] = vals;
      out.data = { values, filled: Object.keys(values).length, missing: checked.missing };
      out.text = JSON.stringify(values);
    }
  } catch (_) { /* the check is a bonus: the plain AI answer still stands */ }
  return out;
}

/**
 * Fills the item specifics of several drafts, a few at a time. Each draft that is actually filled costs the admin-set
 * AI_ASPECTS credits, so 10 drafts at 1 credit = 10 credits and at 2 credits = 20. When the balance runs out the rest are
 * not attempted and cost nothing.
 */
async function fillManyDraftAspects(userId, ids, { concurrency = 3 } = {}) {
  const results = new Array(ids.length);
  let next = 0;
  let broke = false;
  const worker = async () => {
    while (next < ids.length) {
      const at = next++;
      if (broke) { results[at] = { id: ids[at], title: null, status: 'no_credits', reason: 'Not enough credits.', creditsUsed: 0 }; continue; }
      try { results[at] = await fillDraftAspects(userId, ids[at]); } catch (err) {
        results[at] = { id: ids[at], title: null, status: 'failed', reason: err.message || 'Could not fill.', creditsUsed: 0 };
      }
      if (results[at].status === 'no_credits') broke = true;
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, ids.length)) }, worker));
  return results;
}

module.exports = { fillDraftAspects, fillManyDraftAspects, fillEditorAspects };
