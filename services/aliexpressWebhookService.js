const crypto = require('crypto');

/**
 * AliExpress's order-status push notifications (AppConsole -> "Message Subscription and Callback URL"), from the message-
 * push documentation pasted for this feature. This is a DIFFERENT callback from the OAuth one (routes/aliexpressConnect.js):
 * this one is AliExpress calling ELMS, unauthenticated by a session, secured only by the signature below.
 *
 * message_type -> what it means, straight from the docs' own table (used only for readable logging right now).
 */
const MESSAGE_TYPES = {
  0: 'TEST AE PUSH', 1: 'order successfully', 2: 'risk control 24h', 3: "waiting for seller's verification",
  4: 'waiting for group', 5: 'order enters the cancellation process', 6: 'waiting for shipping', 8: 'seller partially ships',
  10: 'waiting for buyer to receive goods', 12: 'transaction successful', 15: 'product delete',
  18: 'waybill number change', 20: 'reverse status', 22: 'video dump message', 25: 'reverse status changing',
  31: 'QD refund successfully', 32: 'QD responsible payment', 34: 'QD payment fail', 35: 'QD order-closing',
  36: 'QD refusal to pay', 37: 'QD refund', 38: 'QD order stop', 39: 'QD order unfrozen', 40: 'video audit message',
  41: 'payment successfully', 42: 'AE-JIT Purchase order cancel message',
};

/**
 * Authorization = HEX_ENCODE(HMAC-SHA256(AppKey + messageBody, AppSecret)) - straight from the docs' own Java sample
 * (SignatureUtil.getSignature), lowercase hex (Node's default .digest('hex')), unlike the UPPERCASE hex the IOP API-call
 * signature (services/aliexpressAuthService.js sign()) uses - these are two different, unrelated signature schemes.
 * The docs call this "not mandatory, but highly recommended": a message with no Authorization header at all is still
 * accepted (AliExpress's own test push may not send one), but a header that IS present and does not verify is rejected.
 */
function verifySignature(rawBody, authorizationHeader) {
  if (!authorizationHeader) return true;
  const key = process.env.ALIEXPRESS_APP_KEY;
  const secret = process.env.ALIEXPRESS_APP_SECRET;
  if (!key || !secret) return true; // nothing configured to check against - never block receipt over our own missing config
  const expected = crypto.createHmac('sha256', secret).update(key + rawBody, 'utf8').digest('hex');
  const given = String(authorizationHeader).trim().toLowerCase();
  if (given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

function describeMessage(payload) {
  const type = payload && payload.message_type;
  const label = MESSAGE_TYPES[type] || `unknown type ${type}`;
  return `seller ${payload && payload.seller_id || '?'}: ${label} (message_type=${type})`;
}

module.exports = { MESSAGE_TYPES, verifySignature, describeMessage };
