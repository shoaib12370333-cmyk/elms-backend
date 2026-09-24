const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/requireAuth');
const { withCredits } = require('../services/creditService');
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
 * Runs one billable research call. The credit is taken BEFORE the Amazon call (an atomic charge that only succeeds while the
 * balance covers it) and given back if the call fails, so a user cannot start many requests at once with one credit and get
 * every result. `work` returns the fields to send back.
 */
async function billed(req, res, costKey, failMessage, work) {
  try {
    const payload = await withCredits(req.userId, ACTION_COSTS[costKey], work);
    res.json({ success: true, ...payload });
  } catch (err) {
    if (err.outOfCredits) return res.status(402).json({ success: false, error: 'You have run out of credits. Please open a support ticket to request more.' });
    console.error(`${costKey} error:`, err.message);
    res.status(err.statusCode || 500).json({ success: false, error: err.message || failMessage });
  }
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
  await billed(req, res, 'REVIEW_ANALYZER', 'Could not fetch reviews for this product.', () => fetchProductReviews(asin, req.query.country || 'US'));
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
  // A search that fails (not just "not found") gives the credit back: the user got no usable result.
  await billed(req, res, 'KEYWORD_RANK_CHECKER', 'Could not check keyword rank.', async () => ({ keyword, asin, ...(await findKeywordRank(keyword, asin, { country: req.query.country || 'US' })) }));
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
  await billed(req, res, 'CATEGORY_FINDER', 'Could not find categories for this product.', () => findProductCategories(asin, req.query.country || 'US'));
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
  await billed(req, res, 'BESTSELLER_EXPLORER', 'Could not load this category.', () => fetchCategoryDetails(categoryId, {
    country: req.query.country || 'US',
    page: page ? Number(page) : undefined,
    sort: 'FEATURED',
  }));
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
  await billed(req, res, 'IMAGE_EXTRACTOR', 'Could not fetch images for this product.', async () => {
    const product = await fetchProductByAsin(asin, req.query.country || 'US');
    return { asin, title: product.title, images: product.images };
  });
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
  await billed(req, res, 'LISTING_GRADER', 'Could not grade this listing.', () => gradeListing(asin, req.query.country || 'US'));
});

module.exports = router;
