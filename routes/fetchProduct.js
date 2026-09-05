const express = require('express');
const router = express.Router();
const { fetchProductByUrl } = require('../services/rapidAmazonService');
const { createImport } = require('../models/importsModel');
const { upsertDraft } = require('../models/listingsModel');
const { hasCredits, spendCredit } = require('../models/usersModel');
const { requireAuth } = require('../middleware/requireAuth');

/**
 * Fetches one Amazon product, saves it as an import, and creates/refreshes
 * its matching draft listing. Shared by both the single-URL and bulk routes.
 * Spends one credit on success (admins are never charged).
 */
async function fetchAndSaveDraft(userId, amazonUrl, markupPercent) {
  const product = await fetchProductByUrl(amazonUrl);
  await spendCredit(userId);

  let suggestedPrice = null;
  if (product.price != null && markupPercent != null) {
    const markup = Number(markupPercent);
    if (!Number.isNaN(markup)) {
      suggestedPrice = Number((product.price * (1 + markup / 100)).toFixed(2));
    }
  }

  const importRecord = await createImport(userId, product, suggestedPrice, amazonUrl);

  const sku = `AMZ-${product.asin || importRecord.id}`;
  const draft = await upsertDraft(userId, {
    importId: importRecord.id,
    sku,
    title: product.title,
    mainImage: (product.images && product.images[0]) || null,
    sellPrice: suggestedPrice ?? product.price,
    quantity: 1,
    categoryId: null,
  });

  return { product, suggestedPrice, importId: importRecord.id, draft };
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

  if (!(await hasCredits(req.userId))) {
    return res.status(402).json({
      success: false,
      error: 'You have run out of credits. Please open a support ticket to request more.',
    });
  }

  try {
    const result = await fetchAndSaveDraft(req.userId, amazonUrl, markupPercent);
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
    if (!(await hasCredits(req.userId))) {
      results.push({ amazonUrl, success: false, error: 'Out of credits. Please open a support ticket to request more.' });
      continue;
    }

    try {
      const result = await fetchAndSaveDraft(req.userId, amazonUrl, markupPercent);
      results.push({ amazonUrl, success: true, ...result });
    } catch (err) {
      console.error(`fetch-product/bulk error for ${amazonUrl}:`, err.message);
      results.push({ amazonUrl, success: false, error: err.message || 'Something went wrong.' });
    }
  }

  res.json({ success: true, results });
});

module.exports = router;
