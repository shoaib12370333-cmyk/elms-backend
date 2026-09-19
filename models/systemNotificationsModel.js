const SystemNotification = require('./schemas/SystemNotification');

function serialize(doc) {
  const o = doc.toObject ? doc.toObject() : doc;
  return {
    id: String(o._id), type: o.type, level: o.level, title: o.title, message: o.message,
    ebay_account_id: o.ebayAccountId ? String(o.ebayAccountId) : null,
    listing_id: o.listingId ? String(o.listingId) : null, metadata: o.metadata || {},
    is_read: !!o.isRead, created_at: o.createdAt, updated_at: o.updatedAt,
  };
}

async function createSystemNotification(userId, data) {
  // Notifications belong to the store that caused them, taken from the listing when not given.
  if (!data.ebayAccountId && data.listingId) {
    try {
      const Listing = require('./schemas/Listing');
      const l = await Listing.findOne({ _id: data.listingId, userId }, { ebayAccountId: 1 }).lean();
      if (l?.ebayAccountId) data = { ...data, ebayAccountId: l.ebayAccountId };
    } catch (_) { /* best effort */ }
  }
  const doc = await SystemNotification.create({ userId, ...data });
  return serialize(doc);
}

/** Restricts a query to one store; older notifications are matched through their listing. */
async function accountFilter(userId, accountId) {
  if (!accountId) return {};
  const Listing = require('./schemas/Listing');
  const ids = (await Listing.find({ userId, ebayAccountId: accountId }, { _id: 1 }).lean()).map((l) => l._id);
  return { $or: [{ ebayAccountId: accountId }, { ebayAccountId: null, listingId: { $in: ids } }] };
}

async function listSystemNotifications(userId, { limit = 30, unreadOnly = false, accountId = null } = {}) {
  const query = { userId, ...(await accountFilter(userId, accountId)) };
  if (unreadOnly) query.isRead = false;
  const docs = await SystemNotification.find(query).sort({ createdAt: -1 }).limit(Math.min(Number(limit) || 30, 100));
  return docs.map(serialize);
}

async function countUnreadSystemNotifications(userId, accountId = null) {
  return SystemNotification.countDocuments({ userId, isRead: false, ...(await accountFilter(userId, accountId)) });
}

async function markSystemNotificationRead(userId, id, isRead = true) {
  const doc = await SystemNotification.findOneAndUpdate({ _id: id, userId }, { isRead }, { new: true });
  return doc ? serialize(doc) : null;
}

async function markAllSystemNotificationsRead(userId, accountId = null) {
  await SystemNotification.updateMany({ userId, isRead: false, ...(await accountFilter(userId, accountId)) }, { $set: { isRead: true } });
  return true;
}

module.exports = {
  createSystemNotification,
  listSystemNotifications,
  countUnreadSystemNotifications,
  markSystemNotificationRead,
  markAllSystemNotificationsRead,
};
