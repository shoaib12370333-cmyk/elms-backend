const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/requireAuth');
const Session = require('../models/schemas/Session');

/**
 * POST /api/presence/ping
 * The site calls this every minute while it is open. It is what lets the admin see who is online now and
 * how many minutes ago someone left. (requireAuth also refuses a suspended or blocked user here.)
 */
router.post('/ping', requireAuth, async (req, res) => {
  if (req.sid) await Session.updateOne({ sid: req.sid }, { $set: { lastSeenAt: new Date() } });
  res.json({ success: true });
});

module.exports = router;
