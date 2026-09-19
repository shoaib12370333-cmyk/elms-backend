const express = require('express');
const router = express.Router();
const { publishListing, createOrGetCustomLocation } = require('../services/ebayListingService');
const { processOneQueuedListing } = require('../services/publishQueueService');
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
const { requireAsinSku } = require('../services/skuService');
const { getImportById, updateImportProduct } = require('../models/importsModel');
const { saveLocalImage, downloadAndSaveImage } = require('../services/imageStorageService');

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
/**
 * Shared wrapper for the two AI endpoints: checks the admin switch, charges the
 * admin-set credit cost up front, refunds it if the AI call fails, and logs usage.
 */
async function runAiAction(req, res, { kind, costKey, enabledKey, run }) {
  const { getAiSettings } = require('../models/settingsModel');
  const { hasCredits, spendCredit, refundCredit } = require('../models/usersModel');
  const { ACTION_COSTS } = require('../config/actionCosts');
  const AiUsage = require('../models/schemas/AiUsage');
  const settings = await getAiSettings();
  if (!settings[enabledKey]) return res.status(403).json({ success: false, error: 'This AI feature is turned off by the administrator.' });
  const cost = Number(ACTION_COSTS[costKey] || 0);
  if (!(await hasCredits(req.userId, cost))) return res.status(402).json({ success: false, error: `You need ${cost} credit${cost === 1 ? '' : 's'} for this. Buy credits to continue.` });
  const charged = await spendCredit(req.userId, cost);
  if (!charged) return res.status(402).json({ success: false, error: `You need ${cost} credit${cost === 1 ? '' : 's'} for this. Buy credits to continue.` });
  try {
    const out = await run(settings);
    AiUsage.create({ userId: req.userId, kind, ok: true, credits: cost, model: out.usage?.model, inputTokens: out.usage?.inputTokens, outputTokens: out.usage?.outputTokens }).catch(() => {});
    return res.json({ success: true, text: out.text, title: kind === 'title' ? out.text : undefined, description: kind === 'description' ? out.text : undefined, creditsUsed: cost });
  } catch (err) {
    await refundCredit(req.userId, cost);
    AiUsage.create({ userId: req.userId, kind, ok: false, credits: 0 }).catch(() => {});
    console.error(`[ai-${kind}]`, err.message);
    return res.status(err.statusCode || 500).json({ success: false, error: err.message || 'The AI request failed.' });
  }
}

/**
 * POST /api/list-on-ebay/optimize-title
 * Body: { title, categoryName?, description? } -> { title } (max 80 characters).
 */
router.post('/optimize-title', requireAuth, async (req, res) => {
  const title = String(req.body?.title || '').trim();
  if (title.length < 3) return res.status(400).json({ success: false, error: 'Enter a title first.' });
  const { optimizeEbayTitle } = require('../services/titleOptimizerService');
  return runAiAction(req, res, {
    kind: 'title', costKey: 'AI_TITLE', enabledKey: 'aiTitleEnabled',
    run: () => optimizeEbayTitle({ title, categoryName: String(req.body?.categoryName || '').slice(0, 120), description: String(req.body?.description || '').slice(0, 1500) }),
  });
});

/**
 * POST /api/list-on-ebay/optimize-description
 * Body: { title, description?, bulletPoints?, specifications?, categoryName? } -> { description }
 */
router.post('/optimize-description', requireAuth, async (req, res) => {
  const title = String(req.body?.title || '').trim();
  if (title.length < 3) return res.status(400).json({ success: false, error: 'Enter a title first.' });
  const { generateEbayDescription } = require('../services/descriptionGeneratorService');
  return runAiAction(req, res, {
    kind: 'description', costKey: 'AI_DESCRIPTION', enabledKey: 'aiDescriptionEnabled',
    run: () => generateEbayDescription({
      title, categoryName: String(req.body?.categoryName || '').slice(0, 120),
      description: req.body?.description, bulletPoints: req.body?.bulletPoints, specifications: req.body?.specifications,
    }),
  });
});

router.post('/:id/images/upload', requireAuth, async (req, res) => {
  const imageData = String(req.body?.imageData || '').trim();
  const imageUrl = String(req.body?.imageUrl || '').trim();
  if (!imageData && !imageUrl) return res.status(400).json({success:false,error:'Send imageData or imageUrl.'});
  try {
    const result = imageData
      ? await saveLocalImage({dataUrl:imageData,userId:req.userId,listingId:req.params.id,req})
      : await downloadAndSaveImage({imageUrl,userId:req.userId,listingId:req.params.id,req});
    res.status(201).json({success:true,url:result.url,fileName:result.filename,bytes:result.bytes});
  } catch (err) {
    console.error('[draft-image-upload]',err.message);
    res.status(400).json({success:false,error:err.message || 'Could not save image.'});
  }
});

router.post('/:id/images/save-url', requireAuth, async (req, res) => {
  const imageUrl=String(req.body?.imageUrl||'').trim();
  if (!imageUrl) return res.status(400).json({success:false,error:'imageUrl is required.'});
  try {
    const result=await downloadAndSaveImage({imageUrl,userId:req.userId,listingId:req.params.id,req});
    res.status(201).json({success:true,url:result.url,fileName:result.filename,bytes:result.bytes});
  } catch(err) {
    console.error('[draft-image-url-save]',err.message);
    res.status(400).json({success:false,error:err.message || 'Could not save image from URL.'});
  }
});

router.post('/', requireAuth, async (req, res) => {
  const { sellPrice, quantity, categoryId, sku, importId, aspects, marketplaceId: requestedMarketplaceId } = req.body;
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

  const finalSku = requireAsinSku(sku || product.asin, 'Amazon product');
  const mainImage = (product.images && product.images[0]) || null;

  let listingRow;
  try {
    listingRow = await createListing(userId, {
      importId,
      ebayAccountId: accountId,
      marketplaceId: sellerSettings.marketplaceId || requestedMarketplaceId || null,
      sku: finalSku,
      title: product.title,
      mainImage,
      images: product.images || [],
      sellPrice,
      currency: product.currency,
      quantity: quantity || 1,
      categoryId,
      description: product.description || '',
      bulletPoints: Array.isArray(product.bulletPoints) ? product.bulletPoints : [],
      specifications: Array.isArray(product.specifications) ? product.specifications : [],
      ebayAspects: product.ebayAspects && typeof product.ebayAspects === 'object' ? product.ebayAspects : {},
      amazonPrice: product.price,
      marginAmount: Number.isFinite(Number(sellPrice)) && Number.isFinite(Number(product.price)) ? Number((Number(sellPrice) - Number(product.price)).toFixed(2)) : null,
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

  // Claim the listing, then publish it in the same request.
  // The existing publisher service performs the real eBay API call and keeps
  // credit charging/refunds + success/error notifications in one code path.
  const claimed = await claimListingForPublishing(userId, listingRow.id);
  if (!claimed) {
    return res.status(409).json({ success: false, error: 'This listing is already being published. Check Drafts or Notifications.' });
  }

  const published = await processOneQueuedListing(claimed);
  if (published?.status === 'published') {
    return res.status(200).json({
      success: true,
      immediate: true,
      queued: false,
      message: 'Listing published to eBay successfully.',
      listing: published,
    });
  }

  return res.status(502).json({
    success: false,
    immediate: true,
    queued: false,
    message: 'eBay publishing failed. Check the listing error details and Notifications.',
    listing: published,
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
  const { title, mainImage, images, sellPrice, markupPercent, currency, quantity, categoryId, draftProduct, ebayAspects, accountId, marketplaceId } = req.body;

  if (sellPrice !== undefined && sellPrice !== null && !isPositiveNumber(sellPrice)) {
    return res.status(400).json({ success: false, error: 'sellPrice must be a positive number.' });
  }
  if (quantity !== undefined && quantity !== null && !isPositiveNumber(quantity)) {
    return res.status(400).json({ success: false, error: 'quantity must be a positive number.' });
  }

  let destinationAccountId = accountId;
  let destinationMarketplaceId = marketplaceId;
  if (destinationAccountId) {
    const destinationAccount = await getEbayAccountById(req.userId, destinationAccountId);
    if (!destinationAccount) return res.status(400).json({ success: false, error: 'The selected eBay account is no longer connected.' });
    destinationMarketplaceId = destinationMarketplaceId || destinationAccount.marketplaceId || 'EBAY_US';
  }
  const productToSave = draftProduct && typeof draftProduct === 'object'
    ? {
        ...draftProduct,
        ebayAspects: ebayAspects && typeof ebayAspects === 'object'
          ? ebayAspects
          : draftProduct.ebayAspects,
      }
    : null;

  const updated = await updateListing(req.userId, id, {
    title,
    mainImage,
    images,
    sellPrice,
    markupPercent,
    currency,
    quantity,
    categoryId,
    ebayAccountId: destinationAccountId,
    marketplaceId: destinationMarketplaceId,
    description: productToSave?.description ?? req.body.description,
    bulletPoints: productToSave?.bulletPoints,
    specifications: productToSave?.specifications ?? req.body.specifications,
    // Per-product settings from the listing editor (validated in listingsModel.buildSettingsUpdate).
    tags: req.body.tags,
    shippingMethod: req.body.shippingMethod,
    useDynamicPolicies: req.body.useDynamicPolicies,
    paymentPolicyId: req.body.paymentPolicyId,
    fulfillmentPolicyId: req.body.fulfillmentPolicyId,
    returnPolicyId: req.body.returnPolicyId,
    countryLocation: req.body.countryLocation,
    locationCity: req.body.locationCity,
    postalCode: req.body.postalCode,
    stockMonitoring: req.body.stockMonitoring,
    priceMonitoring: req.body.priceMonitoring,
    ebayAspects: productToSave?.ebayAspects,
    amazonPrice: productToSave?.price,
    marginAmount: productToSave?.price != null && sellPrice != null ? Number((Number(sellPrice) - Number(productToSave.price)).toFixed(2)) : undefined,
  });

  if (!updated) {
    return res.status(404).json({ success: false, error: 'Listing not found.' });
  }

  if (productToSave && updated.import_id) {
    // Keep the source import synchronized for the editor/history, but the
    // listing snapshot above is the publish source of truth. This prevents a
    // later source refresh from changing a draft the seller already saved.
    try {
      await updateImportProduct(req.userId, updated.import_id, productToSave);
    } catch (syncErr) {
      console.warn('[draft-save] source import sync failed:', syncErr.message);
    }
  }

  res.json({ success: true, listing: updated });
});

module.exports = router;
