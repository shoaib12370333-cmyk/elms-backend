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
      statuses
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
    ] = await Promise.all([
      countListingsByStatus(
        req.userId,
        'draft'
      ),
      countListingsByStatus(
        req.userId,
        'scheduled'
      ),
      countListingsByStatus(
        req.userId,
        'error'
      ),
      countListingsByStatus(
        req.userId,
        'publishing'
      ),
      countListingsByStatus(
        req.userId,
        'published'
      ),
    ]);

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
      ? await listListingsByStatuses(req.userId, cleanStatuses)
      : await listListings(req.userId, cleanStatuses[0] || null);

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
  let creditSpent = false;

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

    const creditCost =
      Number(
        ACTION_COSTS?.PUBLISH_LISTING ??
        ACTION_COSTS?.PUBLISH ??
        1
      );

    if (creditCost > 0) {
      const available =
        await hasCredits(
          req.userId,
          creditCost
        );

      if (!available) {
        return res.status(402).json({
          success: false,
          error:
            'You do not have enough credits to publish this listing.',
        });
      }

      const spent =
        await spendCredit(
          req.userId,
          creditCost,
          'eBay listing publish'
        );

      if (!spent) {
        return res.status(402).json({
          success: false,
          error:
            'You do not have enough credits to publish this listing.',
        });
      }

      creditSpent = true;
    }

    claimed =
      await claimListingForPublishing(
        req.userId,
        listingId
      );

    if (!claimed) {
      if (creditSpent) {
        await refundCredit(
          req.userId,
          creditCost,
          'eBay listing publish claim failed'
        );
      }

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

    return res.json({
      success: true,
      listing: published,
    });
  } catch (err) {
    console.error(
      'instant listing publish error:',
      err
    );

    if (
      creditSpent &&
      claimed
    ) {
      try {
        await refundCredit(
          req.userId,
          creditCost,
          'eBay listing publish failed'
        );
      } catch (refundErr) {
        console.error(
          'publish credit refund failed:',
          refundErr.message
        );
      }
    }

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

            aspects:
              req.body?.aspects ??
              listing.ebayAspects,

            sellPrice:
              req.body?.sellPrice ??
              listing.sellPrice,

            quantity:
              req.body?.quantity ??
              listing.quantity,

            categoryId:
              req.body?.categoryId ??
              listing.categoryId,
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
  res.json({ success: true, synced: listings.length, failed, skipped: all.length - targets.length, error: firstError, listings });
});

module.exports = router;
