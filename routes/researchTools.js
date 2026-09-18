const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/requireAuth');
const { hasCredits, spendCredit, refundCredit } = require('../models/usersModel');
const { ACTION_COSTS } = require('../config/actionCosts');
const {
  fetchProductByAsin,
  fetchProductReviews,
  findKeywordRank,
  fetchCategoryDetails,
  findProductCategories,
  gradeListing,
  extractAsinFromUrl,
} = require('../services/canopyAmazonService');

/**
 * Small helper: routes below accept either an asin or a full Amazon url -
 * this resolves either into a plain ASIN.
 */
function resolveAsin(req) {
  if (req.query.asin) return req.query.asin;
  if (req.query.url) return extractAsinFromUrl(req.query.url);
  return null;
}

/**
 * GET /api/tools/review-analyzer?asin=...&country=US
 * Requires a valid session token and available credits.
 *
 * Returns the ratings breakdown and a sample of reviews for a product -
 * powers the Review Analyzer tool.
 */
router.get('/review-analyzer', requireAuth, async (req, res) => {
  const asin = resolveAsin(req);
  if (!asin) {
    return res.status(400).json({ success: false, error: 'An asin or url is required.' });
  }

  if (!(await hasCredits(req.userId, ACTION_COSTS.REVIEW_ANALYZER))) {
    return res.status(402).json({ success: false, error: 'You have run out of credits. Please open a support ticket to request more.' });
  }

  try {
    const result = await fetchProductReviews(asin, req.query.country || 'US');
    await spendCredit(req.userId, ACTION_COSTS.REVIEW_ANALYZER);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('review-analyzer error:', err.message);
    res.status(err.statusCode || 500).json({ success: false, error: err.message || 'Could not fetch reviews for this product.' });
  }
});

/**
 * GET /api/tools/keyword-rank?keyword=...&asin=...&country=US
 * Requires a valid session token and available credits.
 *
 * Finds where a product ranks in Amazon's organic search results for a
 * given keyword - powers the Keyword Rank Checker tool.
 */
router.get('/keyword-rank', requireAuth, async (req, res) => {
  const { keyword } = req.query;
  const asin = resolveAsin(req);

  if (!keyword || !asin) {
    return res.status(400).json({ success: false, error: 'Both a keyword and an asin (or url) are required.' });
  }

  if (!(await hasCredits(req.userId, ACTION_COSTS.KEYWORD_RANK_CHECKER))) {
    return res.status(402).json({ success: false, error: 'You have run out of credits. Please open a support ticket to request more.' });
  }

  const charged = await spendCredit(req.userId, ACTION_COSTS.KEYWORD_RANK_CHECKER);

  try {
    const result = await findKeywordRank(keyword, asin, { country: req.query.country || 'US' });
    res.json({ success: true, keyword, asin, ...result });
  } catch (err) {
    console.error('keyword-rank error:', err.message);
    // The search itself failed (not just "not found") - refund since the
    // user got no usable result at all.
    if (charged) await refundCredit(req.userId, ACTION_COSTS.KEYWORD_RANK_CHECKER);
    res.status(err.statusCode || 500).json({ success: false, error: err.message || 'Could not check keyword rank.' });
  }
});

/**
 * GET /api/tools/category-finder?asin=...&country=US
 * Requires a valid session token and available credits.
 *
 * Returns which Amazon categories a product belongs to, with its
 * best-seller rank in each - powers the Category Finder tool.
 */
router.get('/category-finder', requireAuth, async (req, res) => {
  const asin = resolveAsin(req);
  if (!asin) {
    return res.status(400).json({ success: false, error: 'An asin or url is required.' });
  }

  if (!(await hasCredits(req.userId, ACTION_COSTS.CATEGORY_FINDER))) {
    return res.status(402).json({ success: false, error: 'You have run out of credits. Please open a support ticket to request more.' });
  }

  try {
    const result = await findProductCategories(asin, req.query.country || 'US');
    await spendCredit(req.userId, ACTION_COSTS.CATEGORY_FINDER);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('category-finder error:', err.message);
    res.status(err.statusCode || 500).json({ success: false, error: err.message || 'Could not find categories for this product.' });
  }
});

/**
 * GET /api/tools/bestseller-explorer?categoryId=...&country=US&page=1
 * Requires a valid session token and available credits.
 *
 * Returns the top-ranked products in an Amazon category - powers the
 * Bestseller Explorer tool.
 */
router.get('/bestseller-explorer', requireAuth, async (req, res) => {
  const { categoryId, page } = req.query;
  if (!categoryId) {
    return res.status(400).json({ success: false, error: 'A categoryId is required.' });
  }

  if (!(await hasCredits(req.userId, ACTION_COSTS.BESTSELLER_EXPLORER))) {
    return res.status(402).json({ success: false, error: 'You have run out of credits. Please open a support ticket to request more.' });
  }

  try {
    const result = await fetchCategoryDetails(categoryId, {
      country: req.query.country || 'US',
      page: page ? Number(page) : undefined,
      sort: 'FEATURED',
    });
    await spendCredit(req.userId, ACTION_COSTS.BESTSELLER_EXPLORER);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('bestseller-explorer error:', err.message);
    res.status(err.statusCode || 500).json({ success: false, error: err.message || 'Could not load this category.' });
  }
});

/**
 * GET /api/tools/image-extractor?asin=...&country=US
 * Requires a valid session token and available credits.
 *
 * Returns every high-resolution image for a product - powers the Image
 * Extractor tool. This is a thin wrapper around the standard product
 * fetch, since Canopy's product endpoint already returns the full image set.
 */
router.get('/image-extractor', requireAuth, async (req, res) => {
  const asin = resolveAsin(req);
  if (!asin) {
    return res.status(400).json({ success: false, error: 'An asin or url is required.' });
  }

  if (!(await hasCredits(req.userId, ACTION_COSTS.IMAGE_EXTRACTOR))) {
    return res.status(402).json({ success: false, error: 'You have run out of credits. Please open a support ticket to request more.' });
  }

  try {
    const product = await fetchProductByAsin(asin, req.query.country || 'US');
    await spendCredit(req.userId, ACTION_COSTS.IMAGE_EXTRACTOR);
    res.json({ success: true, asin, title: product.title, images: product.images });
  } catch (err) {
    console.error('image-extractor error:', err.message);
    res.status(err.statusCode || 500).json({ success: false, error: err.message || 'Could not fetch images for this product.' });
  }
});

/**
 * GET /api/tools/listing-grader?asin=...&country=US
 * Requires a valid session token and available credits.
 *
 * Scores a live listing on title length, feature bullets, image count,
 * rating, and review volume - powers the Listing Grader tool. Uses the
 * same transparent heuristics as Canopy's own free listing grader tool.
 */
router.get('/listing-grader', requireAuth, async (req, res) => {
  const asin = resolveAsin(req);
  if (!asin) {
    return res.status(400).json({ success: false, error: 'An asin or url is required.' });
  }

  if (!(await hasCredits(req.userId, ACTION_COSTS.LISTING_GRADER))) {
    return res.status(402).json({ success: false, error: 'You have run out of credits. Please open a support ticket to request more.' });
  }

  try {
    const result = await gradeListing(asin, req.query.country || 'US');
    await spendCredit(req.userId, ACTION_COSTS.LISTING_GRADER);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('listing-grader error:', err.message);
    res.status(err.statusCode || 500).json({ success: false, error: err.message || 'Could not grade this listing.' });
  }
});

module.exports = router;
