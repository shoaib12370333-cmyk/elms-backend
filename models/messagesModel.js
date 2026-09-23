const Message = require('./schemas/Message');

function normalizeMessage(m) {
  if (!m?.messageId) return null;
  return {
    ebayMessageId: String(m.messageId),
    content: String(m.content || ''),
    fromUsername: m.fromUsername || null,
    isSelf: !!m.isSelf,
    readStatus: !!m.readStatus,
    sentDate: m.sentDate ? new Date(m.sentDate) : null,
    media: Array.isArray(m.media) ? m.media.filter((x) => x && x.url).map((x) => ({ name: String(x.name || ''), type: String(x.type || ''), url: String(x.url) })) : [],
  };
}

async function upsertMessages({ userId, ebayAccountId, conversationDoc, ebayConversationId, messages }) {
  const normalized = (messages || []).map(normalizeMessage).filter(Boolean);
  if (!normalized.length) return 0;
  const ops = normalized.map((m) => ({
    updateOne: {
      filter: { userId, ebayAccountId, ebayConversationId, ebayMessageId: m.ebayMessageId },
      update: { $set: { ...m, userId, ebayAccountId, conversationId: conversationDoc._id, ebayConversationId } },
      upsert: true,
    }
  }));
  await Message.bulkWrite(ops, { ordered: false });
  return normalized.length;
}

async function listMessages(userId, conversationId) {
  const docs = await Message.find({ userId, conversationId }).sort({ sentDate: 1, createdAt: 1 }).lean();
  return docs.map(m => ({
    messageId: m.ebayMessageId,
    content: m.content,
    fromUsername: m.fromUsername,
    isSelf: m.isSelf,
    readStatus: m.readStatus,
    sentDate: m.sentDate,
    media: Array.isArray(m.media) ? m.media : [],
  }));
}

module.exports = { upsertMessages, listMessages };
