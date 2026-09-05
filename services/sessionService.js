const jwt = require('jsonwebtoken');

const TOKEN_EXPIRY = '30d'; // how long a user stays logged in

/**
 * Issues a session token for a logged-in user. The frontend stores this
 * and sends it back on every request (as an Authorization header).
 */
function issueSessionToken(userId) {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET is not set in the .env file.');
  }
  return jwt.sign({ userId }, secret, { expiresIn: TOKEN_EXPIRY });
}

/**
 * Verifies a session token and returns the userId it belongs to.
 * Throws if the token is missing, expired, or invalid.
 */
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

module.exports = { issueSessionToken, verifySessionToken };
