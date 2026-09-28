const express = require('express');
const router = express.Router();
const { getByCode, saveStatus } = require('../models/trackingLinksModel');
const track17 = require('../services/track17Service');

// Only re-check with 17TRACK if our cached status is missing or older than this - 17TRACK itself only re-polls
// carriers every 6-12h, so a tighter cache here would just spend API calls for no new information.
const STALE_MS = 60 * 60 * 1000;

/**
 * GET /api/track/:code
 * No sign-in - this is the public "elmstool.com/track/<code>" page's own API. Never returns the real tracking
 * number or carrier, only a status a buyer can read (see models/schemas/TrackingLink.js).
 */
router.get('/:code', async (req, res) => {
  const link = await getByCode(req.params.code);
  if (!link) return res.status(404).json({ success: false, error: 'Tracking code not found.' });

  let status = link.status ? { status: link.status, detail: link.statusDetail, at: link.statusAt } : null;
  const stale = !link.statusAt || Date.now() - new Date(link.statusAt).getTime() > STALE_MS;
  if (stale && link.carrier17) {
    try {
      const fresh = await track17.getTrackInfo(link.trackingNumber, link.carrier17);
      if (fresh) {
        await saveStatus(link._id, fresh);
        status = fresh;
      }
    } catch (err) {
      console.warn('[order-tracking-page] live refresh failed for', link.code, ':', err.message);
    }
  }

  res.json({
    success: true,
    code: link.code,
    status: status?.status || (link.registeredAt ? 'Pending' : 'NotAvailable'),
    statusDetail: status?.detail || null,
    statusAt: status?.at || null,
  });
});

module.exports = router;
