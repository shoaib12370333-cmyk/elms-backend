const { getListingById, updateListing } = require('../models/listingsModel');
const { getEbayAccountById } = require('../models/ebayAccountsModel');
const { pickCategory } = require('./aiCategoryService');

/**
 * "Fill category with AI" (Drafts -> select -> bulk bar): for every selected draft that has NO category, the AI chooses one from the
 * category list of that draft's own eBay site (a US store's draft from the US list, a UK store's draft from the UK list; lists.getIndex is per
 * marketplace) and the category is saved on the draft. It does not ask eBay, so it spends none of eBay's category-lookup limit.
 * Costs the admin-set AI_CATEGORY credits per draft that really gets a category (a draft that is skipped, fails or finds nothing is not
 * charged; the same product words again cost nothing).
 */

/** The eBay site of a draft: its own, else its store's. Never guessed: a draft whose site cannot be told is skipped (a wrong site's list gives wrong categories). */
async function marketplaceOf(userId, listing) {
  if (listing.marketplace_id) return listing.marketplace_id;
  if (listing.ebay_account_id) {
    const account = await getEbayAccountById(userId, listing.ebay_account_id).catch(() => null);
    if (account && account.marketplaceId) return account.marketplaceId;
  }
  return null;
}

/**
 * @returns {Promise<{ id, title, status: 'filled'|'has_category'|'skipped'|'failed'|'no_credits', categoryId?, categoryPath?, reason?, creditsUsed }>}
 */
async function fillDraftCategory(userId, id) {
  const result = (status, extra) => ({ id, title: null, status, creditsUsed: 0, ...extra });
  const listing = await getListingById(userId, id);
  if (!listing) return result('skipped', { reason: 'Not found.' });
  const title = listing.title || listing.sku || id;
  const done = (status, extra) => ({ ...result(status, extra), title });
  if (!['draft', 'error'].includes(listing.status)) return done('skipped', { reason: 'Only drafts can be filled here.' });
  if (listing.category_id) return done('has_category');
  if (String(listing.title || '').trim().length < 3) return done('skipped', { reason: 'This draft has no title yet.' });

  const marketplaceId = await marketplaceOf(userId, listing);
  if (!marketplaceId) return done('skipped', { reason: 'Could not tell which eBay site this draft is for. Connect its eBay store first.' });

  try {
    const pick = await pickCategory(userId, listing.title, marketplaceId);
    await updateListing(userId, id, { categoryId: pick.id });
    return done('filled', { categoryId: pick.id, categoryPath: pick.path, creditsUsed: pick.creditsUsed || 0 });
  } catch (err) {
    if (err.reason === 'unavailable') return done('skipped', { reason: err.message });
    if (err.reason === 'no_credits') return done('no_credits', { reason: 'Not enough credits.' });
    console.error('[bulk-category]', id, err.message);
    return done('failed', { reason: err.message || 'The AI request failed.' });
  }
}

/** Several drafts, a few at a time. When the balance runs out the rest are not attempted and cost nothing. */
async function fillManyDraftCategories(userId, ids, { concurrency = 4 } = {}) {
  const results = new Array(ids.length);
  let next = 0;
  let broke = false;
  const worker = async () => {
    while (next < ids.length) {
      const at = next++;
      if (broke) { results[at] = { id: ids[at], title: null, status: 'no_credits', reason: 'Not enough credits.', creditsUsed: 0 }; continue; }
      try { results[at] = await fillDraftCategory(userId, ids[at]); } catch (err) {
        results[at] = { id: ids[at], title: null, status: 'failed', reason: err.message || 'Could not fill.', creditsUsed: 0 };
      }
      if (results[at].status === 'no_credits') broke = true;
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, ids.length)) }, worker));
  return results;
}

module.exports = { fillDraftCategory, fillManyDraftCategories };
