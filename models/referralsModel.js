const mongoose = require('mongoose');
const Referral = require('./schemas/Referral');
const User = require('./schemas/User');
const Purchase = require('./schemas/Purchase');

/**
 * Database access for the referral programme. The rules (who gets which discount, when a reward is due) live in
 * services/referralService.js; nothing here decides anything. Every row comes back as a plain object with string ids.
 */

const id = (v) => (v == null ? null : String(v));
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const REFERRER_FIELDS = 'email username name emailKey referralCode referralDiscountPercent referralRewardCredits referralBlocked suspendedAt createdAt';

function plainUser(u) {
  if (!u) return null;
  return {
    id: id(u._id),
    email: u.email || null,
    username: u.username || null,
    name: u.name || null,
    emailKey: u.emailKey || null,
    referralCode: u.referralCode || null,
    referralDiscountPercent: u.referralDiscountPercent == null ? null : Number(u.referralDiscountPercent),
    referralRewardCredits: u.referralRewardCredits == null ? null : Number(u.referralRewardCredits),
    referralBlocked: !!u.referralBlocked,
    suspended: !!u.suspendedAt,
    createdAt: u.createdAt || null,
  };
}

function plainReferral(r) {
  if (!r) return null;
  return {
    id: id(r._id),
    referrerId: id(r.referrerId),
    referredUserId: id(r.referredUserId),
    code: r.code,
    discountedPurchases: r.discountedPurchases || 0,
    purchases: r.purchases || 0,
    totalSpentUsd: r.totalSpentUsd || 0,
    firstPurchaseAt: r.firstPurchaseAt || null,
    rewardedAt: r.rewardedAt || null,
    rewardCredits: r.rewardCredits || 0,
    createdAt: r.createdAt,
  };
}

// ---------- users as referrers ----------
async function getUser(userId) {
  return plainUser(await User.findById(userId).select(REFERRER_FIELDS).lean());
}

async function findUserByCode(code) {
  return plainUser(await User.findOne({ referralCode: code }).select(REFERRER_FIELDS).lean());
}

/** Gives the user this code unless they already have one; returns the code they end up with. Throws E11000 when another user has the code. */
async function setCodeIfMissing(userId, code) {
  const doc = await User.findOneAndUpdate(
    { _id: userId, $or: [{ referralCode: { $exists: false } }, { referralCode: null }] },
    { $set: { referralCode: code } },
    { new: true, projection: 'referralCode' }
  ).lean();
  if (doc) return doc.referralCode;
  const existing = await User.findById(userId).select('referralCode').lean();
  return existing ? existing.referralCode || null : null;
}

/** Admin: replaces the code (a custom one such as BILAL20). Throws E11000 when it is taken. */
async function replaceCode(userId, code) {
  const doc = await User.findByIdAndUpdate(userId, { $set: { referralCode: code } }, { new: true }).select(REFERRER_FIELDS).lean();
  return plainUser(doc);
}

async function setReferrerOverrides(userId, { discountPercent, rewardCredits, blocked }) {
  const $set = {};
  if (discountPercent !== undefined) $set.referralDiscountPercent = discountPercent;
  if (rewardCredits !== undefined) $set.referralRewardCredits = rewardCredits;
  if (blocked !== undefined) $set.referralBlocked = !!blocked;
  const doc = await User.findByIdAndUpdate(userId, { $set }, { new: true }).select(REFERRER_FIELDS).lean();
  return plainUser(doc);
}

async function searchUsers(query, limit = 8) {
  const q = String(query || '').trim();
  if (!q) return [];
  const re = new RegExp(escapeRegex(q), 'i');
  const docs = await User.find({ $or: [{ email: re }, { username: re }, { name: re }, { referralCode: q.toUpperCase() }] })
    .select(REFERRER_FIELDS).sort({ createdAt: -1 }).limit(limit).lean();
  return docs.map(plainUser);
}

async function getUsersByIds(ids) {
  const list = [...new Set(ids.filter(Boolean).map(String))].filter((v) => mongoose.isValidObjectId(v));
  if (!list.length) return new Map();
  const docs = await User.find({ _id: { $in: list } }).select(REFERRER_FIELDS).lean();
  return new Map(docs.map((d) => [id(d._id), plainUser(d)]));
}

// ---------- referrals ----------
async function findReferralByReferred(userId) {
  return plainReferral(await Referral.findOne({ referredUserId: userId }).lean());
}

/** Throws E11000 when this person is already referred. */
async function createReferral({ referrerId, referredUserId, code, ip }) {
  const doc = await Referral.create({ referrerId, referredUserId, code, ip: ip || null });
  return plainReferral(doc.toObject());
}

async function incDiscounted(referralId) {
  await Referral.updateOne({ _id: referralId }, { $inc: { discountedPurchases: 1 } });
}

async function recordPurchaseOn(referralId, priceUsd) {
  await Referral.updateOne({ _id: referralId }, { $inc: { purchases: 1, totalSpentUsd: Number(priceUsd) || 0 } });
  await Referral.updateOne({ _id: referralId, firstPurchaseAt: null }, { $set: { firstPurchaseAt: new Date() } });
}

/** Marks the referrer's reward as given, once: only the call that finds it not yet rewarded gets the row back. */
async function claimReward(referralId, credits) {
  const doc = await Referral.findOneAndUpdate({ _id: referralId, rewardedAt: null }, { $set: { rewardedAt: new Date(), rewardCredits: credits } }, { new: true }).lean();
  return plainReferral(doc);
}

async function referrerTotals(referrerId) {
  const rows = await Referral.aggregate([
    { $match: { referrerId: new mongoose.Types.ObjectId(String(referrerId)) } },
    { $group: { _id: null, signups: { $sum: 1 }, buyers: { $sum: { $cond: [{ $ne: ['$firstPurchaseAt', null] }, 1, 0] } }, creditsEarned: { $sum: '$rewardCredits' }, revenueUsd: { $sum: '$totalSpentUsd' } } },
  ]);
  const r = rows[0] || {};
  return { signups: r.signups || 0, buyers: r.buyers || 0, creditsEarned: r.creditsEarned || 0, revenueUsd: r.revenueUsd || 0 };
}

async function listForReferrer(referrerId, limit = 100) {
  const rows = await Referral.find({ referrerId }).sort({ createdAt: -1 }).limit(limit).lean();
  return rows.map(plainReferral);
}

// ---------- admin overview ----------
async function adminTotals() {
  const [refs, discounts] = await Promise.all([
    Referral.aggregate([{ $group: { _id: null, signups: { $sum: 1 }, buyers: { $sum: { $cond: [{ $ne: ['$firstPurchaseAt', null] }, 1, 0] } }, revenueUsd: { $sum: '$totalSpentUsd' }, creditsGiven: { $sum: '$rewardCredits' } } }]),
    Purchase.aggregate([
      { $match: { referralId: { $ne: null }, status: 'completed' } },
      { $group: { _id: null, purchases: { $sum: 1 }, discountUsd: { $sum: { $subtract: [{ $ifNull: ['$listPriceUsd', '$priceUsd'] }, '$priceUsd'] } } } },
    ]),
  ]);
  const r = refs[0] || {};
  const d = discounts[0] || {};
  return { signups: r.signups || 0, buyers: r.buyers || 0, revenueUsd: r.revenueUsd || 0, creditsGiven: r.creditsGiven || 0, discountedPurchases: d.purchases || 0, discountUsd: d.discountUsd || 0 };
}

async function topReferrers(limit = 25) {
  const rows = await Referral.aggregate([
    { $group: { _id: '$referrerId', signups: { $sum: 1 }, buyers: { $sum: { $cond: [{ $ne: ['$firstPurchaseAt', null] }, 1, 0] } }, revenueUsd: { $sum: '$totalSpentUsd' }, creditsEarned: { $sum: '$rewardCredits' }, lastAt: { $max: '$createdAt' } } },
    { $sort: { signups: -1, revenueUsd: -1 } },
    { $limit: limit },
  ]);
  return rows.map((r) => ({ referrerId: id(r._id), signups: r.signups, buyers: r.buyers, revenueUsd: r.revenueUsd, creditsEarned: r.creditsEarned, lastAt: r.lastAt }));
}

async function recentReferrals(limit = 40) {
  const rows = await Referral.find().sort({ createdAt: -1 }).limit(limit).lean();
  return rows.map(plainReferral);
}

module.exports = {
  getUser, findUserByCode, setCodeIfMissing, replaceCode, setReferrerOverrides, searchUsers, getUsersByIds,
  findReferralByReferred, createReferral, incDiscounted, recordPurchaseOn, claimReward, referrerTotals, listForReferrer,
  adminTotals, topReferrers, recentReferrals,
};
