const express = require('express');
const router = express.Router();
const { getPlanByPaddlePriceId } = require('../models/plansModel');
const { recordPurchase } = require('../models/purchasesModel');
const { addCredits } = require('../models/usersModel');
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
 * in the transaction's custom data. Uses the transaction ID to prevent
 * crediting the same purchase twice, since Paddle may deliver the same
 * webhook more than once ("at least once" delivery, by design).
 */
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

      if (!elmsUserId) {
        // Not a retryable situation - this transaction simply has no ELMS
        // user attached (shouldn't normally happen), retrying won't fix it.
        console.warn('paddle webhook: TransactionCompleted with no elmsUserId in custom data, skipping.');
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

      const purchase = await recordPurchase({
        userId: elmsUserId,
        planId: plan.id,
        provider: 'paddle',
        providerTransactionId: transaction.id,
        priceUsd,
        creditsGranted,
      });

      if (purchase) {
        // purchase is null if this transaction ID was already recorded -
        // meaning we've already credited this user for it, so skip re-crediting.
        await addCredits(elmsUserId, creditsGranted);
        console.log(`paddle webhook: credited ${creditsGranted} credits to user ${elmsUserId} for transaction ${transaction.id}.`);
      }
    }

    res.status(200).json({ received: true });
  } catch (err) {
    // IMPORTANT: this is a genuine processing failure (e.g. a transient
    // database error), NOT a known "this will never work" case - those are
    // handled above with their own 200 responses. Returning 500 here tells
    // Paddle to retry the webhook later, so a temporary outage doesn't
    // silently cost the user their paid-for credits. Paddle's retry
    // schedule and our own idempotency check (recordPurchase matching on
    // providerTransactionId) together make retries safe.
    console.error('paddle webhook processing error:', err.message);
    res.status(500).json({ success: false, error: 'Could not process this webhook right now.' });
  }
});

module.exports = router;
