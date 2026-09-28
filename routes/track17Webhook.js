const express = require('express');
const router = express.Router();
const { updateStatusByTrackingNumber } = require('../models/trackingLinksModel');
const { statusFromTrackInfo } = require('../services/track17Service');

/**
 * POST /api/track17-webhook/:secret
 * 17TRACK pushes a status update here (Settings > Webhook in your 17TRACK dashboard - set the URL to this route
 * with your own TRACK17_WEBHOOK_SECRET as :secret). 17TRACK does not sign these requests, so the secret in the
 * path is what stops anyone else from posting fake status updates. Always answers 200 so 17TRACK does not retry,
 * even on our own errors - a missed push is caught by the next live refresh (routes/publicTracking.js) anyway.
 */
router.post('/:secret', async (req, res) => {
  if (!process.env.TRACK17_WEBHOOK_SECRET || req.params.secret !== process.env.TRACK17_WEBHOOK_SECRET) {
    return res.sendStatus(404);
  }
  try {
    const accepted = req.body?.data?.accepted || [];
    for (const item of accepted) {
      const status = statusFromTrackInfo(item.track_info);
      if (status) await updateStatusByTrackingNumber(item.number, item.carrier, status);
    }
  } catch (err) {
    console.error('[order-tracking-page] webhook error:', err.message);
  }
  res.sendStatus(200);
});

module.exports = router;
