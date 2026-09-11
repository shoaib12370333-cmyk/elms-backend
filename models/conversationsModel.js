const Conversation = require('./schemas/Conversation');

/**
 * Creates or updates one conversation from an eBay sync, matched by the
 * unique (userId, ebayAccountId, ebayConversationId) combo so re-syncing
 * never creates duplicates.
 */
async function upsertConversation(userId, ebayAccountId, conv) {
  const doc = await Conversation.findOneAndUpdate(
    { userId, ebayAccountId, ebayConversationId: conv.conversationId },
    {
      userId,
      ebayAccountId,
      ebayConversationId: conv.conversationId,
      subject: conv.subject,
      fromUsername: conv.fromUsername,
      conversationType: conv.conversationType,
      conversationStatus: conv.conversationStatus || 'ACTIVE',
      otherPartyUsername: conv.otherPartyUsername || conv.fromUsername || null,
      referenceId: conv.referenceId || conv.itemId || null,
      referenceType: conv.referenceType || null,
      lastMessageSnippet: conv.lastMessageSnippet,
      lastMessageDate: conv.lastMessageDate ? new Date(conv.lastMessageDate) : null,
      itemId: conv.itemId,
      isRead: conv.isRead,
    },
    { new: true, upsert: true }
  );
  return serialize(doc);
}

/**
 * Returns all of a user's conversations across ALL of their connected
 * eBay accounts (a combined view), optionally filtered to one account.
 */
async function listConversations(userId, accountId) {
  const query = accountId ? { userId, ebayAccountId: accountId } : { userId };
  const docs = await Conversation.find(query).populate('ebayAccountId').sort({ lastMessageDate: -1 });
  return docs.map((doc) => {
    const serialized = serialize(doc);
    serialized.ebay_account_username = doc.ebayAccountId?.ebayUserId || null;
    serialized.ebay_account_display_name = doc.ebayAccountId?.displayName || null;
    return serialized;
  });
}

/**
 * Returns how many of a user's conversations (across all accounts) are
 * unread - powers the notification bell's badge count.
 */
async function countUnreadConversations(userId) {
  return Conversation.countDocuments({ userId, isRead: false });
}

async function getConversationById(userId, id) {
  const doc = await Conversation.findOne({ _id: id, userId });
  return doc ? serialize(doc) : null;
}

async function addInternalNote(userId, id, text) {
  const clean = String(text || '').trim();
  if (!clean) return null;
  const doc = await Conversation.findOneAndUpdate(
    { _id: id, userId },
    { $push: { internalNotes: { text: clean.slice(0, 2000) } } },
    { new: true }
  );
  return doc ? serialize(doc) : null;
}


async function updateConversationState(userId, id, patch) {
  const allowed = {};
  if (typeof patch?.isRead === 'boolean') allowed.isRead = patch.isRead;
  if (patch?.conversationStatus) allowed.conversationStatus = patch.conversationStatus;
  const doc = await Conversation.findOneAndUpdate({ _id: id, userId }, allowed, { new: true });
  return doc ? serialize(doc) : null;
}

async function markConversationRead(userId, id, isRead = true) {
  const doc = await Conversation.findOneAndUpdate({ _id: id, userId }, { isRead }, { new: true });
  return doc ? serialize(doc) : null;
}

function serialize(doc) {
  const obj = doc.toObject();
  return {
    id: obj._id.toString(),
    ebay_account_id: obj.ebayAccountId?._id ? obj.ebayAccountId._id.toString() : obj.ebayAccountId?.toString(),
    ebay_conversation_id: obj.ebayConversationId,
    subject: obj.subject,
    from_username: obj.fromUsername,
    conversation_type: obj.conversationType,
    last_message_snippet: obj.lastMessageSnippet,
    last_message_date: obj.lastMessageDate,
    item_id: obj.itemId,
    is_read: obj.isRead,
    conversation_status: obj.conversationStatus || 'ACTIVE',
    other_party_username: obj.otherPartyUsername || obj.fromUsername || null,
    reference_id: obj.referenceId || obj.itemId || null,
    reference_type: obj.referenceType || null,
    internal_notes: Array.isArray(obj.internalNotes) ? obj.internalNotes.map((n) => ({ text: n.text, created_at: n.createdAt })) : [],
    created_at: obj.createdAt,
  };
}

module.exports = {
  upsertConversation,
  listConversations,
  countUnreadConversations,
  getConversationById,
  markConversationRead,
  addInternalNote,
  updateConversationState,
};
