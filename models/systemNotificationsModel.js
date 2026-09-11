const SystemNotification = require('./schemas/SystemNotification');

function serialize(doc) {
  const o = doc.toObject ? doc.toObject() : doc;
  return {
    id: String(o._id), type: o.type, level: o.level, title: o.title, message: o.message,
    listing_id: o.listingId ? String(o.listingId) : null, metadata: o.metadata || {},
    is_read: !!o.isRead, created_at: o.createdAt, updated_at: o.updatedAt,
  };
}

async function createSystemNotification(userId, data) {
  const doc = await SystemNotification.create({ userId, ...data });
  return serialize(doc);
}

async function listSystemNotifications(userId, { limit = 30, unreadOnly = false } = {}) {
  const query = { userId };
  if (unreadOnly) query.isRead = false;
  const docs = await SystemNotification.find(query).sort({ createdAt: -1 }).limit(Math.min(Number(limit) || 30, 100));
  return docs.map(serialize);
}

async function countUnreadSystemNotifications(userId) {
  return SystemNotification.countDocuments({ userId, isRead: false });
}

async function markSystemNotificationRead(userId, id, isRead = true) {
  const doc = await SystemNotification.findOneAndUpdate({ _id: id, userId }, { isRead }, { new: true });
  return doc ? serialize(doc) : null;
}

async function markAllSystemNotificationsRead(userId) {
  await SystemNotification.updateMany({ userId, isRead: false }, { $set: { isRead: true } });
  return true;
}

module.exports = {
  createSystemNotification,
  listSystemNotifications,
  countUnreadSystemNotifications,
  markSystemNotificationRead,
  markAllSystemNotificationsRead,
};
