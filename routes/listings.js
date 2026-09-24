const express = require('express');
const router = express.Router();

const {
  listListings,
  listListingsByStatuses,
  countListingsByStatus,
  getListingById,
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

const {
  publishListing,
  publishExistingOffer,
  deleteOffer,
  withdrawListing,
  reviseActiveListing,
  createOrGetCustomLocation,
} = require('../services/ebayListingService');

const {
  processOneQueuedListing,
} = require('../services/publishQueueService');

const {
  listEbayAccounts,
  getEbayAccountById,
  getEbayAccountRefreshToken,
} = require('../models/ebayAccountsModel');

const { getImportById } = require('../models/importsModel');
const { prepareAspects } = require('../services/publishPreflightService');

const { requireAuth } = require('../middleware/requireAuth');

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
      const amazon = Number(listing.amazon_price);
      if (!Number.isFinite(amazon) || amazon <= 0) { skipped.push({ id, title: label, reason: 'No Amazon price is saved for this product.' }); continue; }
      const sellPrice = Number((amazon * (1 + percent / 100)).toFixed(2));
      if (!(sellPrice > 0)) { skipped.push({ id, title: label, reason: 'That percentage gives a price of zero.' }); continue; }
      await updateListing(req.userId, id, { sellPrice, markupPercent: percent, marginAmount: Number((sellPrice - amazon).toFixed(2)) });
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

/**
 * POST /api/listings/:id/revise
 *
 * Updates a live eBay listing.
 */
router.post(
  '/:id/revise',
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

      // `listing` is the serialised (snake_case) record, so its fields are sell_price / category_id /
      // ebay_aspects - reading camelCase names from it gave undefined.
      const categoryId = req.body?.categoryId || listing.category_id;
      const marketplaceId = req.body?.marketplaceId || listing.marketplace_id || 'EBAY_US';
      let aspects = req.body?.aspects ?? req.body?.ebayAspects ?? null;
      if (aspects && typeof aspects === 'object' && categoryId) {
        // Same check as a first publish: match eBay's allowed values, fill "does not apply", name what is missing.
        const prepared = await prepareAspects({ categoryId, marketplaceId, product: { ebayAspects: aspects } });
        if (prepared.aspects) aspects = prepared.aspects;
      }

      const result =
        await reviseActiveListing(
          refreshToken,
          {
            offerId:
              listing.ebay_offer_id,

            sku:
              listing.sku,

            title:
              req.body?.title ??
              listing.title,

            description:
              req.body?.description ??
              listing.description,

            images:
              req.body?.images ??
              listing.images,

            aspects: aspects || undefined,

            sellPrice:
              req.body?.sellPrice ??
              listing.sell_price,

            quantity:
              req.body?.quantity ??
              listing.quantity,

            categoryId,
          }
        );

      return res.json({
        success: true,
        result,
      });
    } catch (err) {
      console.error(
        'listing revise error:',
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
          'Could not revise the eBay listing.',
        ebayErrors:
          err.ebayErrors || undefined,
      });
    }
  }
);

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

/**
 * POST /api/listings/stats/sync
 * Body (optional): { accountId } - refresh every published listing (max 200 per
 * call) so the Live listings page can show current views and watchers.
 */
router.post('/stats/sync', requireAuth, async (req, res) => {
  const accountId = req.body?.accountId ? String(req.body.accountId) : null;
  const all = await listListings(req.userId, 'published');
  const targets = all
    .filter((l) => l.ebay_listing_id && l.ebay_account_id && (!accountId || l.ebay_account_id === accountId))
    .slice(0, 200);

  const tokenCache = new Map();
  const listings = [];
  let failed = 0;
  let firstError = null;
  for (const listing of targets) {
    try {
      const result = await syncOneListingStats(req.userId, listing, tokenCache);
      if (result.ok) listings.push({ id: result.listing.id, views: result.listing.views, watchers: result.listing.watchers, stats_synced_at: result.listing.stats_synced_at });
      else failed += 1;
    } catch (err) {
      failed += 1;
      firstError = firstError || err.message;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  res.json({ success: true, synced: listings.length, failed, skipped: all.length - targets.length, error: firstError, listings, syncedAt: new Date().toISOString() });
});

module.exports = router;
