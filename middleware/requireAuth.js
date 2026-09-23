const { verifySessionPayload } = require('../services/sessionService');
const { assertSessionActive, requestContext } = require('../services/sessionTracker');

/**
 * Protects a route: requires a valid "Authorization: Bearer <token>" header whose session has not been
 * ended (Security page: log out a device / log out everywhere).
 * On success, sets req.userId (and req.sid) so route handlers know who made the request.
 */
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  try {
    const payload = verifySessionPayload(token);
    await assertSessionActive(payload, requestContext(req));
    req.userId = payload.userId;
    req.sid = payload.sid;
    next();
  } catch (err) {
    res.status(err.statusCode || 401).json({ success: false, error: err.message, ...(err.blocked ? { blocked: err.blocked } : {}) });
  }
}

module.exports = { requireAuth };
