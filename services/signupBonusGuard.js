const User = require('../models/schemas/User');
const LoginEvent = require('../models/schemas/LoginEvent');

const WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_NEW_ACCOUNTS_PER_IP_PER_DAY = 3; // a home / office network may have a few real people; more looks like farming

/**
 * The same mailbox written differently: Gmail ignores dots and "+tags" (a.b+1@gmail.com is a.b@gmail.com is ab@gmail.com),
 * other providers usually ignore "+tags". Used so one person cannot collect the welcome credits again and again.
 */
function emailKey(email) {
  const [localRaw, domainRaw] = String(email || '').trim().toLowerCase().split('@');
  if (!localRaw || !domainRaw) return String(email || '').trim().toLowerCase();
  let local = localRaw.split('+')[0];
  let domain = domainRaw;
  if (domain === 'gmail.com' || domain === 'googlemail.com') { local = local.replace(/\./g, ''); domain = 'gmail.com'; }
  return local + '@' + domain;
}

/**
 * Decides whether a brand-new account gets the welcome credits. The account is created either way; only the free credits are
 * held back when this mailbox, this browser or this network has already collected them. Returns { allowed, reason }.
 * `ctx` is { ip, deviceId } from sessionTracker.requestContext(req).
 */
async function welcomeBonusDecision(email, ctx = {}) {
  const key = emailKey(email);
  if (await User.exists({ emailKey: key })) return { allowed: false, reason: 'same mailbox as an existing account' };

  // A browser that came with an id of its own (not the guessed "ua-" one) and has already been signed in to an account.
  if (ctx.deviceId && !String(ctx.deviceId).startsWith('ua-') && await LoginEvent.exists({ deviceId: ctx.deviceId, success: true })) {
    return { allowed: false, reason: 'this browser already has an account' };
  }

  if (ctx.ip) {
    const since = new Date(Date.now() - WINDOW_MS);
    const recent = await User.find({ createdAt: { $gt: since } }, { _id: 1 }).limit(5000).lean();
    if (recent.length) {
      const owners = await LoginEvent.distinct('userId', { ip: ctx.ip, success: true, userId: { $in: recent.map((u) => u._id) } });
      if (owners.length >= MAX_NEW_ACCOUNTS_PER_IP_PER_DAY) return { allowed: false, reason: 'too many new accounts from this network today' };
    }
  }
  return { allowed: true, reason: null };
}

/** Gives accounts made before this existed their emailKey (at start-up; already-filled accounts are skipped). */
async function backfillEmailKeys() {
  const rows = await User.find({ emailKey: null }, { email: 1 }).limit(20000).lean();
  if (!rows.length) return 0;
  await User.bulkWrite(rows.map((u) => ({ updateOne: { filter: { _id: u._id }, update: { $set: { emailKey: emailKey(u.email) } } } })), { ordered: false });
  return rows.length;
}

module.exports = { emailKey, welcomeBonusDecision, backfillEmailKeys, MAX_NEW_ACCOUNTS_PER_IP_PER_DAY };
