const SupportTicket = require('./schemas/SupportTicket');

/**
 * Creates a new support ticket for the given user (e.g. "please add more credits").
 */
async function createTicket(userId, { subject, message }) {
  const doc = await SupportTicket.create({ userId, subject, message });
  return serialize(doc);
}

/**
 * Returns a user's own tickets, newest first.
 */
async function listTicketsForUser(userId) {
  const docs = await SupportTicket.find({ userId }).sort({ createdAt: -1 });
  return docs.map(serialize);
}

/**
 * Admin-only: returns every ticket (across all users), with the submitting
 * user's name/email attached, newest first.
 */
async function listAllTickets() {
  const docs = await SupportTicket.find().populate('userId').sort({ createdAt: -1 });
  return docs.map((doc) => {
    const serialized = serialize(doc);
    serialized.userName = doc.userId?.name || null;
    serialized.userEmail = doc.userId?.email || null;
    return serialized;
  });
}

/**
 * Admin-only: marks a ticket resolved, optionally with a reply message.
 */
async function resolveTicket(id, adminReply) {
  const doc = await SupportTicket.findByIdAndUpdate(
    id,
    { status: 'resolved', adminReply: adminReply || null, resolvedAt: new Date() },
    { new: true }
  );
  return doc ? serialize(doc) : null;
}

function serialize(doc) {
  const obj = doc.toObject();
  return {
    id: obj._id.toString(),
    userId: obj.userId && obj.userId._id ? obj.userId._id.toString() : (obj.userId ? obj.userId.toString() : null),
    subject: obj.subject,
    message: obj.message,
    status: obj.status,
    adminReply: obj.adminReply,
    resolvedAt: obj.resolvedAt,
    createdAt: obj.createdAt,
  };
}

module.exports = { createTicket, listTicketsForUser, listAllTickets, resolveTicket };
