const express = require('express');
const router = express.Router();
const { verifySignature, describeMessage } = require('../services/aliexpressWebhookService');

/**
 * AliExpress's order-status push notifications - register this endpoint's URL in the AliExpress App Console under
 * "Message Subscription and Callback URL" (NOT the OAuth redirect_uri - see routes/aliexpressConnect.js for that one).
 *
 * Nothing here links a message to an ELMS order/listing yet - AliExpress auto-ordering (placing an AliExpress order for a
 * buyer's eBay order) is not built, so there is nothing yet for a push message to update. This endpoint exists to satisfy
 * AliExpress's own callback test/verification and to log every message for now; wiring it to real order state is a
 * follow-up once auto-ordering exists.
 */
router.post('/', (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '');
  const authHeader = req.headers['authorization'];

  if (!verifySignature(raw, authHeader)) {
    console.warn('[aliexpress-webhook] rejected a message: signature did not verify.');
    return res.status(401).end();
  }

  // Acknowledge immediately: the docs require a 200 (status code only, never the body) within 500ms, or the message is
  // considered failed and retried (up to 12 times, 30 minutes apart) - so nothing after this line may block the response.
  res.status(200).end();

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    console.warn('[aliexpress-webhook] could not parse message body:', err.message);
    return;
  }
  console.log(`[aliexpress-webhook] ${describeMessage(payload)}`);
});

// A harmless response to a GET on this URL (AppConsole or a browser opening the link directly) - AliExpress's own
// verification for this callback is the POST test push described in the docs, not a GET challenge like eBay's.
router.get('/', (req, res) => res.status(200).json({ ok: true }));

module.exports = router;
