const crypto = require('crypto');
const PendingSignup = require('../models/schemas/PendingSignup');
const User = require('../models/schemas/User');
const { hashPassword } = require('./passwordService');
const { registerWithPassword } = require('../models/usersModel');
const { welcomeBonusDecision } = require('./signupBonusGuard');

/**
 * Sign-up with an email confirmation code. `startSignup` mails a 6-digit code and remembers the sign-up (no account yet);
 * `confirmSignup` makes the account when the code and the browser's pendingToken both match; `resendCode` mails a fresh code.
 * See models/schemas/PendingSignup.js for why nothing is created before the code is entered.
 */
const CODE_MINUTES = 15;
const RESEND_AFTER_SECONDS = 60;
const MAX_ATTEMPTS = 5;
const MAX_SENDS_PER_SIGNUP = 6;
const MAX_STARTS_PER_EMAIL_PER_HOUR = 5;
const KEEP_HOURS = 24;

const fail = (statusCode, message, extra = {}) => Object.assign(new Error(message), { statusCode, ...extra });
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const codeHash = (email, code) => crypto.createHmac('sha256', process.env.JWT_SECRET).update(email + ':' + code).digest('hex');
const sameHash = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const newCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');
const mail = () => require('./emailService');

async function sendCode(email, code) {
  try {
    await mail().sendSignupCodeEmail({ to: email, code, minutes: CODE_MINUTES });
  } catch (err) {
    console.error('sign-up code email failed:', err.message);
    throw fail(503, 'We could not send the confirmation email right now. Please try again in a few minutes.');
  }
}

/** Begins a sign-up. Returns what the browser needs to show the "enter the code" step. */
async function startSignup({ username, email, password, referralCode, affiliateCode, ip }) {
  if (await User.findOne({ email })) {
    throw fail(409, 'An account with this email already exists. Please sign in. If you signed up with Google or forgot your password, use "Forgot password?" to choose one.');
  }
  if (await User.findOne({ username })) throw fail(409, 'That username is already taken.');
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  if (await PendingSignup.countDocuments({ email, createdAt: { $gte: hourAgo } }) >= MAX_STARTS_PER_EMAIL_PER_HOUR) {
    throw fail(429, 'Too many confirmation emails were sent to that address. Please try again in an hour.');
  }

  const code = newCode();
  const pendingToken = crypto.randomBytes(24).toString('hex');
  const now = Date.now();
  const record = await PendingSignup.create({
    email, username, passwordHash: await hashPassword(password),
    tokenHash: sha256(pendingToken), codeHash: codeHash(email, code), codeExpiresAt: new Date(now + CODE_MINUTES * 60 * 1000),
    lastSentAt: new Date(now), referralCode: referralCode || null, affiliateCode: affiliateCode || null, ip: ip || null,
    expiresAt: new Date(now + KEEP_HOURS * 60 * 60 * 1000),
  });
  try {
    await sendCode(email, code);
  } catch (err) {
    await PendingSignup.deleteOne({ _id: record._id }).catch(() => {});
    throw err;
  }
  return { pendingToken, email, codeMinutes: CODE_MINUTES, resendAfterSeconds: RESEND_AFTER_SECONDS };
}

const findPending = (pendingToken) => (typeof pendingToken === 'string' && pendingToken.length >= 16 ? PendingSignup.findOne({ tokenHash: sha256(pendingToken) }) : null);
const GONE = () => fail(400, 'This sign-up has expired. Please start again.', { restart: true });

/**
 * The code was typed: makes the account (welcome credits, welcome mail) and returns it with the codes the person arrived with.
 * ctx = { ip, deviceId } of the confirming request, for the welcome-credit guard.
 */
async function confirmSignup({ pendingToken, code, ctx }) {
  const record = await findPending(pendingToken);
  if (!record) throw GONE();
  if (record.codeExpiresAt <= new Date()) throw fail(400, 'That code has expired. Press "Resend code" to get a new one.', { expired: true });
  if (record.attempts >= MAX_ATTEMPTS) throw fail(429, 'Too many incorrect codes. Press "Resend code" to get a new one.', { expired: true });
  if (!sameHash(record.codeHash, codeHash(record.email, String(code)))) {
    const used = record.attempts + 1;
    await PendingSignup.updateOne({ _id: record._id }, { $inc: { attempts: 1 } });
    const left = MAX_ATTEMPTS - used;
    throw fail(400, left > 0 ? 'That code is not correct. ' + left + (left === 1 ? ' try' : ' tries') + ' left.' : 'That code is not correct. Press "Resend code" to get a new one.', { attemptsLeft: left });
  }

  // single use: whoever removes the record first makes the account
  const claimed = await PendingSignup.findOneAndDelete({ _id: record._id });
  if (!claimed) throw GONE();

  const bonus = await welcomeBonusDecision(record.email, ctx || {});
  if (!bonus.allowed) console.warn('[signup-bonus] not given to ' + record.email + ': ' + bonus.reason);
  const user = await registerWithPassword(
    { username: record.username, email: record.email, passwordHash: record.passwordHash },
    { welcomeBonus: bonus.allowed, confirmed: true },
  );
  await PendingSignup.deleteMany({ email: record.email }).catch(() => {});
  return { user, referralCode: record.referralCode, affiliateCode: record.affiliateCode };
}

/** Mails a fresh code for the same sign-up (the old code stops working, the tries start again). */
async function resendCode({ pendingToken }) {
  const record = await findPending(pendingToken);
  if (!record) throw GONE();
  const wait = Math.ceil((record.lastSentAt.getTime() + RESEND_AFTER_SECONDS * 1000 - Date.now()) / 1000);
  if (wait > 0) throw fail(429, 'Please wait ' + wait + ' seconds before asking for another code.', { retryAfterSeconds: wait });
  if (record.sends >= MAX_SENDS_PER_SIGNUP) throw fail(429, 'Too many codes were sent for this sign-up. Please start again in an hour.');

  const code = newCode();
  const now = Date.now();
  await PendingSignup.updateOne({ _id: record._id }, {
    $set: { codeHash: codeHash(record.email, code), codeExpiresAt: new Date(now + CODE_MINUTES * 60 * 1000), attempts: 0, lastSentAt: new Date(now) },
    $inc: { sends: 1 },
  });
  await sendCode(record.email, code);
  return { email: record.email, codeMinutes: CODE_MINUTES, resendAfterSeconds: RESEND_AFTER_SECONDS };
}

module.exports = { startSignup, confirmSignup, resendCode, CODE_MINUTES, RESEND_AFTER_SECONDS };
