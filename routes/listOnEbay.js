const express = require('express');
const router = express.Router();
const { publishListing, createOrGetCustomLocation } = require('../services/ebayListingService');
const { suggestCategories, getItemAspectsForCategory } = require('../services/ebayTaxonomyService');
const {
  createListing,
  updateListing,
  markPublished,
  markError,
  claimListingForPublishing,
} = require('../models/listingsModel');
const {
  listEbayAccounts,
  getEbayAccountById,
  getEbayAccountRefreshToken,
  getActiveEbayAccount,
} = require('../models/ebayAccountsModel');
const { requireAuth } = require('../middleware/requireAuth');
const { isPositiveNumber } = require('../services/validationService');
const { hasCredits, spendCredit, refundCredit } = require('../models/usersModel');
const { ACTION_COSTS } = require('../config/actionCosts');
const { getImportById, updateImportProduct } = require('../models/importsModel');

/**
 * GET /api/list-on-ebay/suggest-category?title=...&accountId=...
 * Requires a valid session token and a connected eBay account.
 *
 * Suggests eBay categories for a product based on its title, using eBay's
 * Taxonomy API. Returns the top suggestion plus the full list, so the
 * frontend can auto-fill the top pick into the Category ID field while
 * still letting the user change it manually. If no accountId is given,
 * falls back to the user's first connected account.
 */
/**
 * GET /api/list-on-ebay/category-aspects?categoryId=...&accountId=...
 * Returns eBay's required/recommended/optional item specifics for a leaf category.
 */
router.get('/category-aspects', requireAuth, async (req, res) => {
  const { categoryId, accountId } = req.query;
  if (!categoryId) return res.status(400).json({ success: false, error: 'A categoryId is required.' });
  const accounts = await listEbayAccounts(req.userId);
  const account = accountId ? accounts.find(a => a.id === accountId) : (accounts.find(a => a.isActive) || accounts[0]);
  if (!account) return res.status(400).json({ success: false, error: 'Please connect your eBay account first.' });
  try {
    const result = await getItemAspectsForCategory(null, categoryId, account.marketplaceId || 'EBAY_US');
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('category-aspects error:', err.message);
    res.status(err.statusCode || 500).json({ success: false, error: err.message || 'Could not load eBay category specifications.' });
  }
});

router.get('/suggest-category', requireAuth, async (req, res) => {
  const { title, accountId } = req.query;

  if (!title) {
    return res.status(400).json({ success: false, error: 'A title is required.' });
  }

  const accounts = await listEbayAccounts(req.userId);
  const account = accountId
    ? accounts.find((a) => a.id === accountId)
    : (accounts.find((a) => a.isActive) || accounts[0]);

  if (!account) {
    return res.status(400).json({ success: false, error: 'Please connect your eBay account first.' });
  }

  try {
    const result = await suggestCategories(null, title, account.marketplaceId || 'EBAY_US');
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('suggest-category error:', err.message);
    res.status(err.statusCode || 500).json({
      success: false,
      error: err.message || 'Could not suggest a category for this product.',
    });
  }
});

/**
 * POST /api/list-on-ebay
 * Requires a valid session token.
 * Body: {
 *   product: object, sellPrice: number, quantity?: number, categoryId: string,
 *   sku?: string, importId?: string, accountId: string
 * }
 *
 * Publishes an Amazon product (previously fetched) as a live eBay listing,
 * using ONE specific connected eBay account (accountId) - required so the
 * user explicitly chooses which of their (possibly several) accounts a
 * listing goes to.
 * A listing row is created first as a draft, then updated to "published"
 * or "error" depending on the outcome, so it shows up in Live Listings either way.
 */
router.post('/', requireAuth, async (req, res) => {
  const { sellPrice, quantity, categoryId, sku, importId, aspects } = req.body;
  let { accountId } = req.body;
  const userId = req.userId;

  // The account selected in the sidebar is the user's active account. If
  // this endpoint is called without an explicit accountId (for example from
  // the main Import page), publish through that active account. Drafts can
  // still pass an explicit accountId when the user wants a different seller.
  if (!accountId) {
    const active = await getActiveEbayAccount(userId);
    if (active) accountId = active.id;
  }

  // The server is the source of truth for product data. The client may send
  // an importId, but it may not inject arbitrary product content into eBay.
  if (!importId) {
    return res.status(400).json({ success: false, error: 'A saved Amazon import is required to publish.' });
  }
  if (!isPositiveNumber(sellPrice)) {
    return res.status(400).json({ success: false, error: 'A valid sellPrice greater than 0 is required.' });
  }
  if (quantity !== undefined && !isPositiveNumber(quantity)) {
    return res.status(400).json({ success: false, error: 'quantity must be a positive number.' });
  }
  if (!categoryId) {
    return res.status(400).json({ success: false, error: 'A categoryId is required.' });
  }
  if (!accountId) {
    return res.status(400).json({ success: false, error: 'Please choose which eBay account to publish to.' });
  }

  const importRecord = await getImportById(userId, importId);
  if (!importRecord || !importRecord.product) {
    return res.status(404).json({ success: false, error: 'The saved Amazon product could not be found.' });
  }
  const product = { ...importRecord.product, ebayAspects: aspects && typeof aspects === 'object' ? aspects : importRecord.product.ebayAspects };

  if (!(await hasCredits(userId, ACTION_COSTS.EBAY_PUBLISH))) {
    return res.status(402).json({
      success: false,
      error: 'You have run out of credits. Please open a support ticket to request more.',
    });
  }

  const sellerSettings = await getEbayAccountById(userId, accountId);
  if (!sellerSettings) {
    return res.status(400).json({ success: false, error: 'That eBay account was not found. Please reconnect it in Settings.' });
  }

  const finalSku = sku || `AMZ-${product.asin || Date.now()}`;
  const mainImage = (product.images && product.images[0]) || null;

  let listingRow;
  try {
    listingRow = await createListing(userId, {
      importId,
      ebayAccountId: accountId,
      sku: finalSku,
      title: product.title,
      mainImage,
      images: product.images || [],
      sellPrice,
      currency: product.currency,
      quantity: quantity || 1,
      categoryId,
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({
        success: false,
        error: 'This product is already being published (or already has a listing). Please check Drafts or Live Listings.',
      });
    }
    console.error('list-on-ebay create-listing-row error:', err.message);
    return res.status(500).json({ success: false, error: 'Could not save this listing. Please try again.' });
  }

  // Claim and queue the listing. eBay work happens in the persistent
  // background publisher, so the Import page remains responsive.
  const claimed = await claimListingForPublishing(userId, listingRow.id);
  if (!claimed) {
    return res.status(409).json({ success: false, error: 'This listing is already being published. Check Drafts or Notifications.' });
  }

  res.status(202).json({
    success: true,
    queued: true,
    message: 'Publish queued. ELMS will continue publishing in the background.',
    listing: claimed,
  });

});

/**
 * PUT /api/list-on-ebay/:id
 * Requires a valid session token.
 * Body: any of { title, mainImage, images, sellPrice, currency, quantity, categoryId }
 *
 * Edits a draft (or previously errored) listing's fields before re-publishing.
 * Only works on listings owned by the current user.
 */
router.put('/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { title, mainImage, images, sellPrice, currency, quantity, categoryId, draftProduct, ebayAspects } = req.body;

  if (sellPrice !== undefined && sellPrice !== null && !isPositiveNumber(sellPrice)) {
    return res.status(400).json({ success: false, error: 'sellPrice must be a positive number.' });
  }
  if (quantity !== undefined && quantity !== null && !isPositiveNumber(quantity)) {
    return res.status(400).json({ success: false, error: 'quantity must be a positive number.' });
  }

  const updated = await updateListing(req.userId, id, { title, mainImage, images, sellPrice, currency, quantity, categoryId });

  if (!updated) {
    return res.status(404).json({ success: false, error: 'Listing not found.' });
  }

  if (draftProduct && updated.import_id) {
    const productToSave = { ...draftProduct, ebayAspects: ebayAspects && typeof ebayAspects === 'object' ? ebayAspects : draftProduct.ebayAspects };
    await updateImportProduct(req.userId, updated.import_id, productToSave);
  }

  res.json({ success: true, listing: updated });
});

module.exports = router;
