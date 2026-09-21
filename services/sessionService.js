const jwt = require('jsonwebtoken');

// 7 days balances security (a stolen token from localStorage/XSS has a
// shorter window of use) against UX (users aren't forced to re-login too
// often). Previously 30 days, which was an unnecessarily long exposure window.
const TOKEN_EXPIRY = '7d';

/**
 * Issues a session token for a logged-in user. The frontend stores this
 * and sends it back on every request (as an Authorization header).
 */
function issueSessionToken(userId, sid = null) {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET is not set in the .env file.');
  }
  return jwt.sign(sid ? { userId, sid } : { userId }, secret, { expiresIn: TOKEN_EXPIRY });
}

/**
 * Verifies a session token and returns the userId it belongs to.
 * Throws if the token is missing, expired, or invalid.
 */
function issueEbayConnectState(userId, marketplaceId = 'EBAY_US') {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not set in the .env file.');
  return jwt.sign(
    { userId, purpose: 'ebay-connect', marketplaceId: String(marketplaceId || 'EBAY_US') },
    secret,
    { expiresIn: '15m' }
  );
}

function verifyEbayConnectState(token) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not set in the .env file.');
  if (!token) {
    const err = new Error('No eBay connection state was provided.');
    err.statusCode = 401;
    throw err;
  }
  try {
    const payload = jwt.verify(token, secret);
    if (payload.purpose !== 'ebay-connect' || !payload.userId) throw new Error('Invalid state');
    return { userId: payload.userId, marketplaceId: payload.marketplaceId || 'EBAY_US' };
  } catch (err) {
    const wrapped = new Error('eBay connection session is invalid or expired. Please start the connection again.');
    wrapped.statusCode = 401;
    throw wrapped;
  }
}

function verifySessionToken(token) {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET is not set in the .env file.');
  }
  if (!token) {
    const err = new Error('No session token was provided.');
    err.statusCode = 401;
    throw err;
  }

  try {
    const payload = jwt.verify(token, secret);
    return payload.userId;
  } catch (err) {
    const wrapped = new Error('Session token is invalid or expired. Please sign in again.');
    wrapped.statusCode = 401;
    throw wrapped;
  }
}

/** Like verifySessionToken but also returns the session id and issue time (used to honour logouts). */
function verifySessionPayload(token) {
  verifySessionToken(token); // throws the friendly 401 errors
  const payload = jwt.verify(token, process.env.JWT_SECRET);
  return { userId: payload.userId, sid: payload.sid || null, iat: payload.iat || 0 };
}

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

module.exports = { SESSION_TTL_MS, verifySessionPayload, issueSessionToken, verifySessionToken, issueEbayConnectState, verifyEbayConnectState };
