const express = require('express');
const router = express.Router();
const { fetchProductByUrl } = require('../services/canopyAmazonService');
const { createImport, updateImportImages } = require('../models/importsModel');
const { upsertDraft } = require('../models/listingsModel');
const { hasCredits, spendCredit, refundCredit } = require('../models/usersModel');
const { requireAuth } = require('../middleware/requireAuth');
const { isValidAmazonUrl } = require('../services/validationService');
const { ACTION_COSTS } = require('../config/actionCosts');
const { getActiveEbayAccount } = require('../models/ebayAccountsModel');
const { materializeImageUrls } = require('../services/imageStorageService');
const { requireAsinSku } = require('../services/skuService');

/**
 * Fetches one Amazon product, saves it as an import, and creates/refreshes
 * its matching draft listing. Shared by both the single-URL and bulk routes.
 * Spends credits (per ACTION_COSTS.AMAZON_IMPORT) on a successful Amazon
 * fetch - but refunds them if saving the result afterwards fails, so a
 * database hiccup never permanently costs the user a credit for nothing.
 */
async function fetchAndSaveDraft(userId, amazonUrl, markupPercent, req) {
  const product = await fetchProductByUrl(amazonUrl);
  const activeEbayAccount = await getActiveEbayAccount(userId);
  const charged = await spendCredit(userId, ACTION_COSTS.AMAZON_IMPORT);

  try {
    let suggestedPrice = null;
    if (product.price != null && markupPercent != null) {
      const markup = Number(markupPercent);
      if (!Number.isNaN(markup)) {
        suggestedPrice = Number((product.price * (1 + markup / 100)).toFixed(2));
      }
    }

    const importRecord = await createImport(userId, product, suggestedPrice, amazonUrl);
    product.images = product.images?.length
      ? await materializeImageUrls({ urls: product.images, userId, listingId: importRecord.id, req })
      : [];
    await updateImportImages(userId, importRecord.id, product.images || []);
    const sku = requireAsinSku(product.asin, 'Amazon product');
    const draft = await upsertDraft(userId, {
      importId: importRecord.id,
      ebayAccountId: activeEbayAccount?.id || null,
      marketplaceId: activeEbayAccount?.marketplaceId || null,
      sku,
      title: product.title,
      mainImage: (product.images && product.images[0]) || null,
      sellPrice: suggestedPrice ?? product.price,
      markupPercent: Number.isFinite(Number(markupPercent)) ? Number(markupPercent) : 0,
      currency: product.currency,
      quantity: 1,
      categoryId: null,
      amazonPrice: product.price,
      marginAmount: suggestedPrice != null && product.price != null ? Number((suggestedPrice - product.price).toFixed(2)) : null,
    });

    return { product, suggestedPrice, importId: importRecord.id, draft };
  } catch (err) {
    // We already have the Amazon data (the part credits actually pay for),
    // but saving it failed - refund so the user isn't charged for a draft
    // they never actually got.
    if (charged) await refundCredit(userId, ACTION_COSTS.AMAZON_IMPORT);
    throw err;
  }
}

/**
 * POST /api/fetch-product
 * Requires a valid session token and at least one credit (checked before
 * the Amazon API call - admins are never charged and always pass).
 * Body: { amazonUrl: string, markupPercent?: number }
 *
 * Fetches product data from an Amazon link, applies the markup (if given) to
 * calculate a suggested eBay price, and saves the fetch as an import record
 * belonging to the current user. It also automatically saves (or refreshes)
 * a matching draft listing, keyed by the product's ASIN, so the fetched
 * product shows up on the Drafts page and can be published later with one
 * click, without needing to paste the Amazon link again.
 */
router.post('/', requireAuth, async (req, res) => {
  const { amazonUrl, markupPercent } = req.body;

  if (!amazonUrl) {
    return res.status(400).json({ error: 'The amazonUrl field is required.' });
  }
  if (!isValidAmazonUrl(amazonUrl)) {
    return res.status(400).json({ error: 'That does not look like a valid Amazon product URL.' });
  }

  if (!(await hasCredits(req.userId, ACTION_COSTS.AMAZON_IMPORT))) {
    return res.status(402).json({
      success: false,
      error: 'You have run out of credits. Please open a support ticket to request more.',
    });
  }

  try {
    const result = await fetchAndSaveDraft(req.userId, amazonUrl, markupPercent, req);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('fetch-product error:', err.message);
    res.status(err.statusCode || 500).json({
      success: false,
      error: err.message || 'Something went wrong.',
    });
  }
});

/**
 * POST /api/fetch-product/bulk
 * Requires a valid session token.
 * Body: { amazonUrls: string[], markupPercent?: number }
 *
 * Fetches multiple Amazon links one at a time and saves each as an import +
 * draft, same as the single fetch route. Stops early if the user runs out
 * of credits partway through, reporting how many succeeded before that
 * point. Returns a per-URL result so the caller can show progress and
 * report which links succeeded or failed, rather than failing the whole
 * batch if one link is bad.
 */
router.post('/bulk', requireAuth, async (req, res) => {
  const { amazonUrls, markupPercent } = req.body;

  if (!Array.isArray(amazonUrls) || amazonUrls.length === 0) {
    return res.status(400).json({ success: false, error: 'amazonUrls must be a non-empty array.' });
  }
  if (amazonUrls.length > 25) {
    return res.status(400).json({ success: false, error: 'Please import at most 25 links at a time.' });
  }

  const results = [];

  for (const amazonUrl of amazonUrls) {
    if (!isValidAmazonUrl(amazonUrl)) {
      results.push({ amazonUrl, success: false, error: 'That does not look like a valid Amazon product URL.' });
      continue;
    }

    if (!(await hasCredits(req.userId, ACTION_COSTS.AMAZON_IMPORT))) {
      results.push({ amazonUrl, success: false, error: 'Out of credits. Please open a support ticket to request more.' });
      continue;
    }

    try {
      const result = await fetchAndSaveDraft(req.userId, amazonUrl, markupPercent, req);
      results.push({ amazonUrl, success: true, ...result });
    } catch (err) {
      console.error(`fetch-product/bulk error for ${amazonUrl}:`, err.message);
      results.push({ amazonUrl, success: false, error: err.message || 'Something went wrong.' });
    }
  }

  res.json({ success: true, results });
});

module.exports = router;
