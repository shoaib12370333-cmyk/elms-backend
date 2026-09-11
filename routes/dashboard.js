const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/requireAuth');
const User = require('../models/schemas/User');
const Listing = require('../models/schemas/Listing');
const Import = require('../models/schemas/Import');
const Order = require('../models/schemas/Order');
const { countUnreadSystemNotifications } = require('../models/systemNotificationsModel');
const { countUnreadConversations } = require('../models/conversationsModel');

router.get('/', requireAuth, async (req, res) => {
  const userId = req.userId;
  const [user, drafts, queued, published, errors, imports, orders, unreadSystem, unreadMessages] = await Promise.all([
    User.findById(userId).lean(),
    Listing.countDocuments({ userId, status: 'draft' }),
    Listing.countDocuments({ userId, status: 'publishing' }),
    Listing.countDocuments({ userId, status: 'published' }),
    Listing.countDocuments({ userId, status: 'error' }),
    Import.countDocuments({ userId }),
    Order.countDocuments({ userId }),
    countUnreadSystemNotifications(userId),
    countUnreadConversations(userId),
  ]);

  const recent = await Listing.find({ userId, status: { $in: ['published', 'error', 'publishing'] } })
    .sort({ updatedAt: -1 }).limit(8).lean();

  res.json({ success: true, stats: {
    credits: user?.creditBalance || 0, drafts, queued, published, errors, imports, orders,
    unreadNotifications: unreadSystem, unreadMessages,
  }, recentPublishes: recent.map((l) => ({
    id: String(l._id), title: l.title || l.sku, sku: l.sku, status: l.status,
    listingId: l.ebayListingId || null, offerId: l.ebayOfferId || null,
    errorMessage: l.errorMessage || null, publishResponse: l.publishResponse || null,
    updatedAt: l.updatedAt,
  })) });
});

module.exports = router;
