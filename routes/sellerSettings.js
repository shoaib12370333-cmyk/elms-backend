const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/requireAuth');
const { saveSellerSettings, getSellerSettings, getEbayRefreshToken } = require('../models/usersModel');
const { fetchBusinessPolicies } = require('../services/ebayListingService');

/**
 * GET /api/seller-settings
 * Requires a valid session token. Returns the current user's eBay business
 * policy settings.
 */
router.get('/', requireAuth, async (req, res) => {
  const settings = await getSellerSettings(req.userId);
  res.json({ success: true, settings });
});

/**
 * GET /api/seller-settings/ebay-policies
 * Requires a valid session token and a connected eBay account.
 * Query: ?marketplaceId=EBAY_US (optional, defaults to the user's saved marketplace)
 *
 * Fetches the user's actual Payment/Return/Fulfillment policies and
 * Inventory Locations directly from their eBay account, so the Settings
 * page can offer them as dropdowns instead of the user having to manually
 * copy IDs from eBay Seller Hub.
 */
router.get('/ebay-policies', requireAuth, async (req, res) => {
  const refreshToken = await getEbayRefreshToken(req.userId);
  if (!refreshToken) {
    return res.status(400).json({ success: false, error: 'Please connect your eBay account first.' });
  }

  const currentSettings = await getSellerSettings(req.userId);
  const marketplaceId = req.query.marketplaceId || currentSettings?.marketplaceId || 'EBAY_US';

  try {
    const policies = await fetchBusinessPolicies(refreshToken, marketplaceId);
    res.json({ success: true, ...policies });
  } catch (err) {
    console.error('ebay-policies fetch error:', err.message);
    res.status(err.statusCode || 500).json({
      success: false,
      error: err.message || 'Could not fetch your eBay business policies.',
    });
  }
});

/**
 * PUT /api/seller-settings
 * Requires a valid session token.
 * Body: { merchantLocationKey, paymentPolicyId, fulfillmentPolicyId, returnPolicyId, marketplaceId }
 *
 * Saves the current user's eBay business policy settings (from their own
 * Seller Hub). These are required before they can publish a listing.
 */
router.put('/', requireAuth, async (req, res) => {
  const { merchantLocationKey, paymentPolicyId, fulfillmentPolicyId, returnPolicyId, marketplaceId } = req.body;

  const settings = await saveSellerSettings(req.userId, {
    merchantLocationKey,
    paymentPolicyId,
    fulfillmentPolicyId,
    returnPolicyId,
    marketplaceId,
  });

  res.json({ success: true, settings });
});

module.exports = router;
