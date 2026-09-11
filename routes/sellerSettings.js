const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/requireAuth');
const {
  listEbayAccounts,
  getEbayAccountById,
  getEbayAccountRefreshToken,
  updateEbayAccountSettings,
} = require('../models/ebayAccountsModel');
const { fetchBusinessPolicies } = require('../services/ebayListingService');
const { lookupPostalCode } = require('../services/postalCodeService');

/**
 * GET /api/seller-settings?accountId=...
 * Requires a valid session token.
 * Returns one eBay account's business policy settings. If no accountId is
 * given, returns settings for the user's first connected account (for
 * backward-compatible single-account use).
 */
router.get('/', requireAuth, async (req, res) => {
  const { accountId } = req.query;

  if (accountId) {
    const settings = await getEbayAccountById(req.userId, accountId);
    return res.json({ success: true, settings });
  }

  const accounts = await listEbayAccounts(req.userId);
  res.json({ success: true, settings: accounts[0] || null });
});

/**
 * GET /api/seller-settings/ebay-policies?accountId=...&marketplaceId=EBAY_US
 * Requires a valid session token and a connected eBay account.
 *
 * Fetches that eBay account's actual Payment/Return/Fulfillment policies
 * and Inventory Locations, so the Settings page can offer them as
 * dropdowns instead of the user having to manually copy IDs from eBay Seller Hub.
 */
router.get('/ebay-policies', requireAuth, async (req, res) => {
  const { accountId } = req.query;
  if (!accountId) {
    return res.status(400).json({ success: false, error: 'An accountId is required.' });
  }

  const refreshToken = await getEbayAccountRefreshToken(req.userId, accountId);
  if (!refreshToken) {
    return res.status(400).json({ success: false, error: 'That eBay account was not found.' });
  }

  const currentSettings = await getEbayAccountById(req.userId, accountId);
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
 * GET /api/seller-settings/postal-lookup?country=US&postalCode=10001
 * Requires a valid session token.
 *
 * Looks up the place name (city/state) for a country + postal code, using
 * the free Zippopotam.us service - used by the "Custom" product location
 * option so the user only has to type a postal code and see it resolved.
 */
router.get('/postal-lookup', requireAuth, async (req, res) => {
  const { country, postalCode } = req.query;

  if (!country || !postalCode) {
    return res.status(400).json({ success: false, error: 'Both country and postalCode are required.' });
  }

  try {
    const result = await lookupPostalCode(country, postalCode);
    if (!result) {
      return res.status(404).json({ success: false, error: 'That postal code was not found for the selected country.' });
    }
    res.json({ success: true, location: result });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});

/**
 * PUT /api/seller-settings
 * Requires a valid session token.
 * Body: { accountId, merchantLocationKey, paymentPolicyId, fulfillmentPolicyId, returnPolicyId, marketplaceId,
 *         productLocationMode, customPostalCode, customCountryCode }
 *
 * Saves business policy settings for ONE of the user's eBay accounts
 * (identified by accountId), plus its chosen product (item) location -
 * either one of that account's real eBay merchant locations, or a custom
 * country+postal code that becomes the "item location" sent with each
 * listing published through it.
 */
router.put('/', requireAuth, async (req, res) => {
  const { accountId, ...updates } = req.body;

  if (!accountId) {
    return res.status(400).json({ success: false, error: 'An accountId is required.' });
  }

  const settings = await updateEbayAccountSettings(req.userId, accountId, updates);
  if (!settings) {
    return res.status(404).json({ success: false, error: 'That eBay account was not found.' });
  }

  res.json({ success: true, settings });
});

module.exports = router;
