const express = require('express');
const router = express.Router();
const { verifyGoogleToken } = require('../services/googleAuthService');
const {
  findOrCreateUser,
  registerWithPassword,
  loginWithPassword,
  getUserById,
} = require('../models/usersModel');
const { issueSessionToken } = require('../services/sessionService');
const { requireAuth } = require('../middleware/requireAuth');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * POST /api/auth/google
 * Body: { credential: string }  <- the ID token from Google Sign-In on the frontend
 *
 * Verifies the Google token, creates or finds the matching user, and
 * returns a session token the frontend should store and send on future requests.
 */
router.post('/google', async (req, res) => {
  const { credential } = req.body;

  if (!credential) {
    return res.status(400).json({ success: false, error: 'A Google credential is required.' });
  }

  try {
    const profile = await verifyGoogleToken(credential);
    const user = await findOrCreateUser(profile);
    const sessionToken = issueSessionToken(user.id);

    res.json({ success: true, sessionToken, user });
  } catch (err) {
    console.error('google auth error:', err.message);
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/auth/register
 * Body: { username: string, email: string, password: string }
 *
 * Creates a new account with a username/email/password. If an account with
 * this email already exists (e.g. from a prior Google sign-in), the
 * password is attached to that same account instead of creating a
 * duplicate - so credits/drafts/history carry over either way.
 */
router.post('/register', async (req, res) => {
  const { username, email, password } = req.body;

  if (!username || !email || !password) {
    return res.status(400).json({ success: false, error: 'A username, email, and password are all required.' });
  }
  if (!EMAIL_REGEX.test(email)) {
    return res.status(400).json({ success: false, error: 'Please enter a valid email address.' });
  }
  if (username.trim().length < 3) {
    return res.status(400).json({ success: false, error: 'Username must be at least 3 characters.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ success: false, error: 'Password must be at least 8 characters.' });
  }

  try {
    const user = await registerWithPassword({ username: username.trim(), email: email.trim().toLowerCase(), password });
    const sessionToken = issueSessionToken(user.id);
    res.json({ success: true, sessionToken, user });
  } catch (err) {
    console.error('register error:', err.message);
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/auth/login
 * Body: { email: string, password: string }
 *
 * Logs in with email/password. Works for any account that has a password
 * set, whether it was originally created via registration or later linked
 * to an existing Google account.
 */
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ success: false, error: 'An email and password are required.' });
  }

  try {
    const user = await loginWithPassword({ email: email.trim().toLowerCase(), password });
    const sessionToken = issueSessionToken(user.id);
    res.json({ success: true, sessionToken, user });
  } catch (err) {
    console.error('login error:', err.message);
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/auth/admin-login
 * Body: { email: string, password: string }
 *
 * Same credential check as /login, but ALSO verifies server-side that the
 * account has the "admin" role - used by the dedicated admin.html login
 * page, so a non-admin account is rejected by the backend itself (not just
 * hidden by the frontend), even if someone calls this endpoint directly.
 */
router.post('/admin-login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ success: false, error: 'An email and password are required.' });
  }

  try {
    const user = await loginWithPassword({ email: email.trim().toLowerCase(), password });

    if (user.role !== 'admin') {
      // Deliberately vague - don't reveal that the credentials were
      // otherwise correct, to avoid confirming which emails have accounts.
      return res.status(403).json({ success: false, error: 'This account does not have admin access.' });
    }

    const sessionToken = issueSessionToken(user.id);
    res.json({ success: true, sessionToken, user });
  } catch (err) {
    console.error('admin-login error:', err.message);
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/auth/me
 * Requires a valid session token. Returns the current user's profile,
 * including whether they've connected an eBay account.
 */
router.get('/me', requireAuth, async (req, res) => {
  const user = await getUserById(req.userId);
  if (!user) {
    return res.status(404).json({ success: false, error: 'User not found.' });
  }
  res.json({ success: true, user });
});

module.exports = router;
