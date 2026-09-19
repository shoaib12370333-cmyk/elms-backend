const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/requireAuth');
const {
  listSystemNotifications,
  countUnreadSystemNotifications,
  markSystemNotificationRead,
  markAllSystemNotificationsRead,
} = require('../models/systemNotificationsModel');

router.get('/unread-count', requireAuth, async (req, res) => {
  res.json({ success: true, count: await countUnreadSystemNotifications(req.userId, req.query.accountId || null) });
});

router.get('/', requireAuth, async (req, res) => {
  const notifications = await listSystemNotifications(req.userId, {
    limit: req.query.limit || 30,
    unreadOnly: String(req.query.unreadOnly || '') === 'true',
    accountId: req.query.accountId || null,
  });
  res.json({ success: true, notifications });
});

router.put('/:id/read', requireAuth, async (req, res) => {
  const notification = await markSystemNotificationRead(req.userId, req.params.id, req.body?.isRead !== false);
  if (!notification) return res.status(404).json({ success: false, error: 'Notification not found.' });
  res.json({ success: true, notification });
});

router.post('/mark-all-read', requireAuth, async (req, res) => {
  await markAllSystemNotificationsRead(req.userId, req.query.accountId || req.body?.accountId || null);
  res.json({ success: true });
});

module.exports = router;
