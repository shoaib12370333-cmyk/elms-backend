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

// ---------- the customer's side of the conversation ----------
/** How many tickets the user opened since a moment (to stop a flood). */
async function countTicketsSince(userId, since) {
  return SupportTicket.countDocuments({ userId, createdAt: { $gte: since } });
}

const MAX_THREAD = 60;
const MAX_CUSTOMER_MESSAGES_PER_HOUR = 15;

/** One of the user's own tickets, or null. */
async function getTicketForUser(userId, id) {
  const doc = await SupportTicket.findOne({ _id: id, userId });
  return doc ? serialize(doc) : null;
}

/**
 * Adds a message from the customer to their ticket (and reopens it if it was closed).
 * Returns { ticket } or { error, status } when it is refused (unknown ticket, conversation too long, too fast).
 */
async function addCustomerMessage(userId, id, text) {
  const doc = await SupportTicket.findOne({ _id: id, userId });
  if (!doc) return { error: 'Ticket not found.', status: 404 };
  const thread = Array.isArray(doc.thread) ? doc.thread : [];
  if (thread.length >= MAX_THREAD) return { error: 'This conversation is very long. Please press "Talk to admin" so a person can help.', status: 429 };
  const hourAgo = Date.now() - 60 * 60 * 1000;
  if (thread.filter((t) => t.from === 'customer' && new Date(t.at).getTime() > hourAgo).length >= MAX_CUSTOMER_MESSAGES_PER_HOUR) {
    return { error: 'You are sending messages very quickly. Please wait a little, or press "Talk to admin".', status: 429 };
  }
  const updated = await SupportTicket.findOneAndUpdate(
    { _id: id, userId },
    { $set: { status: 'open', resolvedAt: null }, $push: { thread: { from: 'customer', text, at: new Date() } } },
    { new: true }
  );
  return { ticket: serialize(updated) };
}

/** The customer says it is solved: the ticket is closed and the conversation stays saved for the admin. */
async function closeTicketByCustomer(userId, id) {
  const doc = await SupportTicket.findOneAndUpdate(
    { _id: id, userId, status: { $ne: 'resolved' } },
    { $set: { status: 'resolved', resolvedAt: new Date() }, $push: { thread: { from: 'system', text: 'The customer marked this as solved and closed the ticket.', at: new Date() } } },
    { new: true }
  );
  if (doc) return serialize(doc);
  const existing = await SupportTicket.findOne({ _id: id, userId });
  return existing ? serialize(existing) : null;
}

module.exports = { createTicket, listTicketsForUser, listAllTickets, resolveTicket, getTicketForUser, addCustomerMessage, closeTicketByCustomer, countTicketsSince };
