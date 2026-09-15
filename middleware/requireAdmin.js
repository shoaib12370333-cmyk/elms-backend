const { getUserById } = require('../models/usersModel');

/**
 * Protects a route: requires the authenticated user (req.userId, set by
 * requireAuth) to have the "admin" role. Must be used AFTER requireAuth.
 */
async function requireAdmin(req, res, next) {
  try {
    const user = await getUserById(req.userId);
    if (!user || user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'This action requires admin access.' });
    }
    next();
  } catch (err) {
    res.status(500).json({ success: false, error: err.message || 'Could not verify admin access.' });
  }
}

module.exports = { requireAdmin };
