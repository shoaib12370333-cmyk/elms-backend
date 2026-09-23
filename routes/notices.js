const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/requireAuth');
const AdminNotice = require('../models/schemas/AdminNotice');
const { isValidObjectIdString } = require('../services/validationService');

const live = () => ({ $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] });
const forMe = (userId) => ({ $or: [{ userId }, { userId: null }] });

/**
 * GET /api/notices/pending
 * Messages from the admins this user has not pressed OK on yet (oldest first). The site shows them as a pop-up.
 */
router.get('/pending', requireAuth, async (req, res) => {
  const rows = await AdminNotice.find({ $and: [forMe(req.userId), live(), { seenBy: { $ne: req.userId } }] }).sort({ createdAt: 1 }).limit(5).lean();
  res.json({ success: true, notices: rows.map((n) => ({ id: String(n._id), kind: n.kind, title: n.title, body: n.body, createdAt: n.createdAt })) });
});

/** POST /api/notices/:id/seen - the user pressed OK; it is not shown to them again. */
router.post('/:id/seen', requireAuth, async (req, res) => {
  if (!isValidObjectIdString(req.params.id)) return res.status(404).json({ success: false, error: 'Not found.' });
  await AdminNotice.updateOne({ $and: [{ _id: req.params.id }, forMe(req.userId)] }, { $addToSet: { seenBy: req.userId } });
  res.json({ success: true });
});

module.exports = router;
