const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const User = require('../models/schemas/User');

const seedAdminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many attempts. Please try again in 15 minutes.' },
});

/**
 * POST /api/seed-admin
 * Body: { email: string, seedKey: string }
 *
 * One-time utility route to promote a user to admin, protected by the
 * SEED_ADMIN_KEY env variable (not by session auth, since the very first
 * admin doesn't exist yet). The user must have already signed in with
 * Google at least once (so their account exists) before running this.
 *
 * SECURITY: this route automatically refuses to run once at least one
 * admin already exists in the database - so even if SEED_ADMIN_KEY were to
 * leak after your first admin is created, it can no longer be used to
 * mint additional admins. You can still remove this route/env variable
 * entirely for extra safety, but it's no longer a live risk once you have
 * your first admin.
 */
router.post('/', seedAdminLimiter, async (req, res) => {
  const { email, seedKey } = req.body;
  const expectedKey = process.env.SEED_ADMIN_KEY;

  const existingAdminCount = await User.countDocuments({ role: 'admin' });
  if (existingAdminCount > 0) {
    return res.status(403).json({
      success: false,
      error: 'An admin account already exists. This one-time setup route is now disabled for security. Use the Admin Panel to manage user roles instead.',
    });
  }

  if (!expectedKey) {
    return res.status(500).json({ success: false, error: 'SEED_ADMIN_KEY is not set in the .env file.' });
  }
  if (!seedKey || seedKey !== expectedKey) {
    return res.status(403).json({ success: false, error: 'Invalid seed key.' });
  }
  if (!email) {
    return res.status(400).json({ success: false, error: 'An email is required.' });
  }

  const user = await User.findOneAndUpdate(
    { email },
    { role: 'admin', creditBalance: 999999 },
    { new: true }
  );

  if (!user) {
    return res.status(404).json({
      success: false,
      error: 'No user found with that email. Please sign in with Google at least once first.',
    });
  }

  res.json({ success: true, message: `${email} is now an admin.` });
});

module.exports = router;
