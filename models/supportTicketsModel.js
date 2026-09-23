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
  const rows = docs.map((doc) => {
    const serialized = serialize(doc);
    serialized.userName = doc.userId?.name || doc.fromName || null;
    serialized.userEmail = doc.userId?.email || doc.fromEmail || null;
    serialized.escalationReason = doc.escalationReason || null; // for admins only
    return serialized;
  });
  // Open tickets that need a person come first (urgent before the rest), then the other open ones, then resolved.
  const rank = (t) => (t.status === 'resolved' ? 3 : t.escalated && t.urgent ? 0 : t.escalated ? 1 : 2);
  return rows.sort((a, b) => rank(a) - rank(b) || new Date(b.createdAt) - new Date(a.createdAt));
}

/**
 * Admin-only: marks a ticket resolved, optionally with a reply message.
 */
async function resolveTicket(id, adminReply) {
  const reply = adminReply && String(adminReply).trim() ? String(adminReply).trim() : null;
  const update = { status: 'resolved', adminReply: reply, resolvedAt: new Date() };
  const doc = await SupportTicket.findByIdAndUpdate(
    id,
    reply ? { ...update, $push: { thread: { from: 'admin', text: reply, at: new Date() } } } : update,
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
    source: obj.source || 'app',
    fromEmail: obj.fromEmail || null,
    fromName: obj.fromName || null,
    ref: obj.ref || null,
    emailMessageId: obj.emailMessageId || null,
    thread: Array.isArray(obj.thread) ? obj.thread.map((t) => ({ from: t.from, text: t.text, at: t.at })) : [],
    aiStatus: obj.aiStatus || null,
    escalated: !!obj.escalated,
    urgent: !!obj.urgent,
    // What the assistant answered (the customer sees it in their ticket list).
    aiReply: (Array.isArray(obj.thread) ? [...obj.thread].reverse().find((t) => t.from === 'ai') : null)?.text || null,
    createdAt: obj.createdAt,
  };
}

module.exports = { createTicket, listTicketsForUser, listAllTickets, resolveTicket };
