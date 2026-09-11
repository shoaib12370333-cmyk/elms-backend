const express = require('express');
const router = express.Router();
const { buildAuthorizationUrl, exchangeCodeForToken } = require('../services/ebayUserAuthService');
const { fetchBusinessPolicies } = require('../services/ebayListingService');
const { fetchEbayUsername } = require('../services/ebayIdentityService');
const { addEbayAccount, updateEbayAccountSettings, removeEbayAccount, getEbayAccountById, getAccountLimitStatus } = require('../models/ebayAccountsModel');
const { issueEbayConnectState, verifyEbayConnectState, verifySessionToken } = require('../services/sessionService');
const { requireAuth } = require('../middleware/requireAuth');

/**
 * GET /api/ebay-connect/start?marketplaceId=EBAY_US
 * Requires a valid session token (sent as ?token=... since this is a browser redirect,
 * not a fetch call that can carry an Authorization header).
 *
 * Returns the eBay authorization URL the frontend should redirect the user to.
 * A user can connect multiple eBay accounts one at a time by calling this
 * (and completing the eBay consent flow) more than once - each completed
 * flow adds a new account, up to their admin-set limit.
 */
router.get('/start', async (req, res) => {
  const { token, marketplaceId } = req.query;

  let userId;
  try {
    userId = verifySessionToken(token);
  } catch (err) {
    return res.status(err.statusCode || 401).json({ success: false, error: err.message });
  }

  try {
    const limit = await getAccountLimitStatus(userId);
    if (limit.connected >= limit.max) {
      return res.status(403).json({
        success: false,
        error: `You have reached your eBay account limit (${limit.max}). Disconnect an account or ask the admin to increase your limit.`,
      });
    }

    // The OAuth state is a short-lived, purpose-specific signed token. It
    // carries the selected marketplace too, so a second connected account
    // keeps its own marketplace instead of silently defaulting to EBAY_US.
    const state = issueEbayConnectState(userId, marketplaceId || 'EBAY_US');
    const url = buildAuthorizationUrl(state);
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
 * Exchanges the code for a refresh token, fetches the eBay username, and
 * saves it as a new (or refreshed) eBay account connection for this user -
 * enforcing their admin-set connection limit.
 */
router.get('/callback', async (req, res) => {
  const { code, state, error, error_description: errorDescription } = req.query;
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5500';

  if (error) {
    const message = errorDescription || error || 'eBay authorization was not completed.';
    return res.redirect(`${frontendUrl}?ebayConnect=error&message=${encodeURIComponent(message)}`);
  }

  if (!code || !state) {
    // Never log the code/state themselves; query keys are enough to diagnose
    // a bad callback while keeping OAuth credentials out of logs.
    console.warn('[ebay-connect] callback missing code/state; received query keys:', Object.keys(req.query || {}));
    const missing = !code && !state ? 'code and state' : (!code ? 'code' : 'state');
    return res.redirect(`${frontendUrl}?ebayConnect=error&message=${encodeURIComponent(`Missing ${missing} from eBay callback. Please try connecting again.`)}`);
  }

  let connectionState;
  try {
    connectionState = verifyEbayConnectState(state);
  } catch (err) {
    return res.redirect(`${frontendUrl}?ebayConnect=error&message=${encodeURIComponent(err.message)}`);
  }
  const { userId, marketplaceId } = connectionState;

  try {
    const { refreshToken, expiresIn } = await exchangeCodeForToken(code);
    const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000) : null;

    const ebayUserId = (await fetchEbayUsername(refreshToken)) || `eBay Account ${Date.now()}`;

    const account = await addEbayAccount(userId, { ebayUserId, refreshToken, expiresAt, marketplaceId });

    // Auto-fetch this account's eBay Business Policies and Inventory
    // Location right away, so the Settings page's dropdowns are already
    // populated when they land there - no separate "Fetch from eBay" click needed.
    try {
      const marketplaceId = account.marketplaceId || 'EBAY_US';
      const policies = await fetchBusinessPolicies(refreshToken, marketplaceId);

      // Only auto-select a policy if there's exactly one - if the seller has
      // multiple policies of one type, we still want them to consciously
      // choose which one, rather than silently guessing for them.
      const autoSelect = (list) => (list.length === 1 ? list[0].id || list[0].key : null);

      await updateEbayAccountSettings(userId, account.id, {
        paymentPolicyId: autoSelect(policies.paymentPolicies),
        returnPolicyId: autoSelect(policies.returnPolicies),
        fulfillmentPolicyId: autoSelect(policies.fulfillmentPolicies),
        merchantLocationKey: autoSelect(policies.locations),
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
 * Requires a valid session token.
 * Body: { accountId: string }
 *
 * Removes one specific connected eBay account.
 */
router.post('/disconnect', requireAuth, async (req, res) => {
  const { accountId } = req.body;

  if (!accountId) {
    return res.status(400).json({ success: false, error: 'An accountId is required.' });
  }

  const removed = await removeEbayAccount(req.userId, accountId);
  if (!removed) {
    return res.status(404).json({ success: false, error: 'That eBay account was not found.' });
  }

  res.json({ success: true });
});

module.exports = router;
