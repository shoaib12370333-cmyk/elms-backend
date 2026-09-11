const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/requireAuth');
const {
  listConversations,
  countUnreadConversations,
  getConversationById,
  markConversationRead,
  upsertConversation,
  addInternalNote,
  updateConversationState,
} = require('../models/conversationsModel');
const { getEbayAccountRefreshToken, listEbayAccounts } = require('../models/ebayAccountsModel');
const { fetchConversations, fetchConversationDetail, sendMessage, updateConversationStatus } = require('../services/ebayMessageService');
const Order = require('../models/schemas/Order');
const Listing = require('../models/schemas/Listing');

/**
 * GET /api/notifications/unread-count
 * Requires a valid session token.
 * Returns how many of the user's conversations (across all eBay accounts)
 * are unread - powers the notification bell's badge number.
 */
router.get('/unread-count', requireAuth, async (req, res) => {
  const count = await countUnreadConversations(req.userId);
  res.json({ success: true, count });
});

/**
 * GET /api/notifications?accountId=...
 * Requires a valid session token.
 * Returns the user's conversations across all connected eBay accounts (a
 * combined view), or filtered to one account if accountId is given.
 * Triggers a background sync first so the list reflects anything new.
 */
router.get('/', requireAuth, async (req, res) => {
  try {
    await syncConversationsForUser(req.userId);
  } catch (err) {
    // Non-fatal - we still show whatever was already cached.
    console.warn('notifications sync-before-list warning:', err.message);
  }

  const conversations = await listConversations(req.userId, req.query.accountId);
  res.json({ success: true, conversations });
});

/**
 * Syncs conversations for just one user's accounts (used to give an
 * immediate refresh when they open the Notifications page, rather than
 * waiting for the next scheduled background sync).
 */
async function syncConversationsForUser(userId) {
  const accounts = await listEbayAccounts(userId);
  for (const account of accounts) {
    const refreshToken = await getEbayAccountRefreshToken(userId, account.id);
    if (!refreshToken) continue;
    for (let offset = 0; offset < 100; offset += 10) {
      const conversations = await fetchConversations(refreshToken, { limit: 10, offset });
      for (const conv of conversations) {
        await upsertConversation(userId, account.id, conv);
      }
      if (conversations.length < 10) break;
    }
  }
}

/**
 * GET /api/notifications/:id
 * Requires a valid session token.
 * Returns the full message thread for one conversation, and marks it as
 * read (since the user is now viewing it).
 */
router.get('/:id', requireAuth, async (req, res) => {
  const conversation = await getConversationById(req.userId, req.params.id);
  if (!conversation) {
    return res.status(404).json({ success: false, error: 'Conversation not found.' });
  }

  try {
    const refreshToken = await getEbayAccountRefreshToken(req.userId, conversation.ebay_account_id);
    const detail = refreshToken
      ? await fetchConversationDetail(refreshToken, conversation.ebay_conversation_id, conversation.conversation_type)
      : { messages: [] };

    await markConversationRead(req.userId, req.params.id, true);
    if (refreshToken) {
      updateConversationStatus(refreshToken, conversation.ebay_conversation_id, 'READ', conversation.conversation_type).catch(() => {});
    }

    const referenceId = conversation.reference_id || conversation.item_id || null;
    const order = referenceId
      ? await Order.findOne({ userId: req.userId, $or: [{ ebayOrderId: referenceId }, { ebayLineItemId: referenceId }] }).populate('listingId')
      : null;
    const listing = order?.listingId || (referenceId ? await Listing.findOne({ userId: req.userId, ebayListingId: referenceId }) : null);

    res.json({
      success: true,
      conversation,
      detail,
      context: order ? { type: 'order', order_id: order._id.toString(), ebay_order_id: order.ebayOrderId, buyer_username: order.buyerUsername, sale_price: order.salePrice, quantity: order.quantity, fulfillment_status: order.fulfillmentStatus, listing_id: listing?._id?.toString() || null, listing_title: listing?.title || null, main_image: listing?.mainImage || null } : listing ? { type: 'listing', listing_id: listing._id.toString(), listing_title: listing.title, main_image: listing.mainImage || null, ebay_item_id: listing.ebayItemId || referenceId } : null,
    });
  } catch (err) {
    console.error('notification-detail error:', err.message);
    res.status(err.statusCode || 500).json({ success: false, error: err.message || 'Could not load this conversation.' });
  }
});

/**
 * POST /api/notifications/:id/reply
 * Requires a valid session token.
 * Body: { content: string }
 *
 * Sends a reply message in this conversation - this is how a seller can
 * respond to a buyer directly from ELMS instead of going to eBay.
 */
router.post('/:id/reply', requireAuth, async (req, res) => {
  const { content } = req.body;
  if (!content || !content.trim()) {
    return res.status(400).json({ success: false, error: 'Message content is required.' });
  }

  const conversation = await getConversationById(req.userId, req.params.id);
  if (!conversation) {
    return res.status(404).json({ success: false, error: 'Conversation not found.' });
  }

  const refreshToken = await getEbayAccountRefreshToken(req.userId, conversation.ebay_account_id);
  if (!refreshToken) {
    return res.status(400).json({ success: false, error: 'That eBay account is not connected.' });
  }

  try {
    await sendMessage(refreshToken, {
      conversationId: conversation.ebay_conversation_id,
      content: content.trim(),
    });
    res.json({ success: true });
  } catch (err) {
    console.error('notification-reply error:', err.message);
    res.status(err.statusCode || 500).json({ success: false, error: err.message || 'Could not send this message.' });
  }
});

/**
 * POST /api/notifications/:id/note
 * Adds an ELMS-only internal note that is never sent to eBay.
 */
router.post('/:id/note', requireAuth, async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ success: false, error: 'Note text is required.' });
  if (text.length > 2000) return res.status(400).json({ success: false, error: 'Note is too long.' });
  const updated = await addInternalNote(req.userId, req.params.id, text);
  if (!updated) return res.status(404).json({ success: false, error: 'Conversation not found.' });
  res.json({ success: true, conversation: updated });
});

/**
 * POST /api/notifications/:id/archive
 * Archives a conversation in ELMS and, when supported, on eBay.
 */
router.post('/:id/archive', requireAuth, async (req, res) => {
  const conversation = await getConversationById(req.userId, req.params.id);
  if (!conversation) return res.status(404).json({ success: false, error: 'Conversation not found.' });
  const refreshToken = await getEbayAccountRefreshToken(req.userId, conversation.ebay_account_id);
  if (refreshToken) {
    try { await updateConversationStatus(refreshToken, conversation.ebay_conversation_id, 'ARCHIVED', conversation.conversation_type); } catch (err) {
      return res.status(err.statusCode || 500).json({ success: false, error: err.message || 'Could not archive the eBay conversation.' });
    }
  }
  const updated = await updateConversationState(req.userId, req.params.id, { isRead: true, conversationStatus: 'ARCHIVED' });
  res.json({ success: true, conversation: updated });
});

/**
 * PUT /api/notifications/:id/read
 * Requires a valid session token.
 * Body: { isRead: boolean }
 *
 * Marks a conversation as read/unread locally (used e.g. for a "mark all
 * as read" action, without necessarily opening each one).
 */
router.put('/:id/read', requireAuth, async (req, res) => {
  const { isRead } = req.body;
  const updated = await updateConversationState(req.userId, req.params.id, { isRead: isRead !== false });
  if (!updated) {
    return res.status(404).json({ success: false, error: 'Conversation not found.' });
  }
  try {
    const conversation = await getConversationById(req.userId, req.params.id);
    const refreshToken = await getEbayAccountRefreshToken(req.userId, conversation.ebay_account_id);
    if (refreshToken) {
      await updateConversationStatus(refreshToken, conversation.ebay_conversation_id, isRead === false ? 'UNREAD' : 'READ', conversation.conversation_type);
    }
  } catch (err) {
    console.warn('Could not update eBay read state:', err.message);
  }
  res.json({ success: true, conversation: updated });
});

module.exports = router;
