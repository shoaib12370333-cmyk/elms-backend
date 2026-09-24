const crypto = require('crypto');
const model = require('../models/referralsModel');
const { getReferralSettings } = require('../models/settingsModel');
const { emailKey } = require('./signupBonusGuard');

/**
 * The referral programme.
 *
 *  - Everybody has a referral code (made when they first open Refer & Earn; an admin can give a custom one).
 *  - A friend who signs up with that code (?ref=CODE in the link, or typed at sign-up) is recorded as referred by that person.
 *  - The friend gets `discountPercent` off their first `discountUses` purchase(s), for `discountDays` days after signing up
 *    (0 = no limit). The percent is the admin's default, or the one the admin set for this referrer.
 *  - The referrer earns `rewardCredits` (default or per-referrer) once, when the friend makes their first purchase.
 *
 * The discount is worked out here, on the server, when a checkout starts - the browser only ever shows it.
 */

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I: codes are read out and typed
const CODE_LENGTH = 8;
const CUSTOM_CODE_RE = /^[A-Z0-9]{4,20}$/;
const MAX_DISCOUNT_PERCENT = 90;
const MIN_CHARGE_CENTS = 50; // CashTap's smallest checkout is $0.50
const LATE_CODE_DAYS = 30; // a code can still be added to an account this many days after sign-up, until its first purchase

const frontendUrl = () => String(process.env.FRONTEND_URL || 'https://elmstool.com').replace(/\/+$/, '');
const round2 = (n) => Math.round(Number(n) * 100) / 100;

/** What a person typed or pasted -> the stored form (upper case, no spaces or dashes). Empty when it cannot be a code. */
function normalizeCode(value) {
  const cleaned = String(value == null ? '' : value).toUpperCase().replace(/[\s-]+/g, '');
  return /^[A-Z0-9]{1,24}$/.test(cleaned) ? cleaned : '';
}

function randomCode() {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return out;
}

function clampPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return round2(Math.min(MAX_DISCOUNT_PERCENT, n));
}

/** The price after a percent discount, never below the payment provider's minimum and never above the list price. */
function priceAfterDiscount(priceUsd, percent) {
  const cents = Math.round(Number(priceUsd) * 100);
  const p = clampPercent(percent);
  if (!(cents > 0) || p <= 0) return round2(priceUsd);
  const off = Math.round((cents * p) / 100);
  return Math.min(cents, Math.max(MIN_CHARGE_CENTS, cents - off)) / 100;
}

/** j***@gmail.com - shown to the referrer instead of their friends' addresses. */
function maskEmail(email) {
  const [local, domain] = String(email || '').split('@');
  if (!local || !domain) return 'a friend';
  return (local.length <= 2 ? local[0] : local[0] + '***' + local[local.length - 1]) + '@' + domain;
}

const usable = (referrer) => !!referrer && !referrer.referralBlocked && !referrer.suspended;
const percentFor = (referrer, config) => clampPercent(referrer && referrer.referralDiscountPercent != null ? referrer.referralDiscountPercent : config.discountPercent);
const rewardFor = (referrer, config) => Math.max(0, Math.floor(Number(referrer && referrer.referralRewardCredits != null ? referrer.referralRewardCredits : config.rewardCredits) || 0));

/** The person's code, made on first use. */
async function ensureCode(userId) {
  const user = await model.getUser(userId);
  if (!user) return null;
  if (user.referralCode) return user.referralCode;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      return await model.setCodeIfMissing(userId, randomCode());
    } catch (err) {
      if (err && err.code === 11000) continue; // another person has this code: draw another
      throw err;
    }
  }
  throw new Error('Could not create a referral code.');
}

/** Is this code usable, and what does it give? (Used by the sign-up form before the account exists.) */
async function checkCode(rawCode) {
  const config = await getReferralSettings();
  if (!config.enabled) return { valid: false, reason: 'disabled' };
  const code = normalizeCode(rawCode);
  if (!code) return { valid: false, reason: 'invalid_code' };
  const referrer = await model.findUserByCode(code);
  if (!usable(referrer)) return { valid: false, reason: 'invalid_code' };
  const discountPercent = percentFor(referrer, config);
  return { valid: true, code, discountPercent, discountUses: config.discountUses, discountDays: config.discountDays };
}

/**
 * Records that `user` (a brand-new account) came through `rawCode`. Never throws for a bad code - the sign-up must go on -
 * it says what happened: { applied, reason?, discountPercent?, discountUses?, discountDays? }.
 */
async function attachReferral({ user, code: rawCode, ip }) {
  const config = await getReferralSettings();
  if (!config.enabled) return { applied: false, reason: 'disabled' };
  const code = normalizeCode(rawCode);
  if (!code) return { applied: false, reason: 'invalid_code' };
  const referrer = await model.findUserByCode(code);
  if (!usable(referrer)) return { applied: false, reason: 'invalid_code' };
  if (referrer.id === String(user.id) || (referrer.emailKey || emailKey(referrer.email)) === emailKey(user.email)) return { applied: false, reason: 'self' };
  if (await model.findReferralByReferred(user.id)) return { applied: false, reason: 'already' };
  try {
    await model.createReferral({ referrerId: referrer.id, referredUserId: user.id, code, ip });
  } catch (err) {
    if (err && err.code === 11000) return { applied: false, reason: 'already' };
    throw err;
  }
  const discountPercent = percentFor(referrer, config);
  return { applied: true, discountPercent, discountUses: config.discountUses, discountDays: config.discountDays };
}

/**
 * The referral discount this person can use on their next purchase, or null.
 * @returns {Promise<null | { referralId: string, referrerId: string, code: string, percent: number, usesLeft: number, expiresAt: Date|null }>}
 */
async function discountFor(userId, now = Date.now()) {
  const config = await getReferralSettings();
  if (!config.enabled) return null;
  const referral = await model.findReferralByReferred(userId);
  if (!referral) return null;
  const usesLeft = config.discountUses - referral.discountedPurchases;
  if (usesLeft <= 0) return null;
  const expiresAt = config.discountDays > 0 ? new Date(new Date(referral.createdAt).getTime() + config.discountDays * 86400000) : null;
  if (expiresAt && now > expiresAt.getTime()) return null;
  const referrer = await model.getUser(referral.referrerId);
  if (!usable(referrer)) return null;
  const percent = percentFor(referrer, config);
  if (percent <= 0) return null;
  return { referralId: referral.id, referrerId: referral.referrerId, code: referral.code, percent, usesLeft, expiresAt };
}

/**
 * A purchase was completed and paid: count the discount as used, and give the referrer their reward - once, for the
 * friend's first purchase. Never throws (the buyer already has their credits); problems are logged loudly.
 */
async function afterPurchase({ userId, priceUsd, referralId }) {
  try {
    const referral = await model.findReferralByReferred(userId);
    if (!referral) return { rewarded: false };
    if (referralId && String(referralId) === referral.id) await model.incDiscounted(referral.id);
    await model.recordPurchaseOn(referral.id, priceUsd);
    if (referral.rewardedAt || !(Number(priceUsd) > 0)) return { rewarded: false };

    const config = await getReferralSettings();
    const referrer = await model.getUser(referral.referrerId);
    if (!usable(referrer)) return { rewarded: false };
    const credits = rewardFor(referrer, config);
    const claimed = await model.claimReward(referral.id, credits); // only one of two racing purchases gets the row back
    if (!claimed) return { rewarded: false };
    if (credits > 0) {
      try {
        await require('../models/usersModel').addCredits(referrer.id, credits);
      } catch (err) {
        console.error(`[referral] REWARD NOT GIVEN: ${credits} credit(s) for referrer ${referrer.id} (friend ${userId}, referral ${referral.id}): ${err.message}`);
        return { rewarded: false, error: err.message };
      }
    }
    return { rewarded: true, credits, referrerId: referrer.id };
  } catch (err) {
    console.error('[referral] afterPurchase failed for user ' + userId + ': ' + err.message);
    return { rewarded: false, error: err.message };
  }
}

/** A code can be added later (Buy credits page) only by a recent account that has not bought anything and was not referred. */
async function canAddCode(userId, { user, config, hasPurchases }) {
  if (!config.enabled || hasPurchases) return false;
  if (await model.findReferralByReferred(userId)) return false;
  const created = user && user.createdAt ? new Date(user.createdAt).getTime() : 0;
  return !!created && Date.now() - created <= LATE_CODE_DAYS * 86400000;
}

/** Everything the Refer & Earn page shows. */
async function pageFor(userId) {
  const { hasPurchases } = require('../models/purchasesModel');
  const config = await getReferralSettings();
  const me = await model.getUser(userId);
  if (!me) return null;
  const code = await ensureCode(userId);
  const [totals, rows, mine, bought] = await Promise.all([model.referrerTotals(userId), model.listForReferrer(userId, 100), model.findReferralByReferred(userId), hasPurchases(userId)]);
  const friends = await model.getUsersByIds(rows.map((r) => r.referredUserId));
  const discount = await discountFor(userId);
  return {
    enabled: config.enabled,
    blocked: !!me.referralBlocked,
    code,
    link: code ? frontendUrl() + '/signup?ref=' + encodeURIComponent(code) : null,
    offer: {
      friendDiscountPercent: percentFor(me, config),
      discountUses: config.discountUses,
      discountDays: config.discountDays,
      rewardCredits: rewardFor(me, config),
    },
    stats: totals,
    referrals: rows.map((r) => ({
      who: maskEmail(friends.get(r.referredUserId) && friends.get(r.referredUserId).email),
      joinedAt: r.createdAt,
      status: r.firstPurchaseAt ? 'purchased' : 'signed_up',
      rewardCredits: r.rewardCredits || 0,
    })),
    referredBy: mine ? { code: mine.code, discount: discount ? { percent: discount.percent, usesLeft: discount.usesLeft, expiresAt: discount.expiresAt } : null } : null,
    canAddCode: await canAddCode(userId, { user: me, config, hasPurchases: bought }),
  };
}

/** Adds a code to an existing account (Buy credits page). Returns { applied, reason?, ... } like attachReferral. */
async function addLateCode({ userId, code, ip }) {
  const { hasPurchases } = require('../models/purchasesModel');
  const config = await getReferralSettings();
  if (!config.enabled) return { applied: false, reason: 'disabled' };
  const me = await model.getUser(userId);
  if (!me) return { applied: false, reason: 'no_user' };
  if (await model.findReferralByReferred(userId)) return { applied: false, reason: 'already' };
  if (await hasPurchases(userId)) return { applied: false, reason: 'has_purchases' };
  if (!(await canAddCode(userId, { user: me, config, hasPurchases: false }))) return { applied: false, reason: 'too_late' };
  return attachReferral({ user: me, code, ip });
}

/** Admin: gives someone a custom code (e.g. BILAL20). Throws with statusCode 409 when it is taken, 400 when it is not a valid code. */
async function setCustomCode(userId, rawCode) {
  const code = normalizeCode(rawCode);
  if (!CUSTOM_CODE_RE.test(code)) throw Object.assign(new Error('A code is 4 to 20 letters and numbers (no spaces).'), { statusCode: 400 });
  try {
    return await model.replaceCode(userId, code);
  } catch (err) {
    if (err && err.code === 11000) throw Object.assign(new Error('That code is already used by someone else.'), { statusCode: 409 });
    throw err;
  }
}

module.exports = {
  normalizeCode, randomCode, clampPercent, priceAfterDiscount, maskEmail,
  ensureCode, checkCode, attachReferral, discountFor, afterPurchase, pageFor, addLateCode, setCustomCode,
  percentFor, rewardFor, frontendUrl,
  MAX_DISCOUNT_PERCENT, LATE_CODE_DAYS, CUSTOM_CODE_RE,
};
