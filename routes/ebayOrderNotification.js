const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { verifyEbaySignature } = require('../services/ebayNotificationVerifyService');

/**
 * eBay's real-time order notification endpoint (Commerce Notification API,
 * topic ORDER_CONFIRMATION). This is the "realtime" half of the hybrid
 * order-sync model - see jobs/orderSync.js for the safety-net polling half
 * that catches anything this endpoint might ever miss.
 *
 * Like the Marketplace Account Deletion endpoint, this has two jobs:
 *
 * 1. GET (verification): eBay sends a "challenge_code" once when the
 *    endpoint URL is first saved in Developer Portal, to prove we own it.
 *    Same SHA-256(challengeCode + verificationToken + endpointURL) scheme
 *    as the account-deletion endpoint - see routes/ebayAccountDeletion.js.
 *
 * 2. POST (actual notifications): eBay calls this when a buyer completes
 *    checkout, with an ORDER_CONFIRMATION payload. The notification is
 *    signed with an eBay-specific ECDSA signature (X-EBAY-SIGNATURE
 *    header) - verified here using eBay's own official SDK
 *    (event-notification-nodejs-sdk), since implementing ECDSA
 *    verification with the correct key-fetching/caching behavior
 *    ourselves would be needlessly error-prone compared to eBay's tested
 *    implementation.
 */

function getEndpointUrl() {
  return process.env.EBAY_ORDER_NOTIFICATION_ENDPOINT_URL || '';
}

router.get('/', (req, res) => {
  const { challenge_code: challengeCode } = req.query;
  const verificationToken = process.env.EBAY_ORDER_NOTIFICATION_VERIFICATION_TOKEN;
  const endpointUrl = getEndpointUrl();

  if (!challengeCode || !verificationToken || !endpointUrl) {
    return res.status(500).json({
      error: 'Missing challenge_code, EBAY_ORDER_NOTIFICATION_VERIFICATION_TOKEN, or EBAY_ORDER_NOTIFICATION_ENDPOINT_URL.',
    });
  }

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
 * Handles an incoming ORDER_CONFIRMATION notification. The signature is
 * verified using eBay's public key (ECDSA/SHA-1, per their documented
 * verification process - see services/ebayNotificationVerifyService.js)
 * BEFORE the notification is trusted for anything.
 *
 * We don't try to parse the full order details out of the notification
 * payload itself - instead, we treat a verified notification purely as a
 * "hey, something changed for this seller" signal, and trigger an
 * immediate targeted order sync for that one eBay account via the
 * Fulfillment API (which we already trust and have tested). This keeps
 * this endpoint simple and means the same order-parsing logic
 * (models/ordersModel.upsertOrder) is used whether an order arrives via
 * webhook or via the safety-net poll.
 *
 * IMPORTANT: this route needs the RAW request body for signature
 * verification (the signature is computed over the exact bytes eBay
 * sent), so it's mounted in server.js with express.raw(), not
 * express.json() - see the comment there for why order matters.
 */
router.post('/', async (req, res) => {
  const signatureHeader = req.headers['x-ebay-signature'];

  const isValid = await verifyEbaySignature(req.body, signatureHeader).catch((err) => {
    console.error('[ebay-order-notification] Signature verification error:', err.message);
    return false;
  });

  if (!isValid) {
    console.warn('[ebay-order-notification] Rejected notification with invalid or missing signature.');
    return res.status(412).json({ success: false, error: 'Invalid signature.' });
  }

  // Always acknowledge quickly once verified - eBay expects a fast
  // response and will retry/back off if we're slow, which could cause
  // duplicate delivery attempts for no benefit (our downstream sync is
  // already idempotent via upsertOrder's unique index).
  res.status(200).json({ received: true });

  try {
    const payload = JSON.parse(req.body.toString('utf8'));
    const { triggerImmediateSyncForNotification } = require('../jobs/orderSync');
    await triggerImmediateSyncForNotification(payload);
  } catch (err) {
    console.error('[ebay-order-notification] Error handling notification:', err.message);
  }
});

module.exports = router;
