const { sendMessage } = require('./ebayMessageService');

/** eBay's own first name, or a neutral fallback when there is none saved on the order. */
function firstNameOf(fullName) {
  const n = String(fullName || '').trim();
  return n ? n.split(/\s+/)[0] : 'there';
}

// No phone numbers, emails or external links in either message: eBay's buyer-messaging policy prohibits off-eBay
// contact info, and an account-safety mistake here is exactly the kind of thing this feature should never cause.
function thankYouText({ buyerName, itemTitle }) {
  const item = itemTitle ? ` of ${itemTitle}` : '';
  return `Hi ${firstNameOf(buyerName)}, thank you for your order${item}! We're getting it ready and will let you know as soon as it ships. If you have any questions in the meantime, just reply here - we're happy to help.`;
}

function shippedReviewText({ buyerName, itemTitle }) {
  const item = itemTitle ? ` ${itemTitle}` : ' order';
  return `Hi ${firstNameOf(buyerName)}, good news - your${item} has shipped! We hope you love it. Once it arrives, if you have a minute, we'd really appreciate you leaving us a review here on eBay - it means a lot to us. And if anything isn't quite right, please message us first so we can fix it for you. Thanks so much for your order!`;
}

/**
 * Sends the automatic "thank you for your order" message via eBay's Message API. Best effort: never throws, always
 * resolves to a status the caller can persist.
 * @returns {Promise<{status: 'sent'|'skipped'|'failed', message?: string}>}
 */
async function sendThankYouMessage(refreshToken, { buyerUsername, itemId, buyerName, itemTitle }) {
  if (!refreshToken) return { status: 'skipped', message: 'The eBay store is not connected.' };
  if (!buyerUsername) return { status: 'skipped', message: 'This order has no buyer username.' };
  try {
    await sendMessage(refreshToken, { recipientUsername: buyerUsername, itemId: itemId || undefined, content: thankYouText({ buyerName, itemTitle }) });
    return { status: 'sent' };
  } catch (err) {
    return { status: 'failed', message: err.message };
  }
}

/**
 * Sends the automatic "it shipped, please leave a review" message via eBay's Message API. Same contract as
 * sendThankYouMessage above.
 * @returns {Promise<{status: 'sent'|'skipped'|'failed', message?: string}>}
 */
async function sendShippedReviewMessage(refreshToken, { buyerUsername, itemId, buyerName, itemTitle }) {
  if (!refreshToken) return { status: 'skipped', message: 'The eBay store is not connected.' };
  if (!buyerUsername) return { status: 'skipped', message: 'This order has no buyer username.' };
  try {
    await sendMessage(refreshToken, { recipientUsername: buyerUsername, itemId: itemId || undefined, content: shippedReviewText({ buyerName, itemTitle }) });
    return { status: 'sent' };
  } catch (err) {
    return { status: 'failed', message: err.message };
  }
}

module.exports = { sendThankYouMessage, sendShippedReviewMessage, thankYouText, shippedReviewText };
