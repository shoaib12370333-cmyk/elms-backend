const SupportTicket = require('../models/schemas/SupportTicket');
const User = require('../models/schemas/User');

/**
 * Appeals against a suspension or an IP block. An appeal is a support ticket with source "appeal" (see routes/appeals.js); this file is
 * what the admin's Appeals section reads: each appeal with the state of the account it is about.
 */

const MAX_APPEALS = 200;

/**
 * Every appeal, open ones first (newest first inside each group), with the account it belongs to. An email with no ELMS account has
 * account = null.
 */
async function listAppeals({ limit = MAX_APPEALS } = {}) {
  const tickets = await SupportTicket.find({ source: 'appeal' }).sort({ createdAt: -1 }).limit(Math.min(Number(limit) || MAX_APPEALS, MAX_APPEALS)).lean();
  const ids = [...new Set(tickets.map((t) => t.userId && String(t.userId)).filter(Boolean))];
  const users = ids.length
    ? await User.find({ _id: { $in: ids } }, { email: 1, name: 1, role: 1, suspendedAt: 1, suspendedReason: 1, suspendedPermanent: 1 }).lean()
    : [];
  const byId = new Map(users.map((u) => [String(u._id), u]));
  const rows = tickets.map((t) => {
    const u = t.userId ? byId.get(String(t.userId)) : null;
    return {
      id: String(t._id),
      ref: t.ref || null,
      status: t.status,
      createdAt: t.createdAt,
      resolvedAt: t.resolvedAt || null,
      email: t.fromEmail || (u && u.email) || null,
      name: t.fromName || (u && u.name) || null,
      message: t.message,
      thread: Array.isArray(t.thread) ? t.thread.map((m) => ({ from: m.from, text: m.text, at: m.at })) : [],
      adminReply: t.adminReply || null,
      account: u ? {
        id: String(u._id),
        email: u.email,
        suspended: !!u.suspendedAt,
        permanent: !!(u.suspendedAt && u.suspendedPermanent),
        reason: u.suspendedReason || null,
        since: u.suspendedAt || null,
      } : null,
    };
  });
  const open = rows.filter((r) => r.status !== 'resolved');
  return { appeals: [...open, ...rows.filter((r) => r.status === 'resolved')], open: open.length };
}

/** Closes the open appeals of one person (they were answered by reinstating the account). No mail is sent from here. */
async function closeOpenAppeals(userId, email, text) {
  const or = [{ userId }];
  if (email) or.push({ fromEmail: String(email).trim().toLowerCase() });
  await SupportTicket.updateMany(
    { source: 'appeal', status: 'open', $or: or },
    { $set: { status: 'resolved', resolvedAt: new Date() }, $push: { thread: { from: 'system', text: String(text || 'Closed.'), at: new Date() } } }
  );
}

module.exports = { listAppeals, closeOpenAppeals };
