const Conversation = require('./schemas/Conversation');
const { accountLabel, publicUsername } = require('../services/accountLabel');
const { messageToText } = require('../services/messageTextService');

/**
 * Creates or updates one conversation from an eBay sync, matched by the
 * unique (userId, ebayAccountId, ebayConversationId) combo so re-syncing
 * never creates duplicates.
 */
async function upsertConversation(userId, ebayAccountId, conv) {
  const existing = await Conversation.findOne({ userId, ebayAccountId, ebayConversationId: conv.conversationId }).select('conversationStatus trashedAt').lean();
  const incomingStatus = conv.conversationStatus === 'ARCHIVED' ? 'ARCHIVE' : (conv.conversationStatus || 'ACTIVE');
  const conversationStatus = existing?.conversationStatus === 'DELETE' ? 'DELETE' : incomingStatus;
  const doc = await Conversation.findOneAndUpdate(
    { userId, ebayAccountId, ebayConversationId: conv.conversationId },
    {
      userId,
      ebayAccountId,
      ebayConversationId: conv.conversationId,
      subject: conv.subject,
      fromUsername: conv.fromUsername,
      conversationType: conv.conversationType,
      conversationStatus,
      otherPartyUsername: conv.otherPartyUsername || conv.fromUsername || null,
      referenceId: conv.referenceId || conv.itemId || null,
      referenceType: conv.referenceType || null,
      lastMessageSnippet: messageToText(conv.lastMessageSnippet),
      lastMessageDate: conv.lastMessageDate ? new Date(conv.lastMessageDate) : null,
      itemId: conv.itemId,
      isRead: conv.isRead,
      lastMessageFromSelf: !!conv.lastMessageFromSelf,
      ...(conv.trashedAt ? { trashedAt: new Date(conv.trashedAt) } : {}),
    },
    { new: true, upsert: true }
  );
  return serialize(doc);
}

/**
 * Returns all of a user's conversations across ALL of their connected
 * eBay accounts (a combined view), optionally filtered to one account.
 */
async function listConversations(userId, accountId, options = {}) {
  let query = accountId ? { userId, ebayAccountId: accountId } : { userId };
  if (options.status === 'archived') query.conversationStatus = 'ARCHIVE';
  else if (options.status === 'trash') query.conversationStatus = 'DELETE';
  else if (options.status === 'awaiting') query = { ...query, conversationStatus: 'ACTIVE', conversationType: 'FROM_MEMBERS', lastMessageFromSelf: false };
  // No status filter otherwise (every status, including DELETE) - the Messages
  // page fetches once and re-filters client-side for every tab (All/Unread/
  // Archived/Trash), so a narrower default here used to leave it holding a
  // partial dataset (e.g. after switching stores while on the Trash tab) that
  // made OTHER tabs' counts and contents wrong until the next full refetch.
  if (options.type && options.type !== 'all') query.conversationType = options.type;
  if (options.search) {
    const rx = new RegExp(String(options.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    query.$or = [{ subject: rx }, { otherPartyUsername: rx }, { lastMessageSnippet: rx }];
  }
  const docs = await Conversation.find(query).populate('ebayAccountId', 'ebayUserId displayName storeName storeNumber').sort({ lastMessageDate: -1 }).lean();
  return docs.map((doc) => {
    const serialized = serialize(doc);
    serialized.ebay_account_username = publicUsername(doc.ebayAccountId?.ebayUserId);
    serialized.ebay_account_label = doc.ebayAccountId ? accountLabel(doc.ebayAccountId) : null;
    serialized.ebay_account_display_name = doc.ebayAccountId?.displayName || null;
    return serialized;
  });
}

/**
 * Returns how many of a user's conversations (across all accounts) are
 * unread - powers the notification bell's badge count.
 */
async function countUnreadConversations(userId, accountId = null) {
  return Conversation.countDocuments({ userId, isRead: false, ...(accountId ? { ebayAccountId: accountId } : {}) });
}

async function getConversationById(userId, id) {
  const doc = await Conversation.findOne({ _id: id, userId });
  return doc ? serialize(doc) : null;
}

/**
 * Opening a thread: the conversation plus its stored buyer profile (with the time it was fetched, which the
 * serialized copy leaves out) in ONE lean read instead of a hydrated document and a second query.
 */
async function getConversationForThread(userId, id) {
  const doc = await Conversation.findOne({ _id: id, userId }).lean();
  return doc ? { conversation: serialize(doc), storedBuyerProfile: doc.buyerProfile || null } : null;
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

async function trashConversation(userId, id) {
  const doc = await Conversation.findOneAndUpdate({ _id: id, userId }, { conversationStatus: 'DELETE', trashedAt: new Date(), isRead: true }, { new: true });
  return doc ? serialize(doc) : null;
}

async function restoreConversation(userId, id) {
  const doc = await Conversation.findOneAndUpdate({ _id: id, userId }, { conversationStatus: 'ACTIVE', trashedAt: null }, { new: true });
  return doc ? serialize(doc) : null;
}

async function purgeExpiredTrash() {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  return Conversation.deleteMany({ conversationStatus: 'DELETE', trashedAt: { $lte: cutoff } });
}

async function markConversationRead(userId, id, isRead = true) {
  const doc = await Conversation.findOneAndUpdate({ _id: id, userId }, { isRead }, { new: true });
  return doc ? serialize(doc) : null;
}

function serialize(doc) {
  // Accepts either a real Mongoose document or a plain object from .lean()
  // (listConversations uses .lean() - skips document hydration for a faster
  // Messages inbox load).
  const obj = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  return {
    id: obj._id.toString(),
    ebay_account_id: obj.ebayAccountId?._id ? obj.ebayAccountId._id.toString() : obj.ebayAccountId?.toString(),
    ebay_conversation_id: obj.ebayConversationId,
    subject: obj.subject,
    from_username: obj.fromUsername,
    conversation_type: obj.conversationType,
    last_message_snippet: messageToText(obj.lastMessageSnippet), // older rows may still hold eBay's HTML
    last_message_date: obj.lastMessageDate,
    item_id: obj.itemId,
    is_read: obj.isRead,
    last_message_from_self: !!obj.lastMessageFromSelf,
    trashed_at: obj.trashedAt || null,
    ai_draft: obj.aiDraft && obj.aiDraft.forMessageId ? { text: obj.aiDraft.text || '', status: obj.aiDraft.status, for_message_id: obj.aiDraft.forMessageId, created_at: obj.aiDraft.createdAt || null } : null,
    conversation_status: obj.conversationStatus || 'ACTIVE',
    other_party_username: obj.otherPartyUsername || obj.fromUsername || null,
    reference_id: obj.referenceId || obj.itemId || null,
    reference_type: obj.referenceType || null,
    internal_notes: Array.isArray(obj.internalNotes) ? obj.internalNotes.map((n) => ({ text: n.text, created_at: n.createdAt })) : [],
    buyer_profile: serializeBuyerProfile(obj.buyerProfile),
    created_at: obj.createdAt,
  };
}

function serializeBuyerProfile(p) {
  if (!p || (p.feedbackScore == null && !p.memberSince && !p.site)) return null;
  return { feedback_score: p.feedbackScore ?? null, star_color: p.starColor || null, member_since: p.memberSince || null, site: p.site || null };
}

module.exports = {
  serializeBuyerProfile,
  upsertConversation,
  listConversations,
  countUnreadConversations,
  getConversationById,
  getConversationForThread,
  markConversationRead,
  addInternalNote,
  updateConversationState,
  trashConversation,
  restoreConversation,
  purgeExpiredTrash,
};
