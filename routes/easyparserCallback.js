const express = require('express');
const router = express.Router();

/**
 * POST /api/easyparser/callback
 *
 * ELMS doesn't actually use this: jobs/bulkImportProcessor.js polls the Data Service for
 * results instead of waiting on a webhook (see services/easyparserAmazonService.js). But
 * Easyparser's Bulk API requires a callback_url on every submitted job, and if it can't
 * reach that URL it emails "Webhook Error Notification" after enough failures. This just
 * exists to answer with 200 so those calls succeed and the emails stop - the payload
 * itself is ignored.
 */
router.post('/', (req, res) => {
  res.status(200).json({ received: true });
});

module.exports = router;
