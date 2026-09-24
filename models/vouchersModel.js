const mongoose = require('mongoose');
const Voucher = require('./schemas/Voucher');

/** Database access for vouchers. The rules (who may use which, what it is worth) live in services/voucherService.js. */

const id = (v) => (v == null ? null : String(v));

function plain(v) {
  if (!v) return null;
  return {
    id: id(v._id),
    userId: id(v.userId),
    kind: v.kind,
    percent: v.percent == null ? null : Number(v.percent),
    amountUsd: v.amountUsd == null ? null : Number(v.amountUsd),
    planId: id(v.planId),
    credits: v.credits == null ? null : Number(v.credits),
    ebayAccounts: v.ebayAccounts == null ? null : Number(v.ebayAccounts),
    note: v.note || '',
    expiresAt: v.expiresAt || null,
    status: v.status,
    usedAt: v.usedAt || null,
    usedFor: v.usedFor || null,
    revokedAt: v.revokedAt || null,
    createdAt: v.createdAt,
  };
}

const validId = (v) => mongoose.isValidObjectId(String(v || ''));

async function create(fields) {
  const doc = await Voucher.create(fields);
  return plain(doc.toObject());
}

async function getById(voucherId) {
  if (!validId(voucherId)) return null;
  return plain(await Voucher.findById(voucherId).lean());
}

async function listForUser(userId) {
  const rows = await Voucher.find({ userId }).sort({ createdAt: -1 }).limit(200).lean();
  return rows.map(plain);
}

/** Marks the voucher used - only the one call that finds it still active gets it back (so it works once). */
async function claim(voucherId, userId, usedFor) {
  if (!validId(voucherId)) return null;
  const doc = await Voucher.findOneAndUpdate(
    { _id: voucherId, userId, status: 'active' },
    { $set: { status: 'used', usedAt: new Date(), usedFor } },
    { new: true }
  ).lean();
  return plain(doc);
}

/** Gives a claimed voucher back (the thing it was redeemed for could not be done). */
async function release(voucherId) {
  await Voucher.updateOne({ _id: voucherId, status: 'used' }, { $set: { status: 'active', usedAt: null, usedFor: null } });
}

async function revoke(voucherId) {
  if (!validId(voucherId)) return null;
  const doc = await Voucher.findOneAndUpdate({ _id: voucherId, status: 'active' }, { $set: { status: 'revoked', revokedAt: new Date() } }, { new: true }).lean();
  return plain(doc);
}

/** Admin list, newest first. `userIds` narrows it to those people. */
async function adminList({ status, kind, userIds, limit = 200 } = {}) {
  const q = {};
  if (status && ['active', 'used', 'revoked'].includes(status)) q.status = status;
  if (kind) q.kind = kind;
  if (Array.isArray(userIds)) q.userId = { $in: userIds.filter(validId) };
  const rows = await Voucher.find(q).sort({ createdAt: -1 }).limit(limit).lean();
  return rows.map(plain);
}

async function adminCounts() {
  const rows = await Voucher.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]);
  const out = { active: 0, used: 0, revoked: 0 };
  for (const r of rows) if (r._id in out) out[r._id] = r.n;
  return out;
}

module.exports = { create, getById, listForUser, claim, release, revoke, adminList, adminCounts };
