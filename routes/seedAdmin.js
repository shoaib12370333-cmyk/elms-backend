const express = require('express');
const router = express.Router();
const User = require('../models/schemas/User');

/**
 * POST /api/seed-admin
 * Body: { email: string, seedKey: string }
 *
 * One-time utility route to promote a user to admin, protected by the
 * SEED_ADMIN_KEY env variable (not by session auth, since the very first
 * admin doesn't exist yet). The user must have already signed in with
 * Google at least once (so their account exists) before running this.
 *
 * SECURITY: remove this route (and the SEED_ADMIN_KEY env variable) once
 * you've created your first admin - it's not meant to stay in production.
 */
router.post('/', async (req, res) => {
  const { email, seedKey } = req.body;
  const expectedKey = process.env.SEED_ADMIN_KEY;

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
