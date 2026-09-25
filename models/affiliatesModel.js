const Affiliate = require('./schemas/Affiliate');
const Commission = require('./schemas/AffiliateCommission');
const Payout = require('./schemas/AffiliatePayout');
const User = require('./schemas/User');

const id = (v) => (v == null ? null : String(v));
const affiliate = (d) => d && ({
  id: id(d._id), userId: id(d.userId), status: d.status, code: d.code, commissionPercent: d.commissionPercent == null ? null : d.commissionPercent,
  payoutNetwork: d.payoutNetwork || null, payoutAddress: d.payoutAddress || null, promo: d.promo || '', adminNote: d.adminNote || '', approvedAt: d.approvedAt || null, createdAt: d.createdAt,
});
const commission = (d) => d && ({ id: id(d._id), affiliateId: id(d.affiliateId), referredUserId: id(d.referredUserId), purchaseId: id(d.purchaseId), paidUsd: d.paidUsd, percent: d.percent, commissionUsd: d.commissionUsd, status: d.status, availableAt: d.availableAt, payoutId: id(d.payoutId), createdAt: d.createdAt });
const payout = (d) => d && ({ id: id(d._id), affiliateId: id(d.affiliateId), amountUsd: d.amountUsd, network: d.network, address: d.address, status: d.status, txHash: d.txHash || '', adminNote: d.adminNote || '', processedAt: d.processedAt || null, createdAt: d.createdAt });

async function getByUserId(userId) { return affiliate(await Affiliate.findOne({ userId }).lean()); }
async function getById(affId) { return /^[a-f0-9]{24}$/i.test(String(affId)) ? affiliate(await Affiliate.findById(affId).lean()) : null; }
async function getByCode(code) { return affiliate(await Affiliate.findOne({ code }).lean()); }
async function create(row) {
  const doc = await Affiliate.create(row);
  return affiliate(doc.toObject());
}
async function update(affId, set) { return affiliate(await Affiliate.findByIdAndUpdate(affId, { $set: set }, { new: true }).lean()); }

/** Every affiliate with the person's name and email, newest first (admin list). */
async function listWithUsers(status) {
  const rows = await Affiliate.find(status ? { status } : {}).sort({ createdAt: -1 }).lean();
  const users = await User.find({ _id: { $in: rows.map((r) => r.userId) } }, { email: 1, name: 1, username: 1 }).lean();
  const byId = new Map(users.map((u) => [String(u._id), u]));
  return rows.map((r) => ({ ...affiliate(r), email: (byId.get(String(r.userId)) || {}).email || null, name: (byId.get(String(r.userId)) || {}).name || (byId.get(String(r.userId)) || {}).username || null }));
}

/** True when some user already has this as their referral code (an affiliate code must be different from every referral code). */
async function referralCodeTaken(code) { return !!(await User.exists({ referralCode: code })); }

async function attachUser(userId, affiliateId) {
  const res = await User.updateOne({ _id: userId, affiliateId: { $exists: false } }, { $set: { affiliateId } });
  return !!(res.modifiedCount || res.nModified);
}
async function affiliateIdOfUser(userId) {
  const u = await User.findById(userId, { affiliateId: 1, email: 1 }).lean();
  return u ? { affiliateId: id(u.affiliateId), email: u.email } : null;
}
async function signups(affId) { return User.countDocuments({ affiliateId: affId }); }

/** Records a commission; null when this purchase already has one. */
async function createCommission(row) {
  try {
    return commission((await Commission.create(row)).toObject());
  } catch (err) {
    if (err && err.code === 11000) return null;
    throw err;
  }
}
async function commissionsFor(affId, limit = 50) { return (await Commission.find({ affiliateId: affId }).sort({ createdAt: -1 }).limit(limit).lean()).map(commission); }

/** The money an affiliate has, in the states that matter: waiting in the hold, ready, asked for, paid. */
async function totals(affId, now = new Date()) {
  const rows = await Commission.aggregate([
    { $match: { affiliateId: typeof affId === 'string' ? new (require('mongoose').Types.ObjectId)(affId) : affId, status: { $ne: 'void' } } },
    { $group: { _id: { status: '$status', held: { $gt: ['$availableAt', now] }, requested: { $ne: ['$payoutId', null] } }, usd: { $sum: '$commissionUsd' }, n: { $sum: 1 }, customers: { $addToSet: '$referredUserId' } } },
  ]);
  const out = { earned: 0, hold: 0, available: 0, requested: 0, paid: 0, customers: 0, payments: 0 };
  const seen = new Set();
  for (const r of rows) {
    out.earned += r.usd;
    out.payments += r.n;
    r.customers.forEach((c) => seen.add(String(c)));
    if (r._id.status === 'paid') out.paid += r.usd;
    else if (r._id.requested) out.requested += r.usd;
    else if (r._id.held) out.hold += r.usd;
    else out.available += r.usd;
  }
  out.customers = seen.size;
  for (const k of ['earned', 'hold', 'available', 'requested', 'paid']) out[k] = Math.round(out[k] * 100) / 100;
  return out;
}

async function createPayout(row) { return payout((await Payout.create(row)).toObject()); }
async function getPayout(payoutId) { return /^[a-f0-9]{24}$/i.test(String(payoutId)) ? payout(await Payout.findById(payoutId).lean()) : null; }
async function openPayout(affId) { return payout(await Payout.findOne({ affiliateId: affId, status: 'requested' }).lean()); }
async function payoutsFor(affId, limit = 30) { return (await Payout.find({ affiliateId: affId }).sort({ createdAt: -1 }).limit(limit).lean()).map(payout); }
async function updatePayout(payoutId, set, onlyStatus) {
  return payout(await Payout.findOneAndUpdate({ _id: payoutId, ...(onlyStatus ? { status: onlyStatus } : {}) }, { $set: set }, { new: true }).lean());
}
async function deletePayout(payoutId) { await Payout.deleteOne({ _id: payoutId }); }
async function listPayouts(status) { return (await Payout.find(status ? { status } : {}).sort({ createdAt: -1 }).limit(200).lean()).map(payout); }

/** Puts every commission that is ready (hold over, not asked for yet) into a payout. Returns the sum actually claimed. */
async function claimAvailable(affId, payoutId, now = new Date()) {
  await Commission.updateMany({ affiliateId: affId, status: 'active', payoutId: null, availableAt: { $lte: now } }, { $set: { payoutId } });
  const claimed = await Commission.find({ payoutId }).lean();
  return Math.round(claimed.reduce((t, c) => t + c.commissionUsd, 0) * 100) / 100;
}
async function releasePayout(payoutId) { await Commission.updateMany({ payoutId, status: { $ne: 'paid' } }, { $set: { payoutId: null } }); }
async function markPayoutPaid(payoutId) { await Commission.updateMany({ payoutId }, { $set: { status: 'paid' } }); }
async function voidForPurchase(purchaseId) {
  const res = await Commission.updateMany({ purchaseId, status: 'active', payoutId: null }, { $set: { status: 'void' } });
  return res.modifiedCount || res.nModified || 0;
}

module.exports = {
  getByUserId, getById, getByCode, create, update, listWithUsers, referralCodeTaken, attachUser, affiliateIdOfUser, signups,
  createCommission, commissionsFor, totals, createPayout, getPayout, openPayout, payoutsFor, updatePayout, deletePayout, listPayouts,
  claimAvailable, releasePayout, markPayoutPaid, voidForPurchase,
};
