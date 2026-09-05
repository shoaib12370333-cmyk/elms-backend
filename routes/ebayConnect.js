const express = require('express');
const router = express.Router();
const { buildAuthorizationUrl, exchangeCodeForToken } = require('../services/ebayUserAuthService');
const { fetchBusinessPolicies } = require('../services/ebayListingService');
const {
  saveEbayConnection,
  disconnectEbay,
  getSellerSettings,
  saveSellerSettings,
} = require('../models/usersModel');
const { issueSessionToken, verifySessionToken } = require('../services/sessionService');
const { requireAuth } = require('../middleware/requireAuth');

/**
 * GET /api/ebay-connect/start
 * Requires a valid session token (sent as ?token=... since this is a browser redirect,
 * not a fetch call that can carry an Authorization header).
 *
 * Returns the eBay authorization URL the frontend should redirect the user to.
 */
router.get('/start', async (req, res) => {
  const { token } = req.query;

  let userId;
  try {
    userId = verifySessionToken(token);
  } catch (err) {
    return res.status(err.statusCode || 401).json({ success: false, error: err.message });
  }

  try {
    // We re-sign the userId into eBay's "state" param so we know who this is
    // when eBay redirects back to our callback.
    const state = issueSessionToken(userId);

    // The marketplace was saved to this user's settings just before they
    // clicked "Continue to eBay" in the marketplace selection modal - use
    // it to localize the eBay consent page (language/branding only, not
    // which eBay account they log into).
    const settings = await getSellerSettings(userId);
    const url = buildAuthorizationUrl(state, settings?.marketplaceId);
    res.json({ success: true, url });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/ebay-connect/callback
 * This is the RuName's "Auth Accepted URL" - eBay redirects the browser here
 * after the user grants consent, with ?code=... and ?state=... in the query string.
 *
 * Exchanges the code for a refresh token, saves it on the user's account,
 * then redirects back to the frontend.
 */
router.get('/callback', async (req, res) => {
  const { code, state } = req.query;
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5500';

  if (!code || !state) {
    return res.redirect(`${frontendUrl}?ebayConnect=error&message=Missing+code+or+state`);
  }

  let userId;
  try {
    userId = verifySessionToken(state);
  } catch (err) {
    return res.redirect(`${frontendUrl}?ebayConnect=error&message=Invalid+session`);
  }

  try {
    const { refreshToken, expiresIn } = await exchangeCodeForToken(code);
    const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000) : null;

    await saveEbayConnection(userId, { refreshToken, expiresAt });

    // Auto-fetch this user's eBay Business Policies and Inventory Location
    // right away, so the Settings page's dropdowns are already populated
    // when they land there - no separate "Fetch from eBay" click needed.
    // If a marketplace was already chosen (via the marketplace selection
    // modal before connecting), use it; otherwise fall back to the default.
    try {
      const currentSettings = await getSellerSettings(userId);
      const marketplaceId = currentSettings?.marketplaceId || 'EBAY_US';
      const policies = await fetchBusinessPolicies(refreshToken, marketplaceId);

      // Only auto-select a policy if there's exactly one - if the seller has
      // multiple policies of one type, we still want them to consciously
      // choose which one, rather than silently guessing for them.
      const autoSelect = (list) => (list.length === 1 ? list[0].id || list[0].key : null);

      await saveSellerSettings(userId, {
        paymentPolicyId: currentSettings?.paymentPolicyId || autoSelect(policies.paymentPolicies),
        returnPolicyId: currentSettings?.returnPolicyId || autoSelect(policies.returnPolicies),
        fulfillmentPolicyId: currentSettings?.fulfillmentPolicyId || autoSelect(policies.fulfillmentPolicies),
        merchantLocationKey: currentSettings?.merchantLocationKey || autoSelect(policies.locations),
      });
    } catch (policyErr) {
      // Non-fatal - the user can still fetch/select policies manually from
      // the Settings page. Don't let this failure block the connection itself.
      console.warn('Could not auto-fetch business policies after connect:', policyErr.message);
    }

    res.redirect(`${frontendUrl}?ebayConnect=success`);
  } catch (err) {
    console.error('ebay-connect callback error:', err.message);
    res.redirect(`${frontendUrl}?ebayConnect=error&message=${encodeURIComponent(err.message)}`);
  }
});

/**
 * POST /api/ebay-connect/disconnect
 * Requires a valid session token. Removes the user's saved eBay connection.
 */
router.post('/disconnect', requireAuth, async (req, res) => {
  const user = await disconnectEbay(req.userId);
  res.json({ success: true, user });
});

module.exports = router;
