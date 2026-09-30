const Order = require('./../models/schemas/Order');
const User = require('./../models/schemas/User');
const { getEbayAccountRefreshToken } = require('../models/ebayAccountsModel');
const { sendThankYouMessage, sendShippedReviewMessage } = require('./buyerMessageService');

// A backlog sync (a store just connected, or a first-ever poll) can hand upsertOrder a line item that is already
// PAID with an old paidAt - that is not a live "just got paid" moment, so it must never trigger a thank-you message.
// Only a transition seen within this window of the real eBay paidAt counts as live.
const RECENT_PAID_MS = 48 * 60 * 60 * 1000;

async function recordResult(orderId, result, atField, errorField) {
  const set = result.status === 'sent' ? { [atField]: new Date(), [errorField]: null } : { [errorField]: result.message || result.status };
  await Order.updateOne({ _id: orderId }, { $set: set }).catch(() => {});
}

/**
 * Sends the one-time "thanks for your order" eBay buyer message the moment an order line is first seen as paid.
 * Never for a backfilled/old order (paidAt must be recent), never twice, and only when the seller switched the
 * setting on. Best effort: never throws - any failure is recorded on the order, not surfaced to the sync caller.
 */
async function maybeSendThankYouMessage({ userId, orderId, ebayAccountId, buyerUsername, itemId, itemTitle, buyerFullName, justPaid, paidAt, alreadySent }) {
  if (!justPaid || alreadySent) return;
  const paidAtMs = paidAt ? new Date(paidAt).getTime() : 0;
  if (!paidAtMs || Date.now() - paidAtMs > RECENT_PAID_MS) return;
  try {
    const user = await User.findById(userId).select('autoThankYouMessage').lean();
    if (!user || !user.autoThankYouMessage) return;
    const refreshToken = ebayAccountId ? await getEbayAccountRefreshToken(userId, ebayAccountId) : null;
    const result = await sendThankYouMessage(refreshToken, { buyerUsername, itemId, buyerName: buyerFullName, itemTitle });
    await recordResult(orderId, result, 'thankYouMessageAt', 'thankYouMessageError');
  } catch (err) {
    console.warn('[auto-message] thank-you failed:', err.message);
    await Order.updateOne({ _id: orderId }, { $set: { thankYouMessageError: err.message } }).catch(() => {});
  }
}

/**
 * Sends the one-time "it shipped, please leave a review" eBay buyer message the first time tracking is saved for an
 * order line - any carrier (not tied to 17TRACK's own delivery confirmation), never twice, only when the seller
 * switched the setting on. Best effort: never throws.
 */
async function maybeSendReviewRequestMessage({ userId, orderId, ebayAccountId, buyerUsername, itemId, itemTitle, buyerFullName, justShipped, alreadySent }) {
  if (!justShipped || alreadySent) return;
  try {
    const user = await User.findById(userId).select('autoReviewRequestMessage').lean();
    if (!user || !user.autoReviewRequestMessage) return;
    const refreshToken = ebayAccountId ? await getEbayAccountRefreshToken(userId, ebayAccountId) : null;
    const result = await sendShippedReviewMessage(refreshToken, { buyerUsername, itemId, buyerName: buyerFullName, itemTitle });
    await recordResult(orderId, result, 'reviewMessageAt', 'reviewMessageError');
  } catch (err) {
    console.warn('[auto-message] review-request failed:', err.message);
    await Order.updateOne({ _id: orderId }, { $set: { reviewMessageError: err.message } }).catch(() => {});
  }
}

module.exports = { maybeSendThankYouMessage, maybeSendReviewRequestMessage };
