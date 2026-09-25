const express = require('express');
const router = express.Router();

const {
  listListings,
  listListingsByStatuses,
  countListingsByStatus,
  getListingById,
  getListingStatuses,
  claimListingForPublishing,
  markPublished,
  markError,
  markPaused,
  resetErrorToDraft,
  deleteListing,
  scheduleListing,
  unscheduleListing,
  updateListing,
  updateListingSettings,
  updateListingStats,
} = require('../models/listingsModel');

const { fetchItemTraffic } = require('../services/ebayStatsService');
const { syncStatsForAccount } = require('../services/listingStatsService');

const {
  publishListing,
  publishExistingOffer,
  deleteOffer,
  withdrawListing,
  reviseActiveListing,
  fetchLiveListing,
  createOrGetCustomLocation,
} = require('../services/ebayListingService');
const { aspectsForListing, compareLive } = require('../services/liveListingSync');
const { sourceCurrency } = require('../config/amazonDomains');

const {
  processOneQueuedListing,
} = require('../services/publishQueueService');

const {
  listEbayAccounts,
  getEbayAccountById,
  getEbayAccountRefreshToken,
} = require('../models/ebayAccountsModel');

const { getImportById } = require('../models/importsModel');
const { checkAspects } = require('../services/publishPreflightService');

const { requireAuth } = require('../middleware/requireAuth');
const { enqueuePublish } = require('../services/publishRunner');

const {
  hasCredits,
  spendCredit,
  refundCredit,
} = require('../models/usersModel');

const { ACTION_COSTS } = require('../config/actionCosts');

/**
 * GET /api/listings/queue
 * Requires a valid session token.
 *
 * Query:
 * ?statuses=draft,scheduled,error,publishing
 */
router.get('/queue', requireAuth, async (req, res) => {
  try {
    const statuses = String(
      req.query.statuses || 'draft,scheduled,error,publishing'
    )
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((s) =>
        ['draft', 'scheduled', 'error', 'publishing'].includes(s)
      );

    const listings = await listListingsByStatuses(
      req.userId,
      statuses,
      req.query.accountId || null
    );

    res.json({
      success: true,
      listings,
    });
  } catch (err) {
    console.error(
      'listings queue error:',
      err.message
    );

    res.status(500).json({
      success: false,
      error: 'Could not load the listing queue.',
    });
  }
});

/**
 * GET /api/listings/counts
 */
router.get('/counts', requireAuth, async (req, res) => {
  try {
    const [
      draft,
      scheduled,
      error,
      publishing,
      published,
    ] = await Promise.all(
      ['draft', 'scheduled', 'error', 'publishing', 'published'].map((status) =>
        countListingsByStatus(req.userId, status, req.query.accountId || null)
      )
    );

    res.json({
      success: true,
      counts: {
        draft,
        scheduled,
        error,
        publishing,
        published,
      },
    });
  } catch (err) {
    console.error(
      'listings counts error:',
      err.message
    );

    res.status(500).json({
      success: false,
      error: 'Could not load listing counts.',
    });
  }
});

/**
 * GET /api/listings/publish-status?ids=a,b,c
 * Where each of these listings is in its publish: still "publishing", or done ("published" / "error" with the reason).
 * The app polls this after starting a background publish. Must stay above GET /:id.
 */
router.get('/publish-status', requireAuth, async (req, res) => {
  try {
    const ids = String(req.query.ids || '').split(',');
    const statuses = await getListingStatuses(req.userId, ids);
    res.json({ success: true, statuses });
  } catch (err) {
    console.error('publish-status error:', err.message);
    res.status(500).json({ success: false, error: 'Could not read the publish status.' });
  }
});

/**
 * GET /api/listings
 */
router.get('/', requireAuth, async (req, res) => {
  try {
    const rawStatus = req.query.status ? String(req.query.status) : '';
    const statuses = rawStatus.split(',').map((s) => s.trim()).filter(Boolean);
    const allowed = new Set(['draft', 'publishing', 'scheduled', 'published', 'paused', 'error', 'ended']);
    const cleanStatuses = statuses.filter((s) => allowed.has(s));
    const listings = cleanStatuses.length > 1
      ? await listListingsByStatuses(req.userId, cleanStatuses, req.query.accountId || null)
      : await listListings(req.userId, cleanStatuses[0] || null, req.query.accountId || null);

    res.json({
      success: true,
      listings,
    });
  } catch (err) {
    console.error(
      'listings list error:',
      err.message
    );

    res.status(500).json({
      success: false,
      error: 'Could not load listings.',
    });
  }
});

/**
 * GET /api/listings/:id
 */
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const listing = await getListingById(
      req.userId,
      req.params.id
    );

    if (!listing) {
      return res.status(404).json({
        success: false,
        error: 'Listing not found.',
      });
    }

    return res.json({
      success: true,
      listing,
    });
  } catch (err) {
    console.error(
      'listing get error:',
      err.message
    );

    return res.status(500).json({
      success: false,
      error: 'Could not load the listing.',
    });
  }
});

/**
 * GET /api/listings/:id/detail
 * Returns the saved listing plus its linked Amazon product data.
 * This is intentionally read-only: opening Edit Draft must never trigger
 * another Amazon/Canopy fetch or consume an API credit.
 */
router.get('/:id/detail', requireAuth, async (req, res) => {
  try {
    const listing = await getListingById(req.userId, req.params.id);

    if (!listing) {
      return res.status(404).json({
        success: false,
        error: 'Listing not found.',
      });
    }

    let product = null;
    if (listing.import_id) {
      const importRecord = await getImportById(
        req.userId,
        listing.import_id
      );
      product = importRecord ? importRecord.product : null;
    }

    return res.json({
      success: true,
      listing,
      product,
    });
  } catch (err) {
    console.error('listing detail error:', err.message);
    return res.status(500).json({
      success: false,
      error: 'Could not load the listing details.',
    });
  }
});

/**
 * POST /api/listings/:id/publish
 *
 * Claims the listing and immediately processes it.
 *
 * This is the instant-publish path:
 *
 * draft
 *   ↓
 * claimListingForPublishing
 *   ↓
 * processOneQueuedListing
 *   ↓
 * eBay Inventory Item
 *   ↓
 * eBay Offer
 *   ↓
 * eBay Publish
 */
router.post('/:id/publish', requireAuth, async (req, res) => {
  let claimed = null;

  try {
    const listingId = req.params.id;

    const listing = await getListingById(
      req.userId,
      listingId
    );

    if (!listing) {
      return res.status(404).json({
        success: false,
        error: 'Listing not found.',
      });
    }

    if (
      listing.status === 'published' ||
      listing.status === 'publishing'
    ) {
      return res.status(409).json({
        success: false,
        error:
          'This listing is already published or is currently being published.',
      });
    }

    // The publish credit is charged (and refunded on failure) by processOneQueuedListing itself.
    // Charging here as well took TWO credits per publish, and the extra one was never refunded.
    claimed =
      await claimListingForPublishing(
        req.userId,
        listingId
      );

    if (!claimed) {
      return res.status(409).json({
        success: false,
        error:
          'This listing is already being processed or cannot be published.',
      });
    }

    // Background publish: the listing is claimed (status "publishing"), so answer at once and let the runner do the slow part
    // with eBay. The result is read back from the listing (GET /publish-status).
    if (req.body && req.body.background === true) {
      enqueuePublish(req.userId, claimed);
      return res.status(202).json({ success: true, queued: true, listing: claimed });
    }

    /**
     * IMPORTANT:
     * This import fixes the previous
     *
     * ReferenceError:
     * processOneQueuedListing is not defined
     *
     * The function is exported by publishQueueService.js.
     */
    const published =
      await processOneQueuedListing(
        claimed
      );

    // processOneQueuedListing reports a failed publish by returning the listing in "error" status
    // (it does not throw), so answering success here made the UI say "Published" for a failure.
    if (published && published.status === 'error') {
      return res.status(502).json({
        success: false,
        error: published.error_message || 'eBay publishing failed.',
        listing: published,
      });
    }

    return res.json({
      success: true,
      listing: published,
    });
  } catch (err) {
    console.error(
      'instant listing publish error:',
      err
    );

    if (claimed) {
      try {
        await markError(
          req.userId,
          claimed._id || claimed.id,
          err.message ||
            'eBay listing publish failed.'
        );
      } catch (markErr) {
        console.error(
          'failed to mark listing error:',
          markErr.message
        );
      }
    }

    return res.status(
      Number(err.statusCode) >= 400
        ? Number(err.statusCode)
        : 500
    ).json({
      success: false,
      error:
        err.message ||
        'Something went wrong while publishing the listing.',
      ebayErrors:
        err.ebayErrors || undefined,
    });
  }
});

/**
 * POST /api/listings/:id/retry
 *
 * Resets an errored listing back to draft.
 */
router.post('/:id/retry', requireAuth, async (req, res) => {
  try {
    const listing =
      await getListingById(
        req.userId,
        req.params.id
      );

    if (!listing) {
      return res.status(404).json({
        success: false,
        error: 'Listing not found.',
      });
    }

    if (listing.status !== 'error') {
      return res.status(409).json({
        success: false,
        error:
          'Only errored listings can be retried.',
      });
    }

    const updated =
      await resetErrorToDraft(
        req.userId,
        req.params.id
      );

    return res.json({
      success: true,
      listing: updated,
    });
  } catch (err) {
    console.error(
      'listing retry error:',
      err.message
    );

    return res.status(500).json({
      success: false,
      error:
        err.message ||
        'Could not retry the listing.',
    });
  }
});

/**
 * POST /api/listings/:id/schedule
 */
router.post('/:id/schedule', requireAuth, async (req, res) => {
  try {
    const scheduledAt =
      req.body?.scheduledAt ||
      req.body?.publishAt;

    if (!scheduledAt) {
      return res.status(400).json({
        success: false,
        error:
          'scheduledAt is required.',
      });
    }

    const listing =
      await getListingById(
        req.userId,
        req.params.id
      );

    if (!listing) {
      return res.status(404).json({
        success: false,
        error: 'Listing not found.',
      });
    }

    const updated =
      await scheduleListing(
        req.userId,
        req.params.id,
        scheduledAt
      );

    return res.json({
      success: true,
      listing: updated,
    });
  } catch (err) {
    console.error(
      'listing schedule error:',
      err.message
    );

    return res.status(500).json({
      success: false,
      error:
        err.message ||
        'Could not schedule the listing.',
    });
  }
});

/**
 * POST /api/listings/:id/unschedule
 */
router.post(
  '/:id/unschedule',
  requireAuth,
  async (req, res) => {
    try {
      const listing =
        await getListingById(
          req.userId,
          req.params.id
        );

      if (!listing) {
        return res.status(404).json({
          success: false,
          error: 'Listing not found.',
        });
      }

      const updated =
        await unscheduleListing(
          req.userId,
          req.params.id
        );

      return res.json({
        success: true,
        listing: updated,
      });
    } catch (err) {
      console.error(
        'listing unschedule error:',
        err.message
      );

      return res.status(500).json({
        success: false,
        error:
          err.message ||
          'Could not unschedule the listing.',
      });
    }
  }
);

/**
 * DELETE /api/listings/:id
 */
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const listing = await getListingById(req.userId, req.params.id);
    if (!listing) return res.status(404).json({ success: false, error: 'Listing not found.' });

    const offerId = listing.ebay_offer_id;
    const accountId = listing.ebay_account_id;

    if (offerId && accountId) {
      const refreshToken = await getEbayAccountRefreshToken(req.userId, accountId);
      if (!refreshToken) {
        return res.status(400).json({ success: false, error: 'The connected eBay account is missing a refresh token.' });
      }
      // Permanent delete: eBay deletes the offer object and ends the live listing.
      await deleteOffer(refreshToken, offerId);
    }

    await deleteListing(req.userId, req.params.id);
    return res.json({ success: true });
  } catch (err) {
    console.error('listing delete error:', err.message);
    return res.status(Number(err.statusCode) >= 400 ? Number(err.statusCode) : 500).json({
      success: false,
      error: err.message || 'Could not delete the listing/offer.',
    });
  }
});

/**
 * POST /api/listings/bulk-delete
 * Body: { ids: string[] }
 *
 * Deletes several listings at once (the Drafts page's "select several -> Remove" bar).
 * Same per-listing logic as DELETE /:id (ends the eBay offer first if the listing is
 * live) - one bad id doesn't stop the rest, so the response reports how many actually
 * got deleted plus a message for each one that failed.
 */
router.post('/bulk-delete', requireAuth, async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(Boolean) : [];
  if (!ids.length) return res.status(400).json({ success: false, error: 'ids must be a non-empty array.' });

  let deletedCount = 0;
  const errors = [];
  for (const id of ids) {
    try {
      const listing = await getListingById(req.userId, id);
      if (!listing) { errors.push(`${id}: not found.`); continue; }

      if (listing.ebay_offer_id && listing.ebay_account_id) {
        const refreshToken = await getEbayAccountRefreshToken(req.userId, listing.ebay_account_id);
        if (!refreshToken) { errors.push(`${listing.title || id}: the connected eBay account is missing a refresh token.`); continue; }
        await deleteOffer(refreshToken, listing.ebay_offer_id);
      }

      await deleteListing(req.userId, id);
      deletedCount += 1;
    } catch (err) {
      console.error(`bulk listing delete error for ${id}:`, err.message);
      errors.push(`${id}: ${err.message || 'Could not delete.'}`);
    }
  }

  res.json({ success: true, deletedCount, errors: errors.length ? errors : undefined });
});

const MAX_BULK_IDS = 500;
const bulkIds = (body) => Array.from(new Set((Array.isArray(body?.ids) ? body.ids : []).map((id) => String(id || '').trim()).filter(Boolean)));

/**
 * POST /api/listings/bulk-pricing   { ids: [...], profitPercent: 10 }
 *
 * Puts every selected draft on the same profit: eBay price = Amazon cost + profitPercent%
 * (the same "markup" the drafts already store and show), rounded to cents. Works for a single id too
 * (the quick "%" box in the draft editor). Only drafts (and failed drafts) are repriced; a live listing is
 * revised on eBay instead. A draft with no Amazon price saved cannot be priced - it is reported, not guessed.
 * One bad id never stops the rest.
 */
router.post('/bulk-pricing', requireAuth, async (req, res) => {
  const ids = bulkIds(req.body);
  if (!ids.length) return res.status(400).json({ success: false, error: 'ids must be a non-empty array.' });
  if (ids.length > MAX_BULK_IDS) return res.status(400).json({ success: false, error: `Please change at most ${MAX_BULK_IDS} drafts at a time.` });
  const raw = req.body?.profitPercent;
  const percent = raw === '' || raw === null || raw === undefined ? NaN : Number(raw);
  if (!Number.isFinite(percent) || percent < -99 || percent > 1000) {
    return res.status(400).json({ success: false, error: 'Enter the profit as a number between -99 and 1000.' });
  }

  let updated = 0;
  const skipped = [];
  const prices = {};
  for (const id of ids) {
    try {
      const listing = await getListingById(req.userId, id);
      if (!listing) { skipped.push({ id, title: null, reason: 'Not found.' }); continue; }
      const label = listing.title || listing.sku || id;
      if (!['draft', 'error'].includes(listing.status)) { skipped.push({ id, title: label, reason: 'Only drafts can be repriced here. Live listings are revised on eBay.' }); continue; }
      // The cost the draft screen shows: the price saved on the draft, else the one on its Amazon import.
      let amazon = Number(listing.amazon_price);
      let fromImport = false;
      if (!(amazon > 0) && listing.import_id) {
        const imp = await getImportById(req.userId, listing.import_id);
        amazon = Number(imp?.amazon_price);
        if (!(amazon > 0)) amazon = Number(imp?.product?.price);
        fromImport = amazon > 0;
      }
      if (!Number.isFinite(amazon) || amazon <= 0) { skipped.push({ id, title: label, reason: 'No Amazon price is saved for this product.' }); continue; }
      const sellPrice = Number((amazon * (1 + percent / 100)).toFixed(2));
      if (!(sellPrice > 0)) { skipped.push({ id, title: label, reason: 'That percentage gives a price of zero.' }); continue; }
      await updateListing(req.userId, id, { sellPrice, markupPercent: percent, marginAmount: Number((sellPrice - amazon).toFixed(2)), ...(fromImport ? { amazonPrice: amazon } : {}) });
      prices[id] = sellPrice;
      updated += 1;
    } catch (err) {
      console.error(`bulk pricing error for ${id}:`, err.message);
      skipped.push({ id, title: null, reason: err.message || 'Could not update.' });
    }
  }
  res.json({ success: true, updated, skipped, profitPercent: percent, prices });
});

/**
 * PATCH /api/listings/bulk-settings   { ids: [...], useDynamicPolicies?, paymentPolicyId?, fulfillmentPolicyId?, returnPolicyId? }
 *
 * Changes the business policies of every selected draft at once. Only the fields sent are changed (so a policy
 * left out stays as it is). useDynamicPolicies true = the eBay account's default policies; false = the ids apply.
 */
router.patch('/bulk-settings', requireAuth, async (req, res) => {
  const ids = bulkIds(req.body);
  if (!ids.length) return res.status(400).json({ success: false, error: 'ids must be a non-empty array.' });
  if (ids.length > MAX_BULK_IDS) return res.status(400).json({ success: false, error: `Please change at most ${MAX_BULK_IDS} drafts at a time.` });
  const fields = {};
  for (const key of ['useDynamicPolicies', 'paymentPolicyId', 'fulfillmentPolicyId', 'returnPolicyId']) {
    if (req.body?.[key] !== undefined) fields[key] = req.body[key];
  }
  if (!Object.keys(fields).length) return res.status(400).json({ success: false, error: 'Choose at least one policy to change.' });

  let updated = 0;
  const skipped = [];
  for (const id of ids) {
    try {
      const listing = await updateListingSettings(req.userId, id, fields);
      if (listing) updated += 1; else skipped.push({ id, title: null, reason: 'Not found.' });
    } catch (err) {
      console.error(`bulk settings error for ${id}:`, err.message);
      skipped.push({ id, title: null, reason: err.message || 'Could not update.' });
    }
  }
  res.json({ success: true, updated, skipped });
});

const MAX_AI_BATCH = 25;

/** GET /api/listings/bulk-aspects/cost - what one AI item-specifics fill costs right now (the admin sets it). */
router.get('/bulk-aspects/cost', requireAuth, (req, res) => {
  res.json({ success: true, cost: Number(ACTION_COSTS.AI_ASPECTS || 0) });
});

/**
 * POST /api/listings/bulk-aspects   { ids: [...] }
 *
 * AI fills and SAVES the eBay item specifics of every selected draft (see services/listingAspectFillService.js), so publishing
 * them does not stop on a missing specific. Each draft that really gets new specifics costs the admin-set AI_ASPECTS credits
 * (10 drafts at 2 credits = 20); a draft that is skipped, fails, or where the AI adds nothing costs nothing. One draft failing
 * never stops the others. At most 25 per request - the app sends bigger selections in several requests.
 */
router.post('/bulk-aspects', requireAuth, async (req, res) => {
  const ids = bulkIds(req.body);
  if (!ids.length) return res.status(400).json({ success: false, error: 'ids must be a non-empty array.' });
  if (ids.length > MAX_AI_BATCH) return res.status(400).json({ success: false, error: `Please fill at most ${MAX_AI_BATCH} drafts per request.` });
  try {
    const { getAiSettings } = require('../models/settingsModel');
    const settings = await getAiSettings();
    if (!settings.aiAspectsEnabled) return res.status(403).json({ success: false, error: 'This AI feature is turned off by the administrator.' });
    const { fillManyDraftAspects } = require('../services/listingAspectFillService');
    const results = await fillManyDraftAspects(req.userId, ids);
    res.json({
      success: true,
      results,
      filled: results.filter((r) => r.status === 'filled').length,
      creditsUsed: results.reduce((sum, r) => sum + (r.creditsUsed || 0), 0),
      cost: Number(ACTION_COSTS.AI_ASPECTS || 0),
    });
  } catch (err) {
    console.error('bulk aspects error:', err.message);
    res.status(500).json({ success: false, error: 'Could not fill the item specifics. Please try again.' });
  }
});

/**
 * POST /api/listings/:id/pause
 * Withdraws the eBay offer but keeps the offer object and ELMS listing.
 */
router.post('/:id/pause', requireAuth, async (req, res) => {
  try {
    const listing = await getListingById(req.userId, req.params.id);
    if (!listing) return res.status(404).json({ success: false, error: 'Listing not found.' });
    if (listing.status !== 'published') return res.status(409).json({ success: false, error: 'Only an active eBay listing can be paused.' });
    if (!listing.ebay_offer_id) return res.status(400).json({ success: false, error: 'This listing does not have an eBay offer ID.' });
    if (!listing.ebay_account_id) return res.status(400).json({ success: false, error: 'No eBay account is associated with this listing.' });

    const refreshToken = await getEbayAccountRefreshToken(req.userId, listing.ebay_account_id);
    if (!refreshToken) return res.status(400).json({ success: false, error: 'The connected eBay account is missing a refresh token.' });

    await withdrawListing(refreshToken, listing.ebay_offer_id);
    const paused = await markPaused(req.userId, req.params.id);
    return res.json({ success: true, listing: paused });
  } catch (err) {
    console.error('listing pause error:', err.message);
    return res.status(Number(err.statusCode) >= 400 ? Number(err.statusCode) : 500).json({ success: false, error: err.message || 'Could not pause the eBay listing.' });
  }
});

/**
 * POST /api/listings/:id/resume
 * Republishes the existing unpublished offer. No new offer is created.
 */
router.post('/:id/resume', requireAuth, async (req, res) => {
  try {
    const listing = await getListingById(req.userId, req.params.id);
    if (!listing) return res.status(404).json({ success: false, error: 'Listing not found.' });
    if (listing.status !== 'paused') return res.status(409).json({ success: false, error: 'Only a paused listing can be resumed.' });
    if (!listing.ebay_offer_id) return res.status(400).json({ success: false, error: 'This listing does not have an eBay offer ID.' });
    if (!listing.ebay_account_id) return res.status(400).json({ success: false, error: 'No eBay account is associated with this listing.' });

    const refreshToken = await getEbayAccountRefreshToken(req.userId, listing.ebay_account_id);
    if (!refreshToken) return res.status(400).json({ success: false, error: 'The connected eBay account is missing a refresh token.' });

    const result = await publishExistingOffer(refreshToken, listing.ebay_offer_id);
    const resumed = await markPublished(req.userId, req.params.id, {
      offerId: listing.ebay_offer_id,
      listingId: result?.listingId || listing.ebay_listing_id || null,
      ebayAccountId: listing.ebay_account_id,
      publishResponse: result || null,
      ebayImageUrls: listing.ebay_image_urls || [],
    });
    return res.json({ success: true, listing: resumed });
  } catch (err) {
    console.error('listing resume error:', err.message);
    return res.status(Number(err.statusCode) >= 400 ? Number(err.statusCode) : 500).json({ success: false, error: err.message || 'Could not resume the eBay listing.' });
  }
});

/**
 * POST /api/listings/:id/withdraw
 *
 * Withdraw an active eBay listing.
 */
router.post(
  '/:id/withdraw',
  requireAuth,
  async (req, res) => {
    try {
      const listing =
        await getListingById(
          req.userId,
          req.params.id
        );

      if (!listing) {
        return res.status(404).json({
          success: false,
          error: 'Listing not found.',
        });
      }

      if (!listing.ebay_offer_id) {
        return res.status(400).json({
          success: false,
          error:
            'This listing does not have an eBay offer ID.',
        });
      }

      const accountId = listing.ebay_account_id;

      if (!accountId) {
        return res.status(400).json({
          success: false,
          error:
            'No eBay account is associated with this listing.',
        });
      }

      const refreshToken =
        await getEbayAccountRefreshToken(
          req.userId,
          accountId
        );

      if (!refreshToken) {
        return res.status(400).json({
          success: false,
          error:
            'The connected eBay account is missing a refresh token.',
        });
      }

      await withdrawListing(
        refreshToken,
        listing.ebay_offer_id
      );

      return res.json({
        success: true,
      });
    } catch (err) {
      console.error(
        'listing withdraw error:',
        err.message
      );

      return res.status(
        Number(err.statusCode) >= 400
          ? Number(err.statusCode)
          : 500
      ).json({
        success: false,
        error:
          err.message ||
          'Could not withdraw the eBay listing.',
      });
    }
  }
);

/** The eBay side of a live listing, or a reason it cannot be read: { listing, refreshToken } or { error, status }. */
async function liveListingContext(userId, id) {
  const listing = await getListingById(userId, id);
  if (!listing) return { status: 404, error: 'Listing not found.' };
  if (!listing.ebay_offer_id) return { status: 400, error: 'This listing does not have an eBay offer ID.' };
  if (!listing.ebay_account_id) return { status: 400, error: 'No eBay account is associated with this listing.' };
  const refreshToken = await getEbayAccountRefreshToken(userId, listing.ebay_account_id);
  if (!refreshToken) return { status: 400, error: 'The connected eBay account is missing a refresh token.' };
  return { listing, refreshToken };
}

const POLICY_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * GET /api/listings/:id/live
 *
 * What eBay really holds for this live listing (title, price, quantity, category, item specifics, description, pictures,
 * business policies). The editor of a live listing shows this, not ELMS' older copy, and ELMS' copy is brought in step
 * (never the price: ELMS may keep it in the currency the draft was made in).
 */
router.get('/:id/live', requireAuth, async (req, res) => {
  try {
    const ctx = await liveListingContext(req.userId, req.params.id);
    if (ctx.error) return res.status(ctx.status).json({ success: false, error: ctx.error });
    const { listing, refreshToken } = ctx;

    const live = await fetchLiveListing(refreshToken, { offerId: listing.ebay_offer_id, sku: listing.sku });

    const changes = {};
    if (live.title && live.title !== listing.title) changes.title = live.title;
    if (live.quantity !== null && live.quantity !== Number(listing.quantity)) changes.quantity = live.quantity;
    if (live.categoryId && live.categoryId !== String(listing.category_id || '')) changes.categoryId = live.categoryId;
    const ebayAspects = aspectsForListing(live.aspects);
    if (JSON.stringify(ebayAspects) !== JSON.stringify(listing.ebay_aspects || {})) changes.ebayAspects = ebayAspects;
    let saved = listing;
    if (Object.keys(changes).length) {
      try {
        saved = (await updateListing(req.userId, listing.id, { ...changes, markDraftCustomized: false })) || listing;
      } catch (saveErr) {
        console.warn('live listing sync: could not save ELMS copy:', saveErr.message);
      }
    }
    return res.json({ success: true, live, listing: saved });
  } catch (err) {
    console.error('listing live error:', err.message);
    return res.status(Number(err.statusCode) >= 400 ? Number(err.statusCode) : 500).json({ success: false, error: err.message || 'Could not read the live listing from eBay.' });
  }
});

/**
 * POST /api/listings/:id/revise
 *
 * Updates a live eBay listing with what the seller changed in the editor, reads the listing back from eBay, and keeps
 * ELMS' copy the same as eBay's (so nothing goes back to an older value after a refresh). `notApplied` names every change
 * eBay did not take, with the reason.
 *
 * Body (all optional): title, description, images, aspects (only the ones that changed), clearAspects, sellPrice, quantity,
 * categoryId, marketplaceId, paymentPolicyId / fulfillmentPolicyId / returnPolicyId (blank = the account's default),
 * countryLocation + postalCode (item location), useDynamicPolicies.
 */
router.post('/:id/revise', requireAuth, async (req, res) => {
  try {
    const ctx = await liveListingContext(req.userId, req.params.id);
    if (ctx.error) return res.status(ctx.status).json({ success: false, error: ctx.error });
    const { listing, refreshToken } = ctx;
    const body = req.body || {};

    // `listing` is the serialised (snake_case) record, so its fields are sell_price / category_id / ...
    const categoryId = body.categoryId || listing.category_id;
    const marketplaceId = body.marketplaceId || listing.marketplace_id || 'EBAY_US';

    // Item specifics: only the ones that changed are sent; their values are matched to eBay's allowed values like a publish does
    // (without filling the required ones that were not touched - eBay already holds those).
    const requestedAspects = body.aspects && typeof body.aspects === 'object' ? body.aspects : (body.ebayAspects && typeof body.ebayAspects === 'object' ? body.ebayAspects : null);
    let aspects = requestedAspects;
    let notes = [];
    const droppedAspects = [];
    if (requestedAspects && Object.keys(requestedAspects).length && categoryId) {
      const checked = await checkAspects({ categoryId, marketplaceId, product: { ebayAspects: requestedAspects }, aspectsOnly: true, fillRequired: false });
      if (checked.aspects) {
        aspects = checked.aspects;
        notes = checked.notes || [];
        const kept = new Set(Object.keys(aspects).map((n) => n.toLowerCase()));
        for (const name of Object.keys(requestedAspects)) if (!kept.has(String(name).toLowerCase())) droppedAspects.push(name);
      }
    }
    const clearAspects = Array.isArray(body.clearAspects) ? body.clearAspects.map((n) => String(n).slice(0, 65)).slice(0, 60) : [];

    // Business policies: a blank one means "the account's default".
    let policies;
    if (body.useDynamicPolicies !== true && ['paymentPolicyId', 'fulfillmentPolicyId', 'returnPolicyId'].some((k) => body[k] !== undefined)) {
      const account = await getEbayAccountById(req.userId, listing.ebay_account_id);
      const policyOf = (key) => {
        if (body[key] === undefined) return undefined;
        const v = String(body[key] || '').trim();
        if (v && !POLICY_ID.test(v)) return undefined;
        return v || account?.[key] || undefined;
      };
      policies = { paymentPolicyId: policyOf('paymentPolicyId'), fulfillmentPolicyId: policyOf('fulfillmentPolicyId'), returnPolicyId: policyOf('returnPolicyId') };
    }

    // Item location: a country + postal code saved on the product becomes an eBay inventory location.
    let merchantLocationKey;
    const country = String(body.countryLocation || '').trim().toUpperCase().replace(/^UK$/, 'GB');
    const postalCode = String(body.postalCode || '').trim();
    if (country && postalCode) merchantLocationKey = await createOrGetCustomLocation(refreshToken, country, postalCode);

    // The price is in the currency of the Amazon site it was read from (or the draft's) - eBay's offer is in the store's.
    const importRecord = listing.import_id ? await getImportById(req.userId, listing.import_id).catch(() => null) : null;
    const priceCurrency = sourceCurrency(importRecord?.amazon_url, listing.currency);
    const sellPrice = body.sellPrice ?? listing.sell_price;
    const quantity = body.quantity ?? listing.quantity;
    const descriptionSent = typeof body.description === 'string' && body.description.trim() ? body.description : null;
    const imagesSent = Array.isArray(body.images) && body.images.length
      ? Array.from(new Set(body.images.map((u) => String(u || '').trim()).filter((u) => /^https?:\/\//i.test(u)))).slice(0, 24)
      : null;

    const result = await reviseActiveListing(refreshToken, {
      offerId: listing.ebay_offer_id,
      sku: listing.sku,
      title: body.title,
      description: descriptionSent,
      images: imagesSent || undefined,
      aspects: aspects || undefined,
      clearAspects,
      sellPrice,
      priceCurrency,
      quantity,
      categoryId,
      policies,
      merchantLocationKey,
    });

    // What did eBay keep?
    const live = result.live;
    const notApplied = compareLive({
      ...(body.title !== undefined ? { title: body.title } : {}),
      price: result.pushedPrice,
      quantity: result.quantity,
      categoryId: body.categoryId || undefined,
      aspects: aspects || undefined,
      clearAspects,
      ...(descriptionSent ? { description: descriptionSent } : {}),
      ...(imagesSent ? { imageCount: imagesSent.length } : {}),
      policies,
      merchantLocationKey,
    }, live);
    for (const name of droppedAspects) {
      const k = live && Object.keys(live.aspects).find((n) => n.toLowerCase() === String(name).toLowerCase());
      notApplied.push({ field: 'aspect:' + name, label: name, sent: [].concat(requestedAspects[name]).join(', '), ebay: k ? [].concat(live.aspects[k]).join(', ') : '', reason: 'That value is not one of eBay\'s allowed values for this category.' });
    }
    const refused = new Set(notApplied.map((n) => n.field));

    // ELMS keeps what eBay holds now.
    const amazonPrice = Number(listing.amazon_price);
    const priceNumber = Number(sellPrice);
    const save = {
      ...(body.title !== undefined ? { title: live?.title || String(body.title).slice(0, 80) } : {}),
      sellPrice: priceNumber,
      ...(Number.isFinite(amazonPrice) && amazonPrice > 0 && Number.isFinite(priceNumber) ? { marginAmount: Number((priceNumber - amazonPrice).toFixed(2)) } : {}),
      quantity: live?.quantity ?? result.quantity,
      categoryId: live?.categoryId || result.categoryId || categoryId,
      ebayAspects: live ? aspectsForListing(live.aspects) : (result.sentAspects ? aspectsForListing(result.sentAspects) : undefined),
      ...(descriptionSent ? { description: descriptionSent } : {}),
      ...(imagesSent ? { images: imagesSent } : {}),
      markDraftCustomized: false,
    };
    if (policies) for (const key of ['paymentPolicyId', 'fulfillmentPolicyId', 'returnPolicyId']) if (body[key] !== undefined && !refused.has('policy:' + key)) save[key] = body[key];
    if (merchantLocationKey && !refused.has('location')) { save.countryLocation = country; save.postalCode = postalCode; if (body.locationCity !== undefined) save.locationCity = body.locationCity; }

    let saved = null;
    try {
      saved = await updateListing(req.userId, listing.id, save);
    } catch (saveErr) {
      console.warn('revise: eBay was updated but ELMS could not save its copy:', saveErr.message);
    }

    return res.json({
      success: true,
      listing: saved,
      result: { offerId: result.offerId, sku: result.sku, sellPrice: result.sellPrice, quantity: result.quantity, categoryId: result.categoryId },
      verified: !!live,
      notApplied,
      notes,
    });
  } catch (err) {
    console.error('listing revise error:', err.message);
    return res.status(Number(err.statusCode) >= 400 ? Number(err.statusCode) : 500).json({
      success: false,
      error: err.message || 'Could not revise the eBay listing.',
      ebayErrors: err.ebayErrors || undefined,
    });
  }
});

/**
 * PATCH /api/listings/:id/settings
 * Saves ONLY the per-product settings from the listing editor (tags, shipping
 * method, policies, item location, stock/price monitoring). Works for drafts
 * and live listings alike; it never touches title, price or eBay itself.
 */
router.patch('/:id/settings', requireAuth, async (req, res) => {
  if (req.body?.postalCode && req.body?.countryLocation) {
    const { resolveLocation } = require('../services/postalGeneratorService');
    const loc = await resolveLocation(req.body.countryLocation, req.body.postalCode).catch(() => null);
    if (loc && !loc.complete) {
      return res.status(400).json({ success: false, error: `"${req.body.postalCode}" is not a full postal code for ${req.body.countryLocation}. Use the full code or press Generate.` });
    }
    if (loc?.postalCode) req.body.postalCode = loc.postalCode;
  }
  const listing = await updateListingSettings(req.userId, req.params.id, {
    tags: req.body?.tags,
    shippingMethod: req.body?.shippingMethod,
    useDynamicPolicies: req.body?.useDynamicPolicies,
    paymentPolicyId: req.body?.paymentPolicyId,
    fulfillmentPolicyId: req.body?.fulfillmentPolicyId,
    returnPolicyId: req.body?.returnPolicyId,
    countryLocation: req.body?.countryLocation,
    locationCity: req.body?.locationCity,
    postalCode: req.body?.postalCode,
    stockMonitoring: req.body?.stockMonitoring,
    priceMonitoring: req.body?.priceMonitoring,
  });
  if (!listing) return res.status(404).json({ success: false, error: 'Listing not found.' });
  res.json({ success: true, listing });
});

/**
 * Reads views + watchers for one published listing from eBay and stores them.
 */
async function syncOneListingStats(userId, listing, tokenCache) {
  const itemId = listing.ebay_listing_id;
  if (!itemId) return { ok: false, reason: 'not_published_to_ebay' };
  const accountId = listing.ebay_account_id;
  if (!accountId) return { ok: false, reason: 'no_ebay_account' };
  if (!tokenCache.has(accountId)) tokenCache.set(accountId, await getEbayAccountRefreshToken(userId, accountId));
  const refreshToken = tokenCache.get(accountId);
  if (!refreshToken) return { ok: false, reason: 'account_disconnected' };
  const traffic = await fetchItemTraffic(refreshToken, itemId, listing.marketplace_id || 'EBAY_US');
  const updated = await updateListingStats(userId, listing.id, traffic);
  return { ok: true, listing: updated };
}

/**
 * POST /api/listings/:id/stats/sync
 * Refreshes views + watchers for one published listing.
 */
router.post('/:id/stats/sync', requireAuth, async (req, res) => {
  const listing = await getListingById(req.userId, req.params.id);
  if (!listing) return res.status(404).json({ success: false, error: 'Listing not found.' });
  if (listing.status !== 'published') return res.status(400).json({ success: false, error: 'Only published listings have views and watchers.' });
  try {
    const result = await syncOneListingStats(req.userId, listing, new Map());
    if (!result.ok) return res.status(400).json({ success: false, error: 'This listing is not linked to a connected eBay account.', reason: result.reason });
    res.json({ success: true, listing: result.listing });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: err.message || 'Could not read listing traffic from eBay.' });
  }
});

const STATS_SYNC_MIN_AGE_MS = 2 * 60 * 1000; // a store refreshed less than 2 minutes ago is not asked from eBay again
const STATS_SYNC_MAX_ROWS = 1000;

/**
 * POST /api/listings/stats/sync
 * Body (optional): { accountId } - refresh watchers and views of every published listing (of one store, or of all the seller's
 * stores) so the Live listings page can show current numbers. eBay is asked for 200 listings per call, and every call counts
 * against the day's eBay allowance (services/ebayCallBudget.js), so opening the page or pressing the button is cheap.
 */
router.post('/stats/sync', requireAuth, async (req, res) => {
  const accountId = req.body?.accountId ? String(req.body.accountId) : null;
  const accountIds = accountId
    ? [accountId]
    : (await listEbayAccounts(req.userId)).map((a) => String(a.id || a._id));

  let synced = 0;
  let failed = 0;
  let firstError = null;
  const freshAccounts = new Set();
  for (const id of accountIds) {
    try {
      const r = await syncStatsForAccount(req.userId, id, { minAgeMs: STATS_SYNC_MIN_AGE_MS, viewsFallback: 10 });
      if (r.fresh) freshAccounts.add(id);
      synced += r.synced;
      failed += r.failed;
      if (r.limited) firstError = firstError || 'eBay\'s daily call allowance for statistics is used up. The numbers refresh again tomorrow.';
      else if (r.error && r.error !== 'account_disconnected') firstError = firstError || r.error;
    } catch (err) {
      failed += 1;
      firstError = firstError || err.message;
    }
  }

  const all = (await listListings(req.userId, 'published', accountId))
    .filter((l) => l.ebay_listing_id && l.ebay_account_id && (!accountId || l.ebay_account_id === accountId));
  synced += all.filter((l) => freshAccounts.has(l.ebay_account_id)).length; // just refreshed: nothing to ask eBay
  const listings = all
    .slice(0, STATS_SYNC_MAX_ROWS)
    .map((l) => ({ id: l.id, views: l.views, watchers: l.watchers, stats_synced_at: l.stats_synced_at }));
  res.json({ success: true, synced, failed, skipped: Math.max(0, all.length - listings.length), error: firstError, listings, syncedAt: new Date().toISOString() });
});

module.exports = router;
