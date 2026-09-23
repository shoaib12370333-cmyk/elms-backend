const crypto = require('crypto');
const mongoose = require('mongoose');

const supportTicketSchema = new mongoose.Schema(
  {
    // Missing for a ticket that arrived as an email from someone with no ELMS account.
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: undefined },
    subject: { type: String, required: true },
    message: { type: String, required: true },
    status: { type: String, enum: ['open', 'resolved'], default: 'open' },

    // Set by an admin when resolving the ticket (e.g. after topping up credits).
    adminReply: { type: String, default: null },
    resolvedAt: { type: Date, default: null },

    // Where the ticket came from: the in-app form, or a mail sent to the support address.
    source: { type: String, enum: ['app', 'email', 'appeal'], default: 'app' },
    fromEmail: { type: String, default: undefined },
    fromName: { type: String, default: undefined },
    // Short code put in reply subjects ("[Ticket #a1b2c3d4]") so a customer's answer finds its ticket again.
    ref: { type: String, default: () => crypto.randomBytes(4).toString('hex') },
    // Message-ID of the mail that opened the ticket - dedupes re-reads and threads our replies to it.
    emailMessageId: { type: String, default: undefined },
    // Follow-up conversation (customer mails that arrived after the first one, and admin replies).
    thread: [{ _id: false, from: { type: String, enum: ['customer', 'admin', 'ai', 'system'] }, text: String, at: { type: Date, default: Date.now }, emailMessageId: String }],
    // AI-first support: the assistant answers what it can and hands the rest to an admin.
    aiStatus: { type: String, enum: ['answered', 'escalated', 'error'], default: undefined },
    escalated: { type: Boolean, default: false },
    urgent: { type: Boolean, default: false },
    escalationReason: { type: String, default: undefined },
    // Last time an admin alert went out for a customer follow-up (so a chatty customer does not flood the inbox).
    lastAlertAt: { type: Date, default: undefined },
  },
  { timestamps: true }
);

// Unique only where the field really exists: no stored nulls (a unique index treats every null as one value).
supportTicketSchema.index({ emailMessageId: 1 }, { unique: true, partialFilterExpression: { emailMessageId: { $type: 'string' } } });
supportTicketSchema.index({ ref: 1 });

module.exports = mongoose.model('SupportTicket', supportTicketSchema);
