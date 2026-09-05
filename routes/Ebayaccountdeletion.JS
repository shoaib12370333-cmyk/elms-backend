const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const User = require('../models/schemas/User');

/**
 * eBay's Marketplace Account Deletion endpoint. This has two jobs:
 *
 * 1. GET (verification): eBay sends a "challenge_code" once when you first
 *    save this URL in Developer Portal > Alerts & Notifications, to prove
 *    you own this endpoint. We must hash challengeCode + verificationToken
 *    + this exact endpoint URL (in that order) with SHA-256, and return the
 *    hex digest as { "challengeResponse": "<hash>" }.
 *
 * 2. POST (actual notifications): when an eBay user deletes/closes their
 *    account, eBay calls this URL with the user's eBay username/userId so
 *    we can delete any of their personal data we may have stored.
 */

/**
 * The exact public URL of this endpoint, EXACTLY as entered in eBay
 * Developer Portal (https, no trailing slash) - this must match exactly,
 * since it's part of the hash eBay checks during verification.
 */
function getEndpointUrl() {
  return process.env.EBAY_ACCOUNT_DELETION_ENDPOINT_URL || '';
}

router.get('/', (req, res) => {
  const { challenge_code: challengeCode } = req.query;
  const verificationToken = process.env.EBAY_ACCOUNT_DELETION_VERIFICATION_TOKEN;
  const endpointUrl = getEndpointUrl();

  if (!challengeCode || !verificationToken || !endpointUrl) {
    return res.status(500).json({
      error: 'Missing challenge_code, EBAY_ACCOUNT_DELETION_VERIFICATION_TOKEN, or EBAY_ACCOUNT_DELETION_ENDPOINT_URL.',
    });
  }

  // IMPORTANT: order matters - challengeCode, then verificationToken, then
  // the endpoint URL, concatenated with no separators, then SHA-256'd, then
  // returned as a lowercase hex string (not base64).
  const hash = crypto
    .createHash('sha256')
    .update(challengeCode)
    .update(verificationToken)
    .update(endpointUrl)
    .digest('hex');

  res.setHeader('Content-Type', 'application/json');
  res.status(200).json({ challengeResponse: hash });
});

/**
 * Handles the actual account-deletion notification. eBay's payload shape
 * (per their documentation) includes the deleted user's eBay username
 * and/or userId under notification.data. We look up any of our users
 * connected to that eBay account and remove their stored eBay connection
 * and any personal data tied to it, in line with our Privacy Policy.
 */
router.post('/', async (req, res) => {
  try {
    const ebayUserId = req.body?.notification?.data?.username || req.body?.notification?.data?.userId;

    if (ebayUserId) {
      // Clear this user's eBay connection and any personal data we
      // associated with it. We keep their ELMS account and credit
      // balance intact (that's ELMS account data, not eBay account
      // data) - only the eBay-linked personal data is removed.
      await User.updateMany(
        { ebayUserId },
        {
          ebayConnected: false,
          ebayUserId: null,
          ebayRefreshTokenEncrypted: null,
          ebayRefreshTokenExpiresAt: null,
        }
      );
      console.log(`[ebay-account-deletion] Cleared eBay connection data for eBay user: ${ebayUserId}`);
    } else {
      console.warn('[ebay-account-deletion] Received notification with no recognizable eBay user identifier.');
    }

    // eBay just needs a 200 acknowledging receipt.
    res.status(200).json({ received: true });
  } catch (err) {
    console.error('[ebay-account-deletion] Error processing notification:', err.message);
    // Still acknowledge with 200 so eBay doesn't endlessly retry - the
    // error is logged above for manual follow-up.
    res.status(200).json({ received: true });
  }
});

module.exports = router;
