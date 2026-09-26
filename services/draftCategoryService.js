const { suggestCategories } = require('./ebayTaxonomyService');
const { getEbayAccountById } = require('../models/ebayAccountsModel');

/**
 * A draft that has no eBay category gets eBay's own suggestion for its title, saved on the draft, so publishing does not stop on
 * "No eBay category ID is set".
 *
 * The Drafts page also suggests categories, but only for the cards on the page you are looking at, one after the other; every other
 * draft (and every draft published a moment after import) still has none. Doing it here, where the publish happens, covers them all.
 */

async function marketplaceOf(userId, listing) {
  if (listing.marketplace_id) return listing.marketplace_id;
  if (listing.ebay_account_id) {
    const account = await getEbayAccountById(userId, listing.ebay_account_id).catch(() => null);
    if (account && account.marketplaceId) return account.marketplaceId;
  }
  return 'EBAY_US';
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {string} userId
 * @param {object} listing the draft (serialized: title, category_id, marketplace_id, ebay_account_id, id)
 * @param {{ save: (userId, id, fields) => Promise, retryDelayMs?: number }} deps save = listingsModel.updateListing
 * @returns {Promise<{ categoryId: string, categoryName: string, picked: boolean }>} throws with a reason a person can act on
 */
async function ensureDraftCategory(userId, listing, deps) {
  if (listing.category_id) return { categoryId: String(listing.category_id), categoryName: '', picked: false };
  const title = String(listing.title || '').trim();
  if (title.length < 3) throw new Error('No eBay category is set, and the draft has no title to suggest one from. Open the draft and choose a category.');

  const marketplaceId = await marketplaceOf(userId, listing);
  let top = null;
  let lastError = null;
  // eBay's category service answers "busy" now and then when many drafts are published at once: two more tries.
  for (let attempt = 0; attempt < 3 && !top; attempt += 1) {
    try {
      top = (await suggestCategories(null, title, marketplaceId)).topSuggestion;
      lastError = null;
      if (!top) break; // an answer with no suggestion: asking again gives the same
    } catch (err) {
      lastError = err;
      if (attempt < 2) await wait(deps.retryDelayMs === undefined ? 1500 * (attempt + 1) : deps.retryDelayMs);
    }
  }
  if (lastError) throw new Error('No eBay category is set, and eBay could not suggest one right now (' + lastError.message + '). Try again, or choose a category in the editor.');
  if (!top || !top.categoryId) throw new Error('No eBay category is set, and eBay had no suggestion for this title. Open the draft and choose a category.');

  const categoryId = String(top.categoryId);
  await deps.save(userId, listing.id, { categoryId });
  return { categoryId, categoryName: top.categoryName || '', picked: true };
}

module.exports = { ensureDraftCategory };
