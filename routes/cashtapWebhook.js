const express = require('express');
const router = express.Router();
const cashtap = require('../services/cashtapService');
const { grantForSession } = require('../services/cashtapPaymentService');

/**
 * POST /api/payments/cashtap-webhook
 * Called by CashTap (not the browser) when a checkout session ends. Mounted in server.js with express.raw(), BEFORE
 * express.json(): the signature is computed over the exact bytes CashTap sent.
 *
 *  - The signature must be valid (X-CashTap-Signature, whsec_ secret, 5 minute window) or the request is refused (400).
 *  - Test events (livemode false) are acknowledged and ignored.
 *  - checkout.session.completed: the session is fetched from CashTap's API and only THAT answer is trusted (the webhook
 *    body only says which session to look at). If it is paid, the plan is given (once per session, so retries are safe).
 *  - checkout.session.failed: a payment arrived but settlement failed on CashTap's side -> the admin is told.
 *  - A temporary problem answers 500 so CashTap retries (6 attempts over about 12 hours). Everything else answers 200.
 */
router.post('/', async (req, res) => {
  const secret = process.env.CASHTAP_WEBHOOK_SECRET;
  if (!secret) {
    console.error('cashtap webhook: CASHTAP_WEBHOOK_SECRET is not set.');
    return res.status(503).json({ success: false, error: 'Webhook is not configured.' });
  }
  const raw = req.body;
  if (!Buffer.isBuffer(raw) || !cashtap.verifySignature(raw, req.headers['x-cashtap-signature'], secret)) {
    return res.status(400).json({ success: false, error: 'Invalid signature.' });
  }

  let event;
  try { event = JSON.parse(raw.toString('utf8')); } catch (_) { return res.status(400).json({ success: false, error: 'Invalid body.' }); }
  if (!event || event.livemode === false) return res.status(200).json({ received: true, ignored: 'test event' });

  const session = event.data && event.data.object;
  try {
    if (event.type === 'checkout.session.completed' && session && session.id) {
      let remote;
      try {
        remote = await cashtap.getSession(session.id);
      } catch (err) {
        if (err.statusCode === 404) return res.status(200).json({ received: true, ignored: 'unknown session' });
        throw err; // temporary: let CashTap retry
      }
      const result = await grantForSession(remote);
      console.log('cashtap webhook: session ' + session.id + ' -> ' + (result.granted ? 'plan given' : result.duplicate ? 'already given' : 'not given (' + (result.reason || result.status) + ')'));
    } else if (event.type === 'checkout.session.failed' && session) {
      try {
        await require('../services/emailService').sendAdminAlert({
          subject: 'CashTap payment failed to settle',
          lines: ['Session: ' + session.id, 'Amount: $' + session.amount, 'Metadata: ' + JSON.stringify(session.metadata || {}), 'A payment arrived but settlement failed on CashTap\'s side. The plan was NOT given. CashTap support resolves these; a later "completed" event will give the plan automatically.'],
        });
      } catch (_) { /* best effort */ }
    }
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('cashtap webhook processing error:', err.message);
    return res.status(500).json({ success: false, error: 'Could not process this webhook right now.' });
  }
});

module.exports = router;
