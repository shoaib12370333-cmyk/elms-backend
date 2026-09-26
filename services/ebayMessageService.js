const axios = require('axios');
const { getAccessToken } = require('./ebayAuthService');
const { retryWithBackoff } = require('./retryService');
const { messageToText } = require('./messageTextService');
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
  const {
    limit = 50,
    offset = 0,
    conversationType,
    conversationStatus,
    referenceId,
    referenceType,
    startTime,
    endTime,
    otherPartyUsername,
  } = options;

  // eBay requires conversation_type on every getConversations request.
  if (!conversationType || !['FROM_MEMBERS', 'FROM_EBAY'].includes(conversationType)) {
    throw Object.assign(new Error('conversationType must be FROM_MEMBERS or FROM_EBAY.'), { statusCode: 400 });
  }

  const params = new URLSearchParams({
    conversation_type: conversationType,
    limit: String(Math.min(Math.max(Number(limit) || 10, 1), 10)),
    offset: String(Math.max(Number(offset) || 0, 0)),
  });
  if (conversationStatus) params.append('conversation_status', conversationStatus);
  if (referenceId) params.append('reference_id', referenceId);
  if (referenceType) params.append('reference_type', referenceType);
  if (startTime) params.append('start_time', startTime);
  if (endTime) params.append('end_time', endTime);
  if (otherPartyUsername) params.append('other_party_username', otherPartyUsername);

  const data = await messageApiRequest(refreshToken, 'GET', `/conversation?${params.toString()}`);
  const conversations = Array.isArray(data.conversations) ? data.conversations : [];

  return conversations.map((c) => {
    const latest = c.latestMessage || c.lastMessage || {};
    const otherParty = latest.senderUsername || c.otherPartyUsername || c.participants?.find((p) => !p.isSelf)?.username || 'eBay';
    const readStatus = typeof latest.readStatus === 'boolean'
      ? latest.readStatus
      : (typeof c.readStatus === 'boolean' ? c.readStatus : (c.unreadCount ? false : true));

    const rawConversationStatus = c.conversationStatus || conversationStatus || 'ACTIVE';
    const normalizedConversationStatus = rawConversationStatus === 'ARCHIVED' ? 'ARCHIVE' : (rawConversationStatus === 'DELETED' ? 'DELETE' : rawConversationStatus);
    return {
      conversationId: c.conversationId,
      subject: c.conversationTitle || c.subject || latest.subject || null,
      fromUsername: latest.senderUsername || c.senderUsername || otherParty,
      conversationType: c.conversationType || conversationType,
      conversationStatus: normalizedConversationStatus,

      otherPartyUsername: otherParty,
      referenceId: c.referenceId || c.reference?.referenceID || c.itemId || c.orderId || null,
      referenceType: c.referenceType || c.reference?.referenceType || (c.itemId ? 'LISTING' : null),
      status: c.conversationStatus || null,
      isRead: readStatus,
      lastMessageSnippet: messageToText(latest.messageBody || latest.content || c.snippet || '') || null,
      lastMessageDate: latest.createdDate || c.createdDate || c.lastMessageDate || null,
      itemId: c.referenceType === 'LISTING' ? (c.referenceId || c.itemId || null) : (c.itemId || null),
    };
  });
}

/**
 * Fetches every message within a single conversation thread.
 */
async function fetchConversationDetail(refreshToken, conversationId, conversationType = 'FROM_MEMBERS') {
  if (!['FROM_MEMBERS', 'FROM_EBAY'].includes(conversationType)) {
    throw Object.assign(new Error('Invalid conversation type.'), { statusCode: 400 });
  }

  const allMessages = [];
  let subject = null;
  // getConversation is paginated too. Walk every page so a long thread is not
  // silently truncated to the first 50 messages.
  for (let offset = 0, page = 0; page < 100; offset += 50, page += 1) {
    const data = await messageApiRequest(
      refreshToken,
      'GET',
      `/conversation/${encodeURIComponent(conversationId)}?conversation_type=${encodeURIComponent(conversationType)}&limit=50&offset=${offset}`
    );
    if (!subject) subject = data.conversationTitle || data.subject || null;
    const messages = Array.isArray(data.messages) ? data.messages : [];
    allMessages.push(...messages);
    if (messages.length < 50) break;
  }

  return {
    conversationId,
    subject,
    messages: allMessages.map((m) => ({
      messageId: m.messageId || null,
      content: messageToText(m.messageBody || m.content || m.body || ''),
      fromUsername: m.senderUsername || m.sender?.username || (m.isSelf ? 'You' : (conversationType === 'FROM_EBAY' ? 'eBay' : 'Member')),
      isSelf: typeof m.isSelf === 'boolean' ? m.isSelf : false,
      readStatus: m.readStatus,
      sentDate: m.createdDate || m.creationDate || m.sentDate || null,
      media: Array.isArray(m.messageMedia)
        ? m.messageMedia.filter((x) => x && x.mediaUrl).map((x) => ({ name: x.mediaName || '', type: x.mediaType || '', url: x.mediaUrl }))
        : [],
    })),
  };
}

/**
 * Sends a reply message in a conversation (or starts a new one, if the
 * eBay API supports that for the given context - see itemId/orderId).
 */
async function sendMessage(refreshToken, { conversationId, recipientUsername, itemId, content, media }) {
  const body = { messageText: content };
  // eBay accepts up to 5 self-hosted (HTTPS) attachments per message: IMAGE, PDF, DOC or TXT.
  if (Array.isArray(media) && media.length) {
    body.messageMedia = media.slice(0, 5).map((x) => ({ mediaName: x.name, mediaType: x.type, mediaUrl: x.url }));
  }
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
  const body = { conversationId, conversationType };
  if (status === 'READ') body.read = true;
  else if (status === 'UNREAD') body.read = false;
  else if (status === 'ACTIVE') body.conversationStatus = 'ACTIVE';
  else if (status === 'ARCHIVE' || status === 'ARCHIVED') body.conversationStatus = 'ARCHIVE';
  else if (status === 'DELETE' || status === 'DELETED') body.conversationStatus = 'DELETE';
  else throw Object.assign(new Error(`Unsupported conversation status: ${status}`), { statusCode: 400 });
  return messageApiRequest(refreshToken, 'POST', '/update_conversation', body);
}

module.exports = {
  fetchConversations,
  fetchConversationDetail,
  sendMessage,
  updateConversationStatus,
};
