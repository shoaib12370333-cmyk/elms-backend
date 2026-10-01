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

// A seller's own custom wording (typed in Settings) can use these two placeholders - the only two values an
// automatic message actually has to offer, same {{double_brace}} syntax as the Messages page's own Saved Replies
// (applySnippetVariables in index.html) so it is a familiar convention, not a second syntax to learn.
function fillTemplate(template, { buyerName, itemTitle }) {
  return String(template)
    .replace(/\{\{\s*buyer_name\s*\}\}/gi, firstNameOf(buyerName))
    .replace(/\{\{\s*product_name\s*\}\}/gi, itemTitle || 'your item');
}

function orderedUpdateText({ buyerName, itemTitle, customTemplate }) {
  if (customTemplate) return fillTemplate(customTemplate, { buyerName, itemTitle });
  const item = itemTitle ? ` of ${itemTitle}` : '';
  return `Hi ${firstNameOf(buyerName)}, quick update on your order${item} - we've placed it with our supplier and it's on its way to us. As soon as it arrives, we'll ship it straight out to you with tracking. Thanks for your patience!`;
}

function shippedUpdateText({ buyerName, itemTitle, customTemplate }) {
  if (customTemplate) return fillTemplate(customTemplate, { buyerName, itemTitle });
  const item = itemTitle ? ` of ${itemTitle}` : '';
  return `Hi ${firstNameOf(buyerName)}, good news - your order${item} has shipped and is on its way to you! Thanks so much for shopping with us - reply here anytime if you need anything.`;
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

/**
 * Sends the automatic "we've ordered it, on its way to us" message - fires on "Mark as ordered". Same contract as
 * sendThankYouMessage above; customTemplate (the seller's own wording from Settings) is used instead of the built-in
 * default when given.
 * @returns {Promise<{status: 'sent'|'skipped'|'failed', message?: string}>}
 */
async function sendOrderedUpdateMessage(refreshToken, { buyerUsername, itemId, buyerName, itemTitle, customTemplate }) {
  if (!refreshToken) return { status: 'skipped', message: 'The eBay store is not connected.' };
  if (!buyerUsername) return { status: 'skipped', message: 'This order has no buyer username.' };
  try {
    await sendMessage(refreshToken, { recipientUsername: buyerUsername, itemId: itemId || undefined, content: orderedUpdateText({ buyerName, itemTitle, customTemplate }) });
    return { status: 'sent' };
  } catch (err) {
    return { status: 'failed', message: err.message };
  }
}

/**
 * Sends the automatic "it has shipped" message - fires on "Mark as shipped" (with or without a tracking number),
 * separate from sendShippedReviewMessage above (which specifically asks for a review). Same contract otherwise.
 * @returns {Promise<{status: 'sent'|'skipped'|'failed', message?: string}>}
 */
async function sendShippedUpdateMessage(refreshToken, { buyerUsername, itemId, buyerName, itemTitle, customTemplate }) {
  if (!refreshToken) return { status: 'skipped', message: 'The eBay store is not connected.' };
  if (!buyerUsername) return { status: 'skipped', message: 'This order has no buyer username.' };
  try {
    await sendMessage(refreshToken, { recipientUsername: buyerUsername, itemId: itemId || undefined, content: shippedUpdateText({ buyerName, itemTitle, customTemplate }) });
    return { status: 'sent' };
  } catch (err) {
    return { status: 'failed', message: err.message };
  }
}

module.exports = {
  sendThankYouMessage, sendShippedReviewMessage, sendOrderedUpdateMessage, sendShippedUpdateMessage,
  thankYouText, shippedReviewText, orderedUpdateText, shippedUpdateText, fillTemplate,
};
