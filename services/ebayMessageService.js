const axios = require('axios');
const { getAccessToken } = require('./ebayAuthService');
const { retryWithBackoff } = require('./retryService');
const { EBAY_API_BASE_URL: EBAY_BASE_URL } = require('../config/ebayEnvironment');

/**
 * Sends an authenticated request to eBay's Message API
 * (sell/communication/v1/... under the hood, exposed as the "Message API").
 * GET requests are retried on transient failures; sends are not, to avoid
 * ever risking a duplicate message being sent.
 */
async function messageApiRequest(refreshToken, method, path, body) {
  const accessToken = await getAccessToken(refreshToken);

  const makeRequest = () =>
    axios({
      method,
      url: `${EBAY_BASE_URL}/commerce/message/v1${path}`,
      data: body,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 20000,
    });

  try {
    const response = method.toUpperCase() === 'GET'
      ? await retryWithBackoff(makeRequest)
      : await makeRequest();
    return response.data;
  } catch (err) {
    const ebayErrors = err.response?.data?.errors;
    const message = ebayErrors && ebayErrors.length
      ? ebayErrors.map((e) => e.message).join('; ')
      : err.message || 'The eBay Message API request failed.';
    const wrapped = new Error(message);
    wrapped.statusCode = err.response?.status || 500;
    throw wrapped;
  }
}

/**
 * Fetches the list of conversations (buyer messages, system alerts,
 * cancellation-related threads, etc) for one eBay account.
 *
 * @param {string} refreshToken
 * @param {object} options - { limit, offset, filter } - filter can narrow
 *   by read/unread status or conversation type if the caller needs that.
 */
async function fetchConversations(refreshToken, options = {}) {
  const { limit = 10, offset = 0, conversationStatus, conversationType, referenceId, referenceType, startTime, endTime, otherPartyUsername } = options;
  const params = new URLSearchParams({ limit: String(Math.min(Number(limit) || 10, 10)), offset: String(Number(offset) || 0) });
  if (conversationStatus) params.append('conversationStatus', conversationStatus);
  if (conversationType) params.append('conversation_type', conversationType);
  if (referenceId) params.append('reference_id', referenceId);
  if (referenceType) params.append('reference_type', referenceType);
  if (startTime) params.append('start_time', startTime);
  if (endTime) params.append('end_time', endTime);
  if (otherPartyUsername) params.append('other_party_username', otherPartyUsername);

  const data = await messageApiRequest(refreshToken, 'GET', `/conversation?${params.toString()}`);
  const conversations = Array.isArray(data.conversations) ? data.conversations : [];

  return conversations.map((c) => ({
    conversationId: c.conversationId,
    subject: c.subject || null,
    // The other participant's username (buyer, or "eBay" for system messages).
    fromUsername: c.participants?.find((p) => !p.isSelf)?.username || c.sender?.username || 'eBay',
    conversationType: c.conversationType || c.type || 'FROM_MEMBERS',
    conversationStatus: c.conversationStatus || c.status || 'ACTIVE',
    otherPartyUsername: c.otherParty?.username || c.otherPartyUsername || c.participants?.find((p) => !p.isSelf)?.username || c.sender?.username || 'eBay',
    referenceId: c.reference?.referenceID || c.itemId || c.orderId || null,
    referenceType: c.reference?.referenceType || (c.itemId ? 'LISTING' : null),
    status: c.status || null,
    isRead: c.readStatus === 'READ' || c.isRead === true,
    lastMessageSnippet: c.lastMessage?.content || c.snippet || null,
    lastMessageDate: c.lastMessageDate || c.creationDate || null,
    itemId: c.itemId || c.orderId || null,
  }));
}

/**
 * Fetches every message within a single conversation thread.
 */
async function fetchConversationDetail(refreshToken, conversationId, conversationType = 'FROM_MEMBERS') {
  const data = await messageApiRequest(refreshToken, 'GET', `/conversation/${encodeURIComponent(conversationId)}?conversation_type=${encodeURIComponent(conversationType)}`);
  const messages = Array.isArray(data.messages) ? data.messages : [];

  return {
    conversationId,
    subject: data.subject || null,
    messages: messages.map((m) => ({
      content: m.content || m.body || null,
      fromUsername: m.sender?.username || (m.isSelf ? 'You' : 'eBay'),
      isSelf: !!m.isSelf,
      sentDate: m.creationDate || m.sentDate || null,
    })),
  };
}

/**
 * Sends a reply message in a conversation (or starts a new one, if the
 * eBay API supports that for the given context - see itemId/orderId).
 */
async function sendMessage(refreshToken, { conversationId, recipientUsername, itemId, content }) {
  const body = { messageText: content };
  if (conversationId) body.conversationId = conversationId;
  if (recipientUsername) body.otherPartyUsername = recipientUsername;
  if (itemId) body.reference = { referenceType: 'LISTING', referenceID: itemId };

  return messageApiRequest(refreshToken, 'POST', '/send_message', body);
}

/**
 * Marks a conversation as read/unread/archived - keeps ELMS's own
 * "unread count" in sync with what the user has actually looked at.
 */
async function updateConversationStatus(refreshToken, conversationId, status, conversationType = 'FROM_MEMBERS') {
  return messageApiRequest(refreshToken, 'POST', '/update_conversation', {
    conversationId,
    conversationType,
    status: ['ACTIVE', 'ARCHIVED', 'DELETED'].includes(status) ? status : undefined,
    read: status === 'READ' ? true : status === 'UNREAD' ? false : undefined,
  });
}

module.exports = {
  fetchConversations,
  fetchConversationDetail,
  sendMessage,
  updateConversationStatus,
};
