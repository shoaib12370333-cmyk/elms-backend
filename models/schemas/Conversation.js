const mongoose = require('mongoose');

/**
 * Local cache of eBay conversations, synced periodically (like orders).
 * We don't rely purely on live eBay calls for the notification bell/list
 * because that would mean hitting eBay's API on every page load - instead
 * we sync into this collection and read from here, similar to how Orders work.
 */
const conversationSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    ebayAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'EbayAccount', required: true },
    ebayConversationId: { type: String, required: true },
    subject: { type: String, default: null },
    fromUsername: { type: String, default: 'eBay' },
    conversationType: { type: String, default: 'FROM_MEMBERS' },
    conversationStatus: { type: String, default: 'ACTIVE' },
    otherPartyUsername: { type: String, default: null },
    referenceId: { type: String, default: null },
    referenceType: { type: String, default: null },
    lastMessageSnippet: { type: String, default: null },
    lastMessageDate: { type: Date, default: null },
    itemId: { type: String, default: null },
    isRead: { type: Boolean, default: false },
    internalNotes: [{
      text: { type: String, required: true, maxlength: 2000 },
      createdAt: { type: Date, default: Date.now },
    }],
  },
  { timestamps: true }
);

// Never store the same eBay conversation twice for the same account.
conversationSchema.index({ userId: 1, ebayAccountId: 1, ebayConversationId: 1 }, { unique: true });

module.exports = mongoose.model('Conversation', conversationSchema);
