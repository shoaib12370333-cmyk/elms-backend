const express = require('express');
const router = express.Router();
const {
  listListings,
  getListingById,
  markPublished,
  markError,
  deleteListing,
  scheduleListing,
  unscheduleListing,
} = require('../models/listingsModel');
const { publishListing, withdrawListing } = require('../services/ebayListingService');
const { getEbayRefreshToken, getSellerSettings } = require('../models/usersModel');
const { getImportById } = require('../models/importsModel');
const { requireAuth } = require('../middleware/requireAuth');

/**
 * GET /api/listings
 * Requires a valid session token.
 * Query: ?status=draft|published|error|ended (optional)
 *
 * Returns the current user's saved listings, optionally filtered by status.
 * Used by the "Live listings" page.
 */
router.get('/', requireAuth, async (req, res) => {
  const { status } = req.query;
  const listings = await listListings(req.userId, status);
  res.json({ success: true, listings });
});

/**
 * GET /api/listings/:id
 * Requires a valid session token. Only returns the listing if it belongs
 * to the current user.
 */
router.get('/:id', requireAuth, async (req, res) => {
  const listing = await getListingById(req.userId, req.params.id);
  if (!listing) {
    return res.status(404).json({ success: false, error: 'Listing not found.' });
  }
  res.json({ success: true, listing });
});

/**
 * GET /api/listings/:id/detail
 * Requires a valid session token.
 *
 * Returns the listing along with its full linked Amazon product data
 * (title, description, bullet points, specifications, images, etc.) loaded
 * from the database - no Amazon/Rainforest API call is made, so opening
 * this detail view never re-fetches or spends API credits. Used by the
 * Drafts page's detail modal.
 */
router.get('/:id/detail', requireAuth, async (req, res) => {
  const listing = await getListingById(req.userId, req.params.id);
  if (!listing) {
    return res.status(404).json({ success: false, error: 'Listing not found.' });
  }

  let product = null;
  if (listing.import_id) {
    const importRecord = await getImportById(req.userId, listing.import_id);
    product = importRecord ? importRecord.product : null;
  }

  res.json({ success: true, listing, product });
});

/**
 * POST /api/listings/:id/republish
 * Requires a valid session token.
 *
 * Retries publishing a draft or previously-errored listing to eBay, using
 * its current (possibly edited) fields and the current user's eBay account.
 * Requires the original product data, since eBay listing fields like
 * title/description/images live on the product.
 * Body: { product: object }
 */
router.post('/:id/republish', requireAuth, async (req, res) => {
  const { id } = req.params;
  const userId = req.userId;
  const listing = await getListingById(userId, id);
  const { product } = req.body;

  if (!listing) {
    return res.status(404).json({ success: false, error: 'Listing not found.' });
  }
  if (!product) {
    return res.status(400).json({ success: false, error: 'Product data is required to republish.' });
  }

  const refreshToken = await getEbayRefreshToken(userId);
  if (!refreshToken) {
    return res.status(400).json({ success: false, error: 'Please connect your eBay account first.' });
  }

  const sellerSettings = await getSellerSettings(userId);

  try {
    const result = await publishListing({
      refreshToken,
      product,
      sellPrice: listing.sell_price,
      quantity: listing.quantity,
      categoryId: listing.category_id,
      sku: listing.sku,
      sellerSettings,
    });

    const updated = await markPublished(userId, id, { offerId: result.offerId, listingId: result.listingId });
    res.json({ success: true, listing: updated });
  } catch (err) {
    console.error('republish error:', err.message);
    const updated = await markError(userId, id, err.message);
    res.status(err.statusCode || 500).json({
      success: false,
      error: err.message || 'Could not republish this listing.',
      listing: updated,
    });
  }
});

/**
 * DELETE /api/listings/:id
 * Requires a valid session token.
 *
 * Deletes a listing from ELMS. If the listing is currently published on
 * eBay, it is withdrawn (ended) there FIRST - the database record is only
 * removed once eBay confirms the listing is down. This guarantees ELMS and
 * eBay never disagree about whether a listing is still live: deleting from
 * ELMS always means it's also gone from eBay.
 *
 * If the eBay withdraw call fails (e.g. eBay is unreachable, or the
 * connected account's token is invalid), the listing is NOT deleted here -
 * the error is returned so the user can retry, rather than silently leaving
 * an orphaned live listing that ELMS no longer knows about.
 */
router.delete('/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const userId = req.userId;

  const listing = await getListingById(userId, id);
  if (!listing) {
    return res.status(404).json({ success: false, error: 'Listing not found.' });
  }

  // Only a published listing is actually live on eBay - drafts, errored,
  // and already-ended listings have nothing to withdraw.
  if (listing.status === 'published' && listing.ebay_offer_id) {
    const refreshToken = await getEbayRefreshToken(userId);
    if (!refreshToken) {
      return res.status(400).json({
        success: false,
        error: 'This listing is still live on eBay, but your eBay account is not connected, so it cannot be withdrawn. Please reconnect your eBay account and try again.',
      });
    }

    try {
      await withdrawListing(refreshToken, listing.ebay_offer_id);
    } catch (err) {
      console.error('delete-listing withdraw error:', err.message);
      return res.status(err.statusCode || 500).json({
        success: false,
        error: `Could not remove this listing from eBay, so it was not deleted from ELMS either: ${err.message}`,
        ebayErrors: err.ebayErrors || null,
      });
    }
  }

  const deleted = await deleteListing(userId, id);
  if (!deleted) {
    return res.status(404).json({ success: false, error: 'Listing not found.' });
  }

  res.json({ success: true, message: 'Listing deleted from ELMS and removed from eBay (if it was live).' });
});

/**
 * POST /api/listings/:id/publish
 * Requires a valid session token.
 *
 * Publishes a draft listing to eBay with one click - no need to paste the
 * Amazon link again. The full product data (title, description, images,
 * etc.) is loaded automatically from the import this draft was created
 * from. The listing's own fields (title, sellPrice, quantity, categoryId -
 * whatever the user edited on the Drafts page) take priority over the
 * import's original values.
 */
router.post('/:id/publish', requireAuth, async (req, res) => {
  const { id } = req.params;
  const userId = req.userId;

  const listing = await getListingById(userId, id);
  if (!listing) {
    return res.status(404).json({ success: false, error: 'Listing not found.' });
  }
  if (listing.status !== 'draft' && listing.status !== 'error') {
    return res.status(400).json({
      success: false,
      error: `This listing is already "${listing.status}" and cannot be published from here.`,
    });
  }
  if (!listing.import_id) {
    return res.status(400).json({
      success: false,
      error: 'This draft has no linked Amazon product data to publish. Try fetching the product again.',
    });
  }
  if (!listing.category_id) {
    return res.status(400).json({ success: false, error: 'Please set an eBay category ID before publishing.' });
  }
  if (!listing.sell_price) {
    return res.status(400).json({ success: false, error: 'Please set a sell price before publishing.' });
  }

  const importRecord = await getImportById(userId, listing.import_id);
  if (!importRecord) {
    return res.status(404).json({ success: false, error: 'The Amazon product data for this draft could not be found.' });
  }

  // The draft's own (possibly edited) title overrides the import's original title.
  const product = { ...importRecord.product, title: listing.title || importRecord.product.title };

  const refreshToken = await getEbayRefreshToken(userId);
  if (!refreshToken) {
    return res.status(400).json({ success: false, error: 'Please connect your eBay account first.' });
  }

  const sellerSettings = await getSellerSettings(userId);

  try {
    const result = await publishListing({
      refreshToken,
      product,
      sellPrice: listing.sell_price,
      quantity: listing.quantity,
      categoryId: listing.category_id,
      sku: listing.sku,
      sellerSettings,
    });

    const updated = await markPublished(userId, id, { offerId: result.offerId, listingId: result.listingId });
    res.json({ success: true, listing: updated });
  } catch (err) {
    console.error('publish-draft error:', err.message);
    const updated = await markError(userId, id, err.message);
    res.status(err.statusCode || 500).json({
      success: false,
      error: err.message || 'Could not publish this listing to eBay.',
      ebayErrors: err.ebayErrors || null,
      listing: updated,
    });
  }
});

/**
 * POST /api/listings/:id/schedule
 * Requires a valid session token.
 * Body: { scheduledAt: string } - an ISO date/time string in the future
 *
 * Marks a draft (or previously errored) listing to be published
 * automatically once the scheduled time arrives. The actual publish happens
 * in the background (see jobs/scheduledPublisher.js), which runs hourly -
 * so the listing may go live up to an hour after the scheduled time.
 */
router.post('/:id/schedule', requireAuth, async (req, res) => {
  const { id } = req.params;
  const userId = req.userId;
  const { scheduledAt } = req.body;

  if (!scheduledAt) {
    return res.status(400).json({ success: false, error: 'A scheduledAt date/time is required.' });
  }

  const date = new Date(scheduledAt);
  if (Number.isNaN(date.getTime())) {
    return res.status(400).json({ success: false, error: 'scheduledAt is not a valid date/time.' });
  }
  if (date.getTime() <= Date.now()) {
    return res.status(400).json({ success: false, error: 'scheduledAt must be in the future.' });
  }

  const listing = await getListingById(userId, id);
  if (!listing) {
    return res.status(404).json({ success: false, error: 'Listing not found.' });
  }
  if (listing.status !== 'draft' && listing.status !== 'error') {
    return res.status(400).json({
      success: false,
      error: `This listing is already "${listing.status}" and cannot be scheduled.`,
    });
  }
  if (!listing.category_id) {
    return res.status(400).json({ success: false, error: 'Please set an eBay category ID before scheduling.' });
  }
  if (!listing.sell_price) {
    return res.status(400).json({ success: false, error: 'Please set a sell price before scheduling.' });
  }

  const updated = await scheduleListing(userId, id, date);
  res.json({ success: true, listing: updated });
});

/**
 * POST /api/listings/:id/unschedule
 * Requires a valid session token.
 *
 * Cancels a pending schedule, returning the listing to draft status.
 */
router.post('/:id/unschedule', requireAuth, async (req, res) => {
  const { id } = req.params;
  const userId = req.userId;

  const listing = await getListingById(userId, id);
  if (!listing) {
    return res.status(404).json({ success: false, error: 'Listing not found.' });
  }
  if (listing.status !== 'scheduled') {
    return res.status(400).json({ success: false, error: 'This listing is not currently scheduled.' });
  }

  const updated = await unscheduleListing(userId, id);
  res.json({ success: true, listing: updated });
});

module.exports = router;
