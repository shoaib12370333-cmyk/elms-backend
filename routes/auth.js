const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { verifyGoogleToken } = require('../services/googleAuthService');
const {
  findOrCreateUser,
  registerWithPassword,
  loginWithPassword,
  getUserById,
  setOrderSyncSettings,
  getOrCreateExtensionKey,
  regenerateExtensionKey,
  getUserByExtensionKey,
} = require('../models/usersModel');
const { issueSessionToken } = require('../services/sessionService');
const { requireAuth } = require('../middleware/requireAuth');
const { getSettings } = require('../models/settingsModel');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Limits repeated login/register attempts from the same IP, to slow down
// brute-force password guessing and credential-stuffing attempts. This is
// intentionally stricter for admin-login since it's a higher-value target.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many login attempts. Please try again in 15 minutes.' },
});
const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many login attempts. Please try again in 15 minutes.' },
});
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many accounts created from this network. Please try again later.' },
});
const extensionKeyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many extension-key attempts. Please try again later.' },
});

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
router.post('/register', registerLimiter, async (req, res) => {
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
router.post('/login', loginLimiter, async (req, res) => {
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
router.post('/admin-login', adminLoginLimiter, async (req, res) => {
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

/**
 * PUT /api/auth/order-sync-settings
 * Requires a valid session token.
 * Body: { orderSyncMode: 'realtime'|'polling', orderSyncIntervalMinutes: number }
 *
 * Lets a user choose how their orders get synced from eBay - see
 * jobs/orderSync.js for how these settings are applied, and
 * config/actionCosts.js for the daily credit cost of each mode.
 */


/**
 * GET /api/auth/extension-key
 * Returns the persistent key used by the ELMS browser extension.
 */
/**
 * GET /api/auth/extension-settings
 * Public settings used by the browser extension before an ELMS account has
 * been connected. No authentication is required.
 */
router.get('/extension-settings', async (req, res) => {
  const settings = await getSettings();
  res.json({ success: true, registrationUrl: settings.extensionRegistrationUrl || null });
});

router.get('/extension-key', requireAuth, async (req, res) => {
  const extensionKey = await getOrCreateExtensionKey(req.userId);
  if (!extensionKey) return res.status(404).json({ success: false, error: 'User not found.' });
  res.json({ success: true, extensionKey });
});

/**
 * POST /api/auth/extension-key/regenerate
 * Replaces the current extension key. The previous key stops working immediately.
 */
router.post('/extension-key/regenerate', requireAuth, async (req, res) => {
  const extensionKey = await regenerateExtensionKey(req.userId);
  if (!extensionKey) return res.status(404).json({ success: false, error: 'User not found.' });
  res.json({ success: true, extensionKey });
});

/**
 * POST /api/auth/extension-key/exchange
 * Exchanges a user's extension key for a normal short-lived ELMS session token.
 * The key itself is never accepted by normal authenticated endpoints.
 */
router.post('/extension-key/exchange', extensionKeyLimiter, async (req, res) => {
  const { extensionKey } = req.body || {};
  if (!extensionKey) return res.status(400).json({ success: false, error: 'Extension key is required.' });

  const user = await getUserByExtensionKey(extensionKey);
  if (!user) return res.status(401).json({ success: false, error: 'Extension key is invalid. Generate a new key from ELMS Settings.' });

  const sessionToken = issueSessionToken(user._id.toString());
  res.json({ success: true, sessionToken });
});

router.put('/order-sync-settings', requireAuth, async (req, res) => {
  const { orderSyncMode, orderSyncIntervalMinutes } = req.body;

  if (orderSyncMode !== undefined && !['realtime', 'polling'].includes(orderSyncMode)) {
    return res.status(400).json({ success: false, error: 'orderSyncMode must be "realtime" or "polling".' });
  }
  if (orderSyncIntervalMinutes !== undefined && (!Number.isFinite(Number(orderSyncIntervalMinutes)) || Number(orderSyncIntervalMinutes) < 1)) {
    return res.status(400).json({ success: false, error: 'orderSyncIntervalMinutes must be a positive number.' });
  }

  const user = await setOrderSyncSettings(req.userId, {
    orderSyncMode,
    orderSyncIntervalMinutes: orderSyncIntervalMinutes !== undefined ? Number(orderSyncIntervalMinutes) : undefined,
  });

  if (!user) {
    return res.status(404).json({ success: false, error: 'User not found.' });
  }

  res.json({ success: true, user });
});

module.exports = router;
