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
const { startSession, recordFailedLogin, requestContext } = require('../services/sessionTracker');
const { requireAuth } = require('../middleware/requireAuth');
const { getSettings } = require('../models/settingsModel');
const PasswordResetOtp = require('../models/schemas/PasswordResetOtp');
const { sendPasswordResetOtp, sendPasswordChangedEmail, sendPasswordResetRequestedEmail, sendNewLoginEmail } = require('../services/emailService');
const crypto = require('crypto');
const { hashPassword } = require('../services/passwordService');
const accessGuard = require('../services/accessGuard');
const UserModel = require('../models/schemas/User');

// A blocked address / suspended account comes back as 403 with `blocked: { kind, reason }` so the site can show the blocked screen and the appeal form.
function sendAuthError(res, err) {
  res.status(err.statusCode || 500).json({ success: false, error: err.message, ...(err.blocked ? { blocked: err.blocked } : {}) });
}

// New accounts cannot be created from a blocked address or browser (nobody new can be one of the accounts the admin let through).
const { welcomeBonusDecision } = require('../services/signupBonusGuard');
const referralService = require('../services/referralService');

/**
 * A new account came with a referral code (?ref= in the link, or typed on the sign-up form): record it. A bad code never stops
 * the sign-up - the answer says what happened so the site can tell the person. Returns null when no code was given.
 */
async function tryAttachReferral(req, user, code) {
  if (!code || !String(code).trim()) return null;
  try {
    return await referralService.attachReferral({ user, code, ip: requestContext(req).ip });
  } catch (err) {
    console.error('referral attach error:', err.message);
    return { applied: false, reason: 'error' };
  }
}

async function assertNewAccountAllowed(req) {
  const denied = await accessGuard.checkNewAccount(requestContext(req));
  if (denied) throw accessGuard.blockedError(denied);
}

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

const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many password-reset requests. Please try again later.' },
});
const verifyResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many verification attempts. Please try again later.' },
});

function resetCodeHash(email, code) {
  return crypto.createHmac('sha256', process.env.JWT_SECRET).update(`${email}:${code}`).digest('hex');
}

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
  const { credential, referralCode, affiliateCode } = req.body;

  if (!credential) {
    return res.status(400).json({ success: false, error: 'A Google credential is required.' });
  }

  try {
    const profile = await verifyGoogleToken(credential);
    const isNewAccount = !(await UserModel.exists({ email: String(profile.email || '').toLowerCase() }));
    if (isNewAccount) await assertNewAccountAllowed(req);
    const bonus = isNewAccount ? await welcomeBonusDecision(profile.email, requestContext(req)) : { allowed: true };
    if (!bonus.allowed) console.warn('[signup-bonus] not given to ' + profile.email + ': ' + bonus.reason);
    const user = await findOrCreateUser(profile, { welcomeBonus: bonus.allowed });
    const referral = isNewAccount ? await tryAttachReferral(req, user, referralCode) : null;
    if (isNewAccount && affiliateCode) await require('../services/affiliateService').attachAtSignup(user, affiliateCode);
    const sessionToken = issueSessionToken(user.id, await startSession(req, user.id, 'google'));

    res.json({ success: true, sessionToken, user, ...(referral ? { referral } : {}) });
  } catch (err) {
    console.error('google auth error:', err.message);
    sendAuthError(res, err);
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
  const { username, email, password, referralCode, affiliateCode } = req.body;

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
    await assertNewAccountAllowed(req);
    const bonus = await welcomeBonusDecision(email.trim().toLowerCase(), requestContext(req));
    if (!bonus.allowed) console.warn('[signup-bonus] not given to ' + email.trim().toLowerCase() + ': ' + bonus.reason);
    const existedBefore = await UserModel.exists({ email: email.trim().toLowerCase() }); // a Google account adding a password is not a new account
    const user = await registerWithPassword({ username: username.trim(), email: email.trim().toLowerCase(), password }, { welcomeBonus: bonus.allowed });
    const referral = existedBefore ? null : await tryAttachReferral(req, user, referralCode);
    if (!existedBefore && affiliateCode) await require('../services/affiliateService').attachAtSignup(user, affiliateCode);
    const sessionToken = issueSessionToken(user.id, await startSession(req, user.id, 'register'));
    res.json({ success: true, sessionToken, user, ...(referral ? { referral } : {}) });
  } catch (err) {
    console.error('register error:', err.message);
    sendAuthError(res, err);
  }
});


/**
 * POST /api/auth/forgot-password/request
 * Always returns the same public response so the endpoint cannot be used to
 * discover whether an email address has an ELMS account.
 */
router.post('/forgot-password/request', forgotPasswordLimiter, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const generic = { success: true, message: 'If an account exists for that email, a verification code has been sent.' };
  if (!EMAIL_REGEX.test(email)) return res.status(200).json(generic);

  try {
    const user = await require('../models/schemas/User').findOne({ email });
    if (!user) return res.status(200).json(generic);

    await PasswordResetOtp.deleteMany({ email });
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const codeHash = resetCodeHash(email, code);
    const record = await PasswordResetOtp.create({ email, codeHash, expiresAt: new Date(Date.now() + 10 * 60 * 1000) });

    try {
      await sendPasswordResetOtp({ to: email, code });
      // Send the general reset-request notice separately. Failure here does not
      // invalidate the OTP because the OTP email was already accepted.
      sendPasswordResetRequestedEmail({ to: email }).catch((mailErr) => {
        console.error('password reset request notice failed:', mailErr.message);
      });
    } catch (mailErr) {
      await PasswordResetOtp.deleteOne({ _id: record._id }).catch(() => {});
      console.error('forgot-password email send failed:', mailErr.message);
      return res.status(503).json({
        success: false,
        error: 'We could not send the verification email right now. Please try again later.'
      });
    }

    return res.status(200).json(generic);
  } catch (err) {
    console.error('forgot-password request error:', err.message);
    return res.status(500).json({ success: false, error: 'Could not process the password reset request right now. Please try again.' });
  }
});

/**
 * POST /api/auth/forgot-password/reset
 * Body: { email, code, newPassword }
 */
router.post('/forgot-password/reset', verifyResetLimiter, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const code = String(req.body?.code || '').trim();
  const newPassword = String(req.body?.newPassword || '');
  if (!EMAIL_REGEX.test(email) || !/^\d{6}$/.test(code) || newPassword.length < 8) {
    return res.status(400).json({ success: false, error: 'Enter a valid email, 6-digit code, and password of at least 8 characters.' });
  }

  try {
    const record = await PasswordResetOtp.findOne({ email, usedAt: null }).sort({ createdAt: -1 });
    if (!record || record.expiresAt <= new Date()) {
      return res.status(400).json({ success: false, error: 'That code is invalid or expired. Please request a new code.' });
    }
    if (record.attempts >= 5) {
      return res.status(429).json({ success: false, error: 'Too many incorrect codes. Please request a new code.' });
    }
    if (record.codeHash !== resetCodeHash(email, code)) {
      record.attempts += 1;
      await record.save();
      return res.status(400).json({ success: false, error: 'That code is incorrect.' });
    }

    const user = await require('../models/schemas/User').findOne({ email });
    if (!user) return res.status(400).json({ success: false, error: 'Password reset is not available for this account.' });
    user.passwordHash = await hashPassword(newPassword);
    await user.save();
    record.usedAt = new Date();
    await record.save();
    await PasswordResetOtp.deleteMany({ email });

    // The reset email itself is the verification step; notify the user after
    // the password is actually changed. This also enables Google-only users
    // to create their first email/password login via Forgot Password.
    sendPasswordChangedEmail({ to: email }).catch((mailErr) => {
      console.error('password changed security email failed:', mailErr.message);
    });

    return res.json({ success: true, message: 'Password reset successfully. You can now log in.' });
  } catch (err) {
    console.error('forgot-password reset error:', err.message);
    return res.status(500).json({ success: false, error: 'Could not reset your password right now. Please try again.' });
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
    const sessionToken = issueSessionToken(user.id, await startSession(req, user.id, 'password'));

    res.json({ success: true, sessionToken, user });
  } catch (err) {
    recordFailedLogin(req, email);
    console.error('login error:', err.message);
    sendAuthError(res, err);
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

    const sessionToken = issueSessionToken(user.id, await startSession(req, user.id, 'password'));
    res.json({ success: true, sessionToken, user });
  } catch (err) {
    recordFailedLogin(req, email);
    console.error('admin-login error:', err.message);
    sendAuthError(res, err);
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
  res.json({
    success: true,
    registrationUrl: settings.extensionRegistrationUrl || null,
    backendUrl: settings.extensionBackendUrl || 'https://elms-backend-1-tr5h.onrender.com',
  });
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
  res.json({
    success: true,
    sessionToken,
    user: {
      id: user._id.toString(),
      username: user.username || null,
      name: user.name || null,
      email: user.email || null,
      picture: user.picture || null,
    },
  });
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
