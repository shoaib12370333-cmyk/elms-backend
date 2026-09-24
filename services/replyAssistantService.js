const Conversation = require('../models/schemas/Conversation');
const User = require('../models/schemas/User');
const Listing = require('../models/schemas/Listing');
const AiUsage = require('../models/schemas/AiUsage');
const { askClaude } = require('./aiService');
const { sendMessage } = require('./ebayMessageService');
const { getAiSettings } = require('../models/settingsModel');
const { hasCredits, spendCredit, refundCredit } = require('../models/usersModel');
const { ACTION_COSTS } = require('../config/actionCosts');
const { createSystemNotification } = require('../models/systemNotificationsModel');

// Messages about these are never answered automatically - a person should read them first.
const SENSITIVE = /refund|return|cancel|dispute|chargeback|damag|broken|defect|faulty|not received|never arrived|missing|wrong item|fraud|scam|lawyer|solicitor|police|report you|complain|paypal|money back|compensat|legal|sue\b|angry|unacceptable|terrible/i;

function clip(text, n) { return String(text || '').replace(/\s+/g, ' ').trim().slice(0, n); }

/** Writes a short, polite reply to the buyer's latest message. Never promises anything we do not know. */
async function writeReply({ messages, subject, storeName, listingTitle }) {
  const settings = await getAiSettings();
  const recent = messages.slice(-8).map((m) => `${m.isSelf ? 'Seller' : 'Buyer'}: ${clip(m.content, 700)}`).join('\n');
  const prompt = [
    'You write replies for an eBay seller answering a buyer message.',
    'Rules: 2 to 5 short sentences, friendly and professional, plain text, no emojis, no markdown, no subject line, no signature block beyond the seller name.',
    'Only use facts in the conversation. NEVER promise refunds, replacements, delivery dates, tracking numbers, discounts or anything you cannot see. If the buyer needs something you cannot know, say you will check and come back to them.',
    'Answer in the language the buyer used.',
    settings.aiCustomInstructions ? `Extra instructions from the store owner: ${settings.aiCustomInstructions}` : '',
    'Reply with ONLY the message text.',
    '',
    storeName ? `Seller name: ${storeName}` : '',
    listingTitle ? `Item they asked about: ${listingTitle}` : '',
    subject ? `Subject: ${subject}` : '',
    'Conversation (oldest first):',
    recent,
  ].filter(Boolean).join('\n');
  const out = await askClaude({ prompt, maxTokens: 350 });
  const text = out.text.replace(/^["'\s]+|["'\s]+$/g, '').trim();
  if (text.length < 5) throw Object.assign(new Error('The AI returned an empty reply.'), { statusCode: 502 });
  return { text, usage: out };
}

async function context(userId, conversation, account) {
  let listingTitle = null;
  const itemId = conversation.itemId || conversation.referenceId;
  if (itemId) {
    const l = await Listing.findOne({ userId, ebayListingId: String(itemId) }, { title: 1 }).lean();
    listingTitle = l?.title || null;
  }
  return { listingTitle, storeName: account?.displayName || account?.storeName || require('./accountLabel').publicUsername(account?.ebayUserId) || null };
}

/**
 * Called after a conversation was synced. If the seller turned AI replies on and the buyer wrote something
 * new since then, prepares a draft (or, in auto mode, sends a reply to a simple, low-risk message).
 * @param {object} p { userId, conversationId (mongo id), messages (normalized, oldest first), refreshToken, account }
 */
async function handleNewBuyerMessage({ userId, conversationId, messages, refreshToken, account }) {
  const last = messages[messages.length - 1];
  if (!last || last.isSelf || !last.messageId) return { skipped: 'no_buyer_message' };

  const [user, settings, conversation] = await Promise.all([
    User.findById(userId, { aiReplyMode: 1, aiReplyEnabledAt: 1 }).lean(),
    getAiSettings(),
    Conversation.findOne({ _id: conversationId, userId }).lean(),
  ]);
  if (!user || !conversation) return { skipped: 'missing' };
  if (!user.aiReplyMode || user.aiReplyMode === 'off') return { skipped: 'off' };
  if (!settings.aiReplyEnabled) return { skipped: 'disabled_by_admin' };
  if (conversation.conversationType !== 'FROM_MEMBERS' || conversation.conversationStatus !== 'ACTIVE') return { skipped: 'not_a_buyer_thread' };
  if (conversation.aiDraft?.forMessageId === String(last.messageId)) return { skipped: 'already_handled' };
  const sentAt = last.sentDate ? new Date(last.sentDate).getTime() : 0;
  const since = user.aiReplyEnabledAt ? new Date(user.aiReplyEnabledAt).getTime() : Date.now();
  if (!sentAt || sentAt < since) return { skipped: 'older_than_toggle' };

  const cost = Number(ACTION_COSTS.AI_REPLY || 0);
  if (!(await spendCredit(userId, cost))) {
    await Conversation.updateOne({ _id: conversationId }, { $set: { 'aiDraft.forMessageId': String(last.messageId), 'aiDraft.status': 'discarded', 'aiDraft.text': '', 'aiDraft.createdAt': new Date() } });
    await createSystemNotification(userId, { type: 'ai_reply_skipped', level: 'warning', ebayAccountId: conversation.ebayAccountId, title: 'AI reply skipped', message: 'A buyer wrote to you but you do not have enough credits for an AI reply draft (' + cost + ' credit). Buy credits or reply yourself.' }).catch(() => {});
    return { skipped: 'no_credits' };
  }

  try {
    const ctx = await context(userId, conversation, account);
    const reply = await writeReply({ messages, subject: conversation.subject, ...ctx });
    AiUsage.create({ userId, kind: 'reply', ok: true, credits: cost, model: reply.usage?.model, inputTokens: reply.usage?.inputTokens, outputTokens: reply.usage?.outputTokens }).catch(() => {});

    const risky = SENSITIVE.test(last.content || '') || SENSITIVE.test(conversation.subject || '');
    const auto = user.aiReplyMode === 'auto' && !risky && refreshToken;
    if (auto) {
      await sendMessage(refreshToken, { conversationId: conversation.ebayConversationId, content: reply.text });
      await Conversation.updateOne({ _id: conversationId }, { $set: { aiDraft: { text: reply.text, status: 'auto_sent', forMessageId: String(last.messageId), createdAt: new Date() }, lastMessageFromSelf: true } });
      return { sent: true };
    }
    await Conversation.updateOne({ _id: conversationId }, { $set: { aiDraft: { text: reply.text, status: 'ready', forMessageId: String(last.messageId), createdAt: new Date() } } });
    return { drafted: true, heldBack: user.aiReplyMode === 'auto' && risky };
  } catch (err) {
    await refundCredit(userId, cost);
    AiUsage.create({ userId, kind: 'reply', ok: false, credits: 0 }).catch(() => {});
    console.warn('[ai-reply] ' + err.message);
    return { error: err.message };
  }
}

/** Manual "Draft with AI" button in a conversation. Works even when auto-drafting is off. */
async function draftForConversation({ userId, conversationId, messages, account }) {
  const conversation = await Conversation.findOne({ _id: conversationId, userId }).lean();
  if (!conversation) throw Object.assign(new Error('Conversation not found.'), { statusCode: 404 });
  const settings = await getAiSettings();
  if (!settings.aiReplyEnabled) throw Object.assign(new Error('AI replies are turned off by the administrator.'), { statusCode: 403 });
  const cost = Number(ACTION_COSTS.AI_REPLY || 0);
  if (!(await hasCredits(userId, cost)) || !(await spendCredit(userId, cost))) throw Object.assign(new Error('You need ' + cost + ' credit for an AI reply. Buy credits to continue.'), { statusCode: 402 });
  try {
    const ctx = await context(userId, conversation, account);
    const reply = await writeReply({ messages, subject: conversation.subject, ...ctx });
    AiUsage.create({ userId, kind: 'reply', ok: true, credits: cost, model: reply.usage?.model, inputTokens: reply.usage?.inputTokens, outputTokens: reply.usage?.outputTokens }).catch(() => {});
    const last = messages[messages.length - 1];
    await Conversation.updateOne({ _id: conversationId }, { $set: { aiDraft: { text: reply.text, status: 'ready', forMessageId: String(last?.messageId || 'manual'), createdAt: new Date() } } });
    return { text: reply.text, creditsUsed: cost };
  } catch (err) {
    await refundCredit(userId, cost);
    AiUsage.create({ userId, kind: 'reply', ok: false, credits: 0 }).catch(() => {});
    throw err;
  }
}

module.exports = { handleNewBuyerMessage, draftForConversation, SENSITIVE };
