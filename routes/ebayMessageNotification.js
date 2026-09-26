const express = require('express');
const crypto = require('crypto');
const { messageToText } = require('../services/messageTextService');
const router = express.Router();
const { verifyEbaySignature } = require('../services/ebayNotificationVerifyService');
const EbayAccount = require('../models/schemas/EbayAccount');
const { upsertConversation } = require('../models/conversationsModel');
const { upsertMessages } = require('../models/messagesModel');

/**
 * eBay checks an endpoint before it creates a destination for it: it sends a challenge_code once, and the answer is
 * SHA-256(challengeCode + verificationToken + this exact endpoint URL), as lower-case hex (same scheme as the account deletion and
 * order notification endpoints). Without this answer the NEW_MESSAGE destination cannot be created at all.
 *   EBAY_MESSAGE_NOTIFICATION_VERIFICATION_TOKEN  the token typed into eBay's Developer Portal for this destination
 *   EBAY_MESSAGE_NOTIFICATION_ENDPOINT_URL        the public address of this endpoint, exactly as entered there
 */
router.get('/', (req, res) => {
  const challengeCode = String(req.query.challenge_code || '');
  const verificationToken = process.env.EBAY_MESSAGE_NOTIFICATION_VERIFICATION_TOKEN;
  const endpointUrl = process.env.EBAY_MESSAGE_NOTIFICATION_ENDPOINT_URL || '';
  if (!challengeCode || !verificationToken || !endpointUrl) {
    return res.status(500).json({ error: 'Missing challenge_code, EBAY_MESSAGE_NOTIFICATION_VERIFICATION_TOKEN, or EBAY_MESSAGE_NOTIFICATION_ENDPOINT_URL.' });
  }
  const hash = crypto.createHash('sha256').update(challengeCode).update(verificationToken).update(endpointUrl).digest('hex');
  res.setHeader('Content-Type', 'application/json');
  res.status(200).json({ challengeResponse: hash });
});

/** eBay Commerce Notification API NEW_MESSAGE webhook. */
router.post('/', async (req, res) => {
  const valid = await verifyEbaySignature(req.body, req.headers['x-ebay-signature']).catch((err) => {
    console.error('[ebay-message-notification] Signature verification error:', err.message);
    return false;
  });
  if (!valid) return res.status(412).json({ success: false, error: 'Invalid signature.' });

  let payload;
  try { payload = JSON.parse(req.body.toString('utf8')); }
  catch (_) { return res.status(400).json({ success: false, error: 'Invalid JSON.' }); }

  // Acknowledge immediately; process after the response so eBay does not retry a slow handler.
  res.status(200).json({ received: true });

  try {
    const notification = payload?.notification || payload;
    const data = notification?.data || {};
    if (notification?.topic !== 'NEW_MESSAGE' && payload?.topic !== 'NEW_MESSAGE') return;

    const recipient = data.recipientUserName || data.recipientUsername || null;
    const account = recipient ? await EbayAccount.findOne({ ebayUserId: recipient }) : null;
    if (!account) {
      console.warn('[ebay-message-notification] No connected ELMS account matched recipient:', recipient || '(missing)');
      return;
    }

    const saved = await upsertConversation(account.userId.toString(), account._id.toString(), {
      conversationId: data.conversationId,
      subject: data.subject || null,
      fromUsername: data.senderUserName || data.senderUsername || 'eBay',
      conversationType: data.conversationType || 'FROM_MEMBERS',
      conversationStatus: 'ACTIVE',
      otherPartyUsername: data.senderUserName || data.senderUsername || 'eBay',
      referenceId: data.referenceId || null,
      referenceType: data.referenceType || null,
      lastMessageSnippet: messageToText(data.messageBody || ''),
      lastMessageDate: data.createdDate || notification.eventDate || new Date().toISOString(),
      itemId: data.referenceType === 'LISTING' ? data.referenceId : null,
      isRead: typeof data.readStatus === 'boolean' ? data.readStatus : false,
    });
    if (data.messageId && saved?.id) {
      await upsertMessages({
        userId: account.userId.toString(),
        ebayAccountId: account._id.toString(),
        conversationDoc: { _id: saved.id },
        ebayConversationId: data.conversationId,
        messages: [{ messageId: data.messageId, content: messageToText(data.messageBody || ''), fromUsername: data.senderUserName || data.senderUsername || 'eBay', isSelf: false, readStatus: false, sentDate: data.createdDate || notification.eventDate || new Date().toISOString() }],
      });
    }
  } catch (err) {
    console.error('[ebay-message-notification] Processing error:', err.message);
  }
});

module.exports = router;
