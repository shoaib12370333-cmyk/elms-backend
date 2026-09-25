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
  detectCountryFromUrl,
} = require('../services/canopyAmazonService');
const { getActiveEbayAccount } = require('../models/ebayAccountsModel');
const { getMarketplaceConfig } = require('../config/ebayMarketplaces');
const { getCachedProduct, setCachedProduct } = require('../services/productCacheService');
const rateLimit = require('express-rate-limit');

// The Image Extractor is free (its images come with every product fetch), so it must not be an open door to the paid Amazon API:
// a product that was fetched lately (an import, an earlier extraction) is served from the product cache, and every person has a pace.
const freeToolLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 40,
  keyGenerator: (req) => String(req.userId),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many image lookups. Please try again in a few minutes.' },
});

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
 * Which Amazon site a research call looks at: the one asked for (?country=), else the site of the link that was pasted, else the
 * site that matches the seller's active eBay store (a UK seller researches amazon.co.uk), else the US. The page sends only the ASIN,
 * so without this every tool looked at amazon.com whatever store the seller sells on.
 */
async function countryOf(req) {
  let asked = String(req.query.country || '').trim().toUpperCase();
  if (asked === 'UK') asked = 'GB';
  if (asked) return asked;
  if (req.query.url && /^https?:\/\//i.test(String(req.query.url))) return detectCountryFromUrl(String(req.query.url));
  try {
    const account = await getActiveEbayAccount(req.userId);
    const country = account && getMarketplaceConfig(account.marketplaceId)?.country;
    if (country) return country;
  } catch (_) { /* no store: the US */ }
  return 'US';
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
  await billed(req, res, 'REVIEW_ANALYZER', 'Could not fetch reviews for this product.', async () => fetchProductReviews(asin, await countryOf(req)));
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
  await billed(req, res, 'KEYWORD_RANK_CHECKER', 'Could not check keyword rank.', async () => ({ keyword, asin, ...(await findKeywordRank(keyword, asin, { country: await countryOf(req) })) }));
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
  await billed(req, res, 'CATEGORY_FINDER', 'Could not find categories for this product.', async () => findProductCategories(asin, await countryOf(req)));
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
  await billed(req, res, 'BESTSELLER_EXPLORER', 'Could not load this category.', async () => fetchCategoryDetails(categoryId, {
    country: await countryOf(req),
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
router.get('/image-extractor', requireAuth, freeToolLimiter, async (req, res) => {
  const asin = resolveAsin(req);
  if (!asin) {
    return res.status(400).json({ success: false, error: 'An asin or url is required.' });
  }
  await billed(req, res, 'IMAGE_EXTRACTOR', 'Could not fetch images for this product.', async () => {
    const country = await countryOf(req);
    let product = await getCachedProduct(asin, country);
    if (!product) {
      product = await fetchProductByAsin(asin, country);
      if (product && product.asin) await setCachedProduct(product.asin, country, product, 'canopy').catch(() => {});
    }
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
  await billed(req, res, 'LISTING_GRADER', 'Could not grade this listing.', async () => gradeListing(asin, await countryOf(req)));
});

module.exports = router;
module.exports.countryOf = countryOf;
