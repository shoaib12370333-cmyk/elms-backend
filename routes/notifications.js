const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/requireAuth');
const {
  listConversations,
  countUnreadConversations,
  getConversationById,
  getConversationForThread,
  markConversationRead,
  upsertConversation,
  addInternalNote,
  updateConversationState,
  trashConversation,
  restoreConversation,
} = require('../models/conversationsModel');
const { ensureBuyerProfile, PROFILE_TTL_MS } = require('../services/ebayBuyerProfileService');
const { saveMessageAttachment, sanitizeAttachments } = require('../services/messageAttachmentService');
const EbayAccount = require('../models/schemas/EbayAccount');
const { listMessages, upsertMessages } = require('../models/messagesModel');
const { getEbayAccountRefreshToken } = require('../models/ebayAccountsModel');
const { fetchConversationDetail, sendMessage, updateConversationStatus } = require('../services/ebayMessageService');
const Order = require('../models/schemas/Order');
const Listing = require('../models/schemas/Listing');
const { syncConversationsForUser } = require('../jobs/conversationSync');
const { startJob, getJob } = require('../services/backgroundJobs');

const syncJobKey = (userId, accountId) => `messages:${userId}:${accountId || 'all'}`;

/**
 * GET/PUT /api/notifications/ai-reply/settings
 * The Messages page toggle: mode is 'off', 'draft' (AI writes a draft for you to review) or 'auto'
 * (AI also sends replies to simple, low-risk messages). Only buyer messages received after switching on are handled.
 */
router.get('/ai-reply/settings', requireAuth, async (req, res) => {
  const User = require('../models/schemas/User');
  const { getAiSettings } = require('../models/settingsModel');
  const { ACTION_COSTS } = require('../config/actionCosts');
  const [user, ai] = await Promise.all([User.findById(req.userId, { aiReplyMode: 1 }).lean(), getAiSettings()]);
  res.json({ success: true, mode: user?.aiReplyMode || 'off', available: !!ai.aiReplyEnabled, cost: Number(ACTION_COSTS.AI_REPLY || 0) });
});

router.put('/ai-reply/settings', requireAuth, async (req, res) => {
  const User = require('../models/schemas/User');
  const mode = String(req.body?.mode || '');
  if (!['off', 'draft', 'auto'].includes(mode)) return res.status(400).json({ success: false, error: 'Mode must be off, draft or auto.' });
  const before = await User.findById(req.userId, { aiReplyMode: 1 }).lean();
  const update = { aiReplyMode: mode };
  // Only messages that arrive after switching on are answered, never the old inbox.
  if ((before?.aiReplyMode || 'off') === 'off' && mode !== 'off') update.aiReplyEnabledAt = new Date();
  await User.updateOne({ _id: req.userId }, { $set: update });
  res.json({ success: true, mode });
});

/**
 * POST /api/notifications/:id/ai-reply/generate  - "Draft with AI" for one conversation.
 * POST /api/notifications/:id/ai-reply/discard   - throw the stored draft away.
 */
router.post('/:id/ai-reply/generate', requireAuth, async (req, res) => {
  const { listMessages } = require('../models/messagesModel');
  const { draftForConversation } = require('../services/replyAssistantService');
  const conversation = await getConversationById(req.userId, req.params.id);
  if (!conversation) return res.status(404).json({ success: false, error: 'Conversation not found.' });
  try {
    const messages = await listMessages(req.userId, req.params.id);
    if (!messages.length) return res.status(400).json({ success: false, error: 'There is no message to answer yet. Press Sync first.' });
    const out = await draftForConversation({ userId: req.userId, conversationId: req.params.id, messages, account: null });
    res.json({ success: true, text: out.text, creditsUsed: out.creditsUsed });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: err.message || 'Could not write a draft.' });
  }
});

router.post('/:id/ai-reply/discard', requireAuth, async (req, res) => {
  const Conversation = require('../models/schemas/Conversation');
  await Conversation.updateOne({ _id: req.params.id, userId: req.userId, 'aiDraft.status': 'ready' }, { $set: { 'aiDraft.status': 'discarded' } });
  res.json({ success: true });
});

/**
 * GET /api/notifications/unread-count
 * Requires a valid session token.
 * Returns how many of the user's conversations (across all eBay accounts)
 * are unread - powers the notification bell's badge number.
 */
router.get('/unread-count', requireAuth, async (req, res) => {
  const count = await countUnreadConversations(req.userId, req.query.accountId || null);
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
    const conversations = await listConversations(req.userId, req.query.accountId, { status: req.query.status, type: req.query.type, search: req.query.search });
    res.json({ success: true, conversations });
  } catch (err) {
    console.error('notifications list error:', err.message);
    res.status(500).json({ success: false, error: 'Could not load messages.' });
  }
});

/**
 * POST /api/notifications/sync
 * Explicit refresh only. Normal page loads never call eBay directly.
 */
router.post('/sync', requireAuth, async (req, res) => {
  // ?background=1: start the sync and answer at once; the page asks GET /sync-status until it is done (and pressing Sync
  // again while it runs joins the running one).
  if (req.query.background === '1') {
    const accountId = req.query.accountId || null;
    const { started, job } = startJob(syncJobKey(req.userId, accountId), () => syncConversationsForUser(req.userId, accountId));
    return res.status(202).json({ success: true, started, job });
  }
  try {
    const result = await syncConversationsForUser(req.userId, req.query.accountId || null);
    const conversations = await listConversations(req.userId, req.query.accountId);
    res.json({ success: true, ...result, conversations });
  } catch (err) {
    console.error('notifications manual sync error:', err.message);
    res.status(err.statusCode || 500).json({ success: false, error: err.message || 'Could not sync eBay messages.' });
  }
});

/**
 * GET /api/notifications/sync-status?accountId=...
 * How the background sync of the messages is going: { status: 'running' | 'done' | 'error', error?, result? }, or job null
 * when none was started lately. Must stay above GET /:id.
 */
router.get('/sync-status', requireAuth, (req, res) => {
  res.json({ success: true, job: getJob(syncJobKey(req.userId, req.query.accountId || null)) });
});

/**
 * GET /api/notifications/:id
 * Requires a valid session token.
 * Returns the full message thread for one conversation, and marks it as
 * read (since the user is now viewing it).
 * With ?peek=1 it only returns the thread: the page uses that to load threads ahead of time, and a thread
 * nobody has opened must stay unread (here and on eBay).
 */
router.get('/:id', requireAuth, async (req, res) => {
  const loaded = await getConversationForThread(req.userId, req.params.id);
  if (!loaded) {
    return res.status(404).json({ success: false, error: 'Conversation not found.' });
  }
  const { conversation, storedBuyerProfile } = loaded;
  const peek = req.query.peek === '1';

  try {
    const referenceId = conversation.reference_id || conversation.item_id || null;
    // Everything the thread needs that does not depend on another lookup is read together, so opening a
    // conversation costs one round trip to the database instead of five in a row.
    const [cachedMessages, refreshToken, order, listingByItem] = await Promise.all([
      listMessages(req.userId, req.params.id),
      getEbayAccountRefreshToken(req.userId, conversation.ebay_account_id),
      referenceId ? Order.findOne({ userId: req.userId, $or: [{ ebayOrderId: referenceId }, { ebayLineItemId: referenceId }] }).populate('listingId', 'title mainImage ebayItemId').lean() : null,
      referenceId ? Listing.findOne({ userId: req.userId, ebayListingId: referenceId }).select('title mainImage ebayItemId').lean() : null,
    ]);

    let detail = { conversationId: conversation.ebay_conversation_id, messages: cachedMessages };
    const markRead = () => markConversationRead(req.userId, req.params.id, true).catch(() => {});
    // Also go live when our last message is still marked unread by the buyer, so the
    // read-receipt tick reflects what eBay says now, not what it said at the last sync.
    const lastCached = cachedMessages[cachedMessages.length - 1];
    const awaitingReceipt = !!lastCached && lastCached.isSelf && !lastCached.readStatus;
    const needsLive = (!cachedMessages.length || awaitingReceipt) && !!refreshToken;
    // From the local copy the read mark is written while the rest is prepared; after a live fetch it waits for it to succeed.
    let marked = needsLive || peek ? null : markRead();
    if (needsLive) {
      try {
        const live = await fetchConversationDetail(refreshToken, conversation.ebay_conversation_id, conversation.conversation_type);
        detail = live;
        await upsertMessages({ userId: req.userId, ebayAccountId: conversation.ebay_account_id, conversationDoc: { _id: req.params.id }, ebayConversationId: conversation.ebay_conversation_id, messages: live.messages || [] });
      } catch (liveErr) {
        if (!cachedMessages.length) throw liveErr;
      }
      if (!peek) marked = markRead();
    }

    // Buyer's feedback score / star / member-since is stored with the conversation (refreshed every 7 days).
    // Refreshing it calls eBay, so it runs in the background: this thread shows what is stored, the next open the new one.
    if (refreshToken && conversation.conversation_type === 'FROM_MEMBERS') {
      const fetchedAt = storedBuyerProfile?.fetchedAt ? new Date(storedBuyerProfile.fetchedAt).getTime() : 0;
      if (!fetchedAt || Date.now() - fetchedAt >= PROFILE_TTL_MS) {
        (async () => {
          const account = await EbayAccount.findById(conversation.ebay_account_id).select('marketplaceId').lean().catch(() => null);
          await ensureBuyerProfile({
            userId: req.userId, conversationId: req.params.id, refreshToken,
            username: conversation.other_party_username, marketplaceId: account?.marketplaceId || 'EBAY_US', existing: storedBuyerProfile,
          });
        })().catch(() => {});
      }
    }

    if (refreshToken && !peek) {
      updateConversationStatus(refreshToken, conversation.ebay_conversation_id, 'READ', conversation.conversation_type).catch(() => {});
    }
    await marked; // the unread badge the page reads next must already be correct

    const listing = order?.listingId || listingByItem;

    res.json({
      success: true,
      conversation,
      detail,
      context: order ? { type: 'order', order_id: order._id.toString(), ebay_order_id: order.ebayOrderId, ebay_item_id: order.legacyItemId || listing?.ebayItemId || null, buyer_username: order.buyerUsername, sale_price: order.salePrice, currency: order.currency || null, quantity: order.quantity, fulfillment_status: order.fulfillmentStatus, listing_id: listing?._id?.toString() || null, listing_title: listing?.title || null, main_image: listing?.mainImage || order.itemImage || null } : listing ? { type: 'listing', listing_id: listing._id.toString(), listing_title: listing.title, main_image: listing.mainImage || null, ebay_item_id: listing.ebayItemId || referenceId } : null,
    });
  } catch (err) {
    console.error('notification-detail error:', err.message);
    res.status(err.statusCode || 500).json({ success: false, error: err.message || 'Could not load this conversation.' });
  }
});

/**
 * POST /api/notifications/attachments
 * Body: { dataUrl: "data:image/...;base64,..." | "data:application/pdf;base64,...", name }
 * Hosts one image/PDF on ELMS's own storage so it can be attached to a reply (eBay only
 * accepts self-hosted HTTPS media URLs). Returns { attachment: { name, type, url } }.
 */
router.post('/attachments', requireAuth, async (req, res) => {
  try {
    const attachment = await saveMessageAttachment({ dataUrl: req.body?.dataUrl, name: req.body?.name, userId: req.userId, req });
    res.json({ success: true, attachment });
  } catch (err) {
    res.status(err.statusCode || 400).json({ success: false, error: err.message || 'Could not upload this file.' });
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
  const media = sanitizeAttachments(req.body?.attachments);
  if ((!content || !content.trim()) && !media.length) {
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
    const sent = await sendMessage(refreshToken, {
      conversationId: conversation.ebay_conversation_id,
      content: (content || '').trim() || 'Attachment',
      media,
    });
    try {
      const live = await fetchConversationDetail(refreshToken, conversation.ebay_conversation_id, conversation.conversation_type);
      await upsertMessages({ userId: req.userId, ebayAccountId: conversation.ebay_account_id, conversationDoc: { _id: req.params.id }, ebayConversationId: conversation.ebay_conversation_id, messages: live.messages || [] });
      const last = (live.messages || []).slice(-1)[0];
      if (last) await updateConversationState(req.userId, req.params.id, { isRead: true });
    } catch (_) {}
    try { await require('../models/schemas/Conversation').updateOne({ _id: req.params.id, userId: req.userId, 'aiDraft.status': 'ready' }, { $set: { 'aiDraft.status': 'sent' } }); } catch (_) {}
    res.json({ success: true, message: sent || null });
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
    try { await updateConversationStatus(refreshToken, conversation.ebay_conversation_id, 'ARCHIVE', conversation.conversation_type); } catch (err) {
      return res.status(err.statusCode || 500).json({ success: false, error: err.message || 'Could not archive the eBay conversation.' });
    }
  }
  const updated = await updateConversationState(req.userId, req.params.id, { isRead: true, conversationStatus: 'ARCHIVE' });
  res.json({ success: true, conversation: updated });
});

/** Move a conversation to the ELMS Trash. It remains recoverable for 30 days. */
router.post('/:id/trash', requireAuth, async (req, res) => {
  const conversation = await getConversationById(req.userId, req.params.id);
  if (!conversation) return res.status(404).json({ success: false, error: 'Conversation not found.' });
  const updated = await trashConversation(req.userId, req.params.id);
  const refreshToken = await getEbayAccountRefreshToken(req.userId, conversation.ebay_account_id);
  if (refreshToken) updateConversationStatus(refreshToken, conversation.ebay_conversation_id, 'DELETE', conversation.conversation_type).catch(() => {});
  res.json({ success: true, conversation: updated });
});

/** Restore a conversation from the ELMS Trash. */
router.post('/:id/restore', requireAuth, async (req, res) => {
  const updated = await restoreConversation(req.userId, req.params.id);
  if (!updated) return res.status(404).json({ success: false, error: 'Conversation not found.' });
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
