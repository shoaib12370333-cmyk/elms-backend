const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const EbayAccount = require('../models/schemas/EbayAccount');
const { verifyEbaySignature } = require('../services/ebayNotificationVerifyService');

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
  // Sandbox/test deployments may share the same public callback URL with an
  // eBay Production notification configuration. Those Production callbacks
  // carry Production key IDs, which cannot be resolved through the Sandbox
  // Notification API. In test mode we acknowledge and ignore them so they do
  // not generate endless 412 retries or pollute the test logs.
  const isSandbox = String(process.env.EBAY_ENV || '').trim().toLowerCase() === 'sandbox';
  const isTestMode = String(process.env.ELMS_TEST_MODE || '').trim().toLowerCase() === 'true';

  if (isSandbox || isTestMode) {
    console.log('[ebay-account-deletion] Sandbox/test mode: acknowledging notification without Production signature verification.');
    return res.status(200).json({ received: true, ignored: true, mode: 'sandbox' });
  }

  // eBay documents X-EBAY-SIGNATURE for Marketplace Account Deletion
  // notifications. The body is mounted with express.raw() in server.js so
  // verification is performed against the exact bytes eBay signed.
  const signatureHeader = req.headers['x-ebay-signature'];
  const isValid = await verifyEbaySignature(req.body, signatureHeader).catch((err) => {
    console.error('[ebay-account-deletion] Signature verification error:', err.message);
    return false;
  });

  if (!isValid) {
    console.warn('[ebay-account-deletion] Rejected notification with invalid or missing signature.');
    return res.status(412).json({ success: false, error: 'Invalid signature.' });
  }

  try {
    const payload = JSON.parse(req.body.toString('utf8'));
    const data = payload?.notification?.data || {};
    // eBay may provide username, userId, and/or eiasToken. userId is the
    // immutable identifier and should be preferred where it is available.
    const identifiers = [data.userId, data.username].filter(Boolean);

    if (identifiers.length) {
      const result = await EbayAccount.deleteMany({ ebayUserId: { $in: identifiers } });
      console.log(`[ebay-account-deletion] Removed ${result.deletedCount} eBay account connection(s).`);
    } else {
      console.warn('[ebay-account-deletion] Verified notification had no recognizable eBay user identifier.');
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('[ebay-account-deletion] Error processing verified notification:', err.message);
    return res.status(500).json({ success: false, error: 'Could not process the deletion notification.' });
  }
});

module.exports = router;
