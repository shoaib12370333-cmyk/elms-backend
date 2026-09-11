const express = require('express');
const router = express.Router();
const {
  listListings,
  getListingById,
  claimListingForPublishing,
  markPublished,
  markError,
  resetErrorToDraft,
  deleteListing,
  scheduleListing,
  unscheduleListing,
} = require('../models/listingsModel');
const { publishListing, withdrawListing, createOrGetCustomLocation } = require('../services/ebayListingService');
const { listEbayAccounts, getEbayAccountById, getEbayAccountRefreshToken } = require('../models/ebayAccountsModel');
const { getImportById } = require('../models/importsModel');
const { requireAuth } = require('../middleware/requireAuth');
const { hasCredits, spendCredit, refundCredit } = require('../models/usersModel');
const { ACTION_COSTS } = require('../config/actionCosts');

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
 * POST /api/listings/:id/reset-error
 * Returns a failed eBay publish back to the normal Drafts queue.
 */
router.post('/:id/reset-error', requireAuth, async (req, res) => {
  const updated = await resetErrorToDraft(req.userId, req.params.id);
  if (!updated) return res.status(404).json({ success: false, error: 'Failed listing not found.' });
  res.json({ success: true, listing: updated });
});

/**
 * POST /api/listings/:id/republish
 * Requires a valid session token.
 *
 * Retries publishing a draft or previously-errored listing to eBay, using
 * its current (possibly edited) fields and the SAME eBay account it was
 * previously attempted with (listing.ebay_account_id) - or a newly chosen
 * one via accountId in the body, for listings that never had an account set.
 * Requires the original product data, since eBay listing fields like
 * title/description/images live on the product.
 * Body: { product: object, accountId?: string }
 */
router.post('/:id/republish', requireAuth, async (req, res) => {
  const { id } = req.params;
  const userId = req.userId;
  const { accountId, aspects } = req.body;
  const listing = await getListingById(userId, id);

  if (!listing) return res.status(404).json({ success: false, error: 'Listing not found.' });
  if (!['draft', 'error'].includes(listing.status)) {
    return res.status(400).json({ success: false, error: `This listing is already "${listing.status}" and cannot be republished.` });
  }
  if (!listing.import_id) {
    return res.status(400).json({ success: false, error: 'This listing has no linked Amazon product data.' });
  }

  const targetAccountId = listing.ebay_account_id || accountId;
  if (!targetAccountId) return res.status(400).json({ success: false, error: 'Please choose which eBay account to publish to.' });
  if (!(await hasCredits(userId, ACTION_COSTS.REPUBLISH))) {
    return res.status(402).json({ success: false, error: 'You have run out of credits. Please open a support ticket to request more.' });
  }

  if (!listing.category_id) return res.status(400).json({ success: false, error: 'Please set an eBay category ID before publishing.' });
  if (!listing.sell_price) return res.status(400).json({ success: false, error: 'Please set a sell price before publishing.' });

  const claimed = await claimListingForPublishing(userId, id);
  if (!claimed) {
    return res.status(409).json({ success: false, error: 'This listing is already being published. Please wait a moment and check Live Listings.' });
  }

  const importRecord = await getImportById(userId, listing.import_id);
  if (!importRecord || !importRecord.product) {
    const updated = await markError(userId, id, 'The linked Amazon product data could not be found.');
    return res.status(404).json({ success: false, error: 'The linked Amazon product data could not be found.', listing: updated });
  }

  const sellerSettings = await getEbayAccountById(userId, targetAccountId);
  if (!sellerSettings) {
    const updated = await markError(userId, id, 'That eBay account was not found. Please reconnect it in Settings.');
    return res.status(400).json({ success: false, error: 'That eBay account was not found. Please reconnect it in Settings.', listing: updated });
  }

  let charged = false;
  try {
    const refreshToken = await getEbayAccountRefreshToken(userId, targetAccountId);
    if (!refreshToken) throw Object.assign(new Error('The selected eBay account is not connected. Please reconnect it.'), { statusCode: 400 });

    if (sellerSettings.productLocationMode === 'custom' && sellerSettings.customCountryCode && sellerSettings.customPostalCode) {
      const customLocationKey = await createOrGetCustomLocation(
        refreshToken,
        sellerSettings.customCountryCode,
        sellerSettings.customPostalCode
      );
      sellerSettings.merchantLocationKey = customLocationKey;
    }

    charged = await spendCredit(userId, ACTION_COSTS.REPUBLISH);
    if (!charged) throw Object.assign(new Error('Could not reserve a republish credit. Please try again.'), { statusCode: 402 });

    const product = { ...importRecord.product, title: listing.title || importRecord.product.title, images: listing.images_customized ? (listing.images || []) : (listing.images?.length ? listing.images : (importRecord.product.images || [])), ebayAspects: aspects && typeof aspects === 'object' ? aspects : importRecord.product.ebayAspects };
    const result = await publishListing({
      refreshToken,
      product,
      sellPrice: listing.sell_price,
      quantity: listing.quantity,
      categoryId: listing.category_id,
      sku: listing.sku,
      sellerSettings,
    });

    const updated = await markPublished(userId, id, {
      offerId: result.offerId,
      listingId: result.listingId,
      ebayAccountId: targetAccountId,
    });
    res.json({ success: true, listing: updated });
  } catch (err) {
    console.error('republish error:', err.message);
    if (charged) await refundCredit(userId, ACTION_COSTS.REPUBLISH);
    const updated = await markError(userId, id, err.message);
    res.status(err.statusCode || 500).json({
      success: false,
      error: err.message || 'Could not republish this listing.',
      ebayErrors: err.ebayErrors || null,
      listing: updated,
    });
  }
});

/**
 * POST /api/listings/bulk-delete
 * Deletes multiple non-live drafts in one request. Published listings are
 * intentionally rejected here so a bulk action can never accidentally end
 * live eBay inventory.
 */
router.post('/bulk-delete', requireAuth, async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map(String))].slice(0, 100) : [];
  if (!ids.length) return res.status(400).json({ success: false, error: 'Select at least one draft.' });
  const Listing = require('../models/schemas/Listing');
  const docs = await Listing.find({ _id: { $in: ids }, userId: req.userId });
  const blocked = docs.filter((d) => d.status === 'published' || d.status === 'publishing');
  if (blocked.length) return res.status(400).json({ success: false, error: 'Live or currently publishing listings cannot be bulk deleted.', blocked: blocked.map((d) => String(d._id)) });
  const result = await Listing.deleteMany({ _id: { $in: docs.map((d) => d._id) }, userId: req.userId, status: { $in: ['draft', 'error', 'scheduled'] } });
  res.json({ success: true, deletedCount: result.deletedCount || 0 });
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
    if (!listing.ebay_account_id) {
      return res.status(400).json({
        success: false,
        error: 'This listing is still live on eBay, but its eBay account could not be determined, so it cannot be withdrawn safely. Please contact support.',
      });
    }

    const refreshToken = await getEbayAccountRefreshToken(userId, listing.ebay_account_id);
    if (!refreshToken) {
      return res.status(400).json({
        success: false,
        error: 'This listing is still live on eBay, but its eBay account is not connected, so it cannot be withdrawn. Please reconnect that eBay account and try again.',
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
  let { accountId, aspects } = req.body;
  const userId = req.userId;

  // If the user has exactly one connected account, use it automatically.
  // This also protects against a frontend timing/race issue where the account
  // selector has not finished loading yet. With multiple accounts, an explicit
  // accountId is still required.
  if (!accountId) {
    const accounts = await listEbayAccounts(userId);
    if (accounts.length === 1) accountId = accounts[0].id;
    else {
      const active = accounts.find((a) => a.isActive);
      if (active && accounts.length > 1) {
        return res.status(400).json({ success: false, error: 'Please choose which eBay account to publish to.' });
      }
      return res.status(400).json({ success: false, error: 'Please connect an eBay account first.' });
    }
  }
  if (!(await hasCredits(userId, ACTION_COSTS.EBAY_PUBLISH))) {
    return res.status(402).json({
      success: false,
      error: 'You have run out of credits. Please open a support ticket to request more.',
    });
  }

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

  // Queue the publish job and return immediately. The worker performs the
  // eBay API calls in the background, so the browser is never blocked by a
  // slow eBay response. Status changes to published/error are persisted.
  const claimed = await claimListingForPublishing(userId, id);
  if (!claimed) {
    return res.status(409).json({ success: false, error: 'This listing is already queued or being published. Check Drafts or Notifications.' });
  }

  res.status(202).json({
    success: true,
    queued: true,
    message: 'Publish queued. You can continue working while ELMS publishes this listing in the background.',
    listing: claimed,
  });
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
  let { accountId } = req.body;

  // A single connected account is automatically used for scheduling too.
  if (!accountId) {
    const accounts = await listEbayAccounts(userId);
    if (accounts.length === 1) accountId = accounts[0].id;
    else if (accounts.length > 1) {
      return res.status(400).json({ success: false, error: 'Please choose which eBay account to publish to.' });
    }
  }

  if (!scheduledAt) {
    return res.status(400).json({ success: false, error: 'A scheduledAt date/time is required.' });
  }
  if (!accountId) {
    return res.status(400).json({ success: false, error: 'Please choose which eBay account to publish to.' });
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

  const account = await getEbayAccountById(userId, accountId);
  if (!account) {
    return res.status(400).json({ success: false, error: 'That eBay account was not found. Please reconnect it in Settings.' });
  }

  const updated = await scheduleListing(userId, id, date, accountId);
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
