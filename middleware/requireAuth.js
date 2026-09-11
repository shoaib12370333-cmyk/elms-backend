const { verifySessionToken } = require('../services/sessionService');

/**
 * Protects a route: requires a valid "Authorization: Bearer <token>" header.
 * On success, sets req.userId so route handlers know which user made the request.
 */
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  try {
    req.userId = verifySessionToken(token);
    next();
  } catch (err) {
    res.status(err.statusCode || 401).json({ success: false, error: err.message });
  }
}

module.exports = { requireAuth };
