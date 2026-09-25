const express = require('express');
const router = express.Router();
const { getPlanByPaddlePriceId } = require('../models/plansModel');
const { fulfillPurchase } = require('../services/purchaseFulfillmentService');
const { verifyAndParseWebhook, EventName } = require('../services/paddleService');

/**
 * POST /api/payments/webhook
 * Called by Paddle (not the frontend) when a transaction's status changes.
 *
 * IMPORTANT: this route is mounted in server.js with express.raw() (NOT
 * express.json()), because Paddle's signature verification needs the exact
 * raw request body - if Express parses it to JSON first, verification fails.
 *
 * On a successfully completed transaction, credits the ELMS user identified
 * in the transaction's custom data - through the same fulfilment as every other
 * payment (services/purchaseFulfillmentService.js), which uses the transaction ID
 * to credit a purchase once, since Paddle may deliver the same webhook more than
 * once ("at least once" delivery, by design), and never leaves a purchase recorded
 * without its credits.
 */
/** What the buyer used at Paddle, in words (Visa card, PayPal, Apple Pay ...); null when Paddle did not say. */
function paddleMethodLabel(transaction) {
  const d = transaction && transaction.payments && transaction.payments[0] && transaction.payments[0].method_details;
  if (!d || !d.type) return null;
  const words = (s) => String(s).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
  if (d.type === 'card') return d.card && d.card.type ? words(d.card.type) + ' card' : 'Card';
  const named = { paypal: 'PayPal', apple_pay: 'Apple Pay', google_pay: 'Google Pay', ideal: 'iDEAL', bank_transfer: 'Bank transfer' };
  return named[d.type] || words(d.type);
}

router.post('/', async (req, res) => {
  const signature = req.headers['paddle-signature'] || '';

  let event;
  try {
    event = await verifyAndParseWebhook(req.body, signature);
  } catch (err) {
    console.error('paddle webhook signature verification failed:', err.message);
    return res.status(401).json({ success: false, error: 'Invalid webhook signature.' });
  }

  try {
    if (event.eventType === EventName.TransactionCompleted) {
      const transaction = event.data;
      const elmsUserId = transaction.customData?.elmsUserId;
      const paddlePriceId = transaction.items?.[0]?.price?.id;

      if (!elmsUserId || !/^[a-f0-9]{24}$/i.test(String(elmsUserId))) {
        // Not a retryable situation - this transaction has no (valid) ELMS
        // user attached (shouldn't normally happen), retrying won't fix it.
        console.warn('paddle webhook: TransactionCompleted with no valid elmsUserId in custom data, skipping.');
        return res.status(200).json({ received: true });
      }

      const plan = paddlePriceId ? await getPlanByPaddlePriceId(paddlePriceId) : null;
      const creditsGranted = plan?.credits;

      if (!creditsGranted) {
        // Also not retryable by Paddle - this is a configuration issue on
        // our end (price not mapped to a plan) that a retry won't resolve.
        // Logged clearly so it can be fixed manually and the purchase
        // reconciled by hand if needed.
        console.error(
          `paddle webhook: could not determine credits for transaction ${transaction.id} (price ${paddlePriceId}). Skipping credit grant - please resolve manually.`
        );
        return res.status(200).json({ received: true });
      }

      const priceUsd = transaction.details?.totals?.total
        ? Number(transaction.details.totals.total) / 100
        : plan.priceUsd;

      // A repeated transaction is answered as done (duplicate) and nothing is given twice.
      const done = await fulfillPurchase({
        userId: elmsUserId,
        plan,
        provider: 'paddle',
        transactionId: transaction.id,
        priceUsd,
        paymentMethod: paddleMethodLabel(transaction),
      });
      if (done.granted) {
        console.log(`paddle webhook: credited ${creditsGranted} credits to user ${elmsUserId} for transaction ${transaction.id}.`);
      } else if (!done.duplicate) {
        console.warn(`paddle webhook: transaction ${transaction.id} was not given (${done.reason || 'unknown reason'}).`);
      }
    }

    res.status(200).json({ received: true });
  } catch (err) {
    // IMPORTANT: this is a genuine processing failure (e.g. a transient
    // database error), NOT a known "this will never work" case - those are
    // handled above with their own 200 responses. Returning 500 here tells
    // Paddle to retry the webhook later, so a temporary outage doesn't
    // silently cost the user their paid-for credits. Paddle's retry
    // schedule and our own idempotency (the payment id noted on the user by
    // fulfillPurchase, and the purchase row) together make retries safe.
    console.error('paddle webhook processing error:', err.message);
    res.status(500).json({ success: false, error: 'Could not process this webhook right now.' });
  }
});

module.exports = router;
