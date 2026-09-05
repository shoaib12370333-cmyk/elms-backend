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
    event = verifyAndParseWebhook(req.body, signature);
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
        console.warn('paddle webhook: TransactionCompleted with no elmsUserId in custom data, skipping.');
        return res.status(200).json({ received: true });
      }

      const plan = paddlePriceId ? await getPlanByPaddlePriceId(paddlePriceId) : null;
      const creditsGranted = plan?.credits;

      if (!creditsGranted) {
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
    console.error('paddle webhook processing error:', err.message);
    // Still return 200 so Paddle doesn't endlessly retry a request that will
    // keep failing the same way - the error is logged for manual follow-up.
    res.status(200).json({ received: true });
  }
});

module.exports = router;
