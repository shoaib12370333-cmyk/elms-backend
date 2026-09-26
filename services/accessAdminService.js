const IpBlock = require('../models/schemas/IpBlock');
const User = require('../models/schemas/User');
const Session = require('../models/schemas/Session');
const LoginEvent = require('../models/schemas/LoginEvent');
const accessGuard = require('./accessGuard');
const { forgetCache } = require('./sessionTracker');

/**
 * What an admin can do about a suspicious sign-in: read the login history (IP, place, device), suspend the
 * account, or block the IP address (and browser). See accessGuard.js for how a block is enforced.
 */

const IPV4 = /^(\d{1,3})(\.\d{1,3}){3}$/;
const IPV6 = /^[0-9a-f:]{2,45}$/i;
const PRIVATE = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|::1$|fc|fd|fe80)/i;

function fail(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

/** A clean address, or throws with a message an admin can act on. */
function normalizeIp(input) {
  const ip = String(input || '').trim().toLowerCase().replace(/^::ffff:/, '');
  const valid = IPV4.test(ip) ? ip.split('.').every((n) => Number(n) <= 255) : ip.includes(':') && IPV6.test(ip);
  if (!valid) throw fail('That is not a valid IP address.');
  if (PRIVATE.test(ip)) throw fail('That is a private / local address (it does not identify anyone on the internet), so it cannot be blocked.');
  return ip;
}

const cleanDeviceIds = (list) => [...new Set((Array.isArray(list) ? list : []).map((d) => String(d || '').trim()).filter((d) => accessGuard.usableDeviceId(d) && /^[a-zA-Z0-9-]{8,64}$/.test(d)))].slice(0, 20);

/** The accounts that signed in from this address recently, with what an admin needs to tell them apart. */
async function accountsSeenOnIp(ip, days = 90) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = await LoginEvent.aggregate([
    { $match: { ip, success: true, createdAt: { $gte: since } } },
    { $group: { _id: '$userId', lastAt: { $max: '$createdAt' }, logins: { $sum: 1 }, deviceIds: { $addToSet: '$deviceId' } } },
    { $sort: { lastAt: -1 } },
    { $limit: 200 },
  ]);
  const users = await User.find({ _id: { $in: rows.map((r) => r._id) } }, { email: 1, name: 1, role: 1, createdAt: 1, suspendedAt: 1, creditBalance: 1 }).lean();
  const byId = new Map(users.map((u) => [String(u._id), u]));
  return rows.filter((r) => byId.has(String(r._id))).map((r) => {
    const u = byId.get(String(r._id));
    return {
      userId: String(r._id), email: u.email, name: u.name || null, role: u.role || 'user', createdAt: u.createdAt,
      suspended: !!u.suspendedAt, creditBalance: u.creditBalance ?? 0, lastAt: r.lastAt, logins: r.logins,
    };
  });
}

/** Recent sign-ins of one account (newest first), each marked when its IP is currently blocked. */
async function loginHistory(userId, limit = 50) {
  const events = await LoginEvent.find({ userId }).sort({ createdAt: -1 }).limit(Math.min(Number(limit) || 50, 200)).lean();
  const ips = [...new Set(events.map((e) => e.ip).filter(Boolean))];
  const now = new Date();
  const blocks = ips.length ? await IpBlock.find({ ip: { $in: ips }, active: true, $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] }, { ip: 1 }).lean() : [];
  const blocked = new Set(blocks.map((b) => b.ip));
  return events.map((e) => ({
    at: e.createdAt, success: e.success !== false, method: e.method, ip: e.ip || null,
    place: [e.city, e.region, e.country].filter(Boolean).join(', ') || null,
    device: [e.browser, e.os].filter(Boolean).join(' on ') || null, deviceId: accessGuard.usableDeviceId(e.deviceId), ipBlocked: !!(e.ip && blocked.has(e.ip)),
  }));
}

async function revokeSessions(match, reason) {
  await Session.updateMany({ ...match, revokedAt: null }, { $set: { revokedAt: new Date(), revokedReason: reason } });
}

const MAIL_WAIT_MS = 12000; // how long an admin action waits for the mail before answering (the mail keeps going in the background)
const MIN_LIFT_MESSAGE = 10; // a permanent ban is lifted only with a real message to the person
const MAX_LIFT_MESSAGE = 1000;

/** Mails the person about what was done to their account. Never throws: the action is already done. Returns whether the mail was accepted. */
async function tellUser(user, action, details) {
  if (!user || !user.email) return false;
  try {
    const sending = require('./emailService').sendAccountActionEmail({ to: user.email, name: user.name, action, ...details });
    let timer;
    const tooSlow = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('the mail server is slow')), MAIL_WAIT_MS); if (timer.unref) timer.unref(); });
    try { await Promise.race([sending, tooSlow]); } finally { clearTimeout(timer); }
    return true;
  } catch (err) {
    console.warn('account notice mail (' + action + ') was not sent to ' + user.email + ':', err.message);
    return false;
  }
}

/**
 * Suspends an account (permanent = false: the person can appeal) or bans it for good (permanent = true: no appeal). Either way it
 * cannot sign in, its open sessions end, and its scheduled listings are put back to drafts. The person is told by mail.
 * @returns {Promise<{ userId: string, email: string, permanent: boolean, emailed: boolean }>}
 */
async function suspendUser({ userId, reason, note = '', adminId, permanent = false }) {
  const text = String(reason || '').trim();
  if (text.length < 3) throw fail('Write the reason - the person sees it when they try to sign in.');
  const user = await User.findById(userId, { role: 1, email: 1, name: 1, suspendedAt: 1, suspendedPermanent: 1 }).lean();
  if (!user) throw fail('User not found.', 404);
  if (user.role === 'admin') throw fail('An admin account cannot be suspended.');
  if (user.suspendedAt && user.suspendedPermanent && !permanent) throw fail('This account is permanently banned. Reinstate it first (with a message to the person), then suspend it again.');
  const at = new Date();
  await User.updateOne({ _id: userId }, { $set: { suspendedAt: at, suspendedPermanent: !!permanent, suspendedReason: text.slice(0, 500), suspendedNote: String(note || '').slice(0, 1000), sessionsValidFrom: new Date() } });
  await revokeSessions({ userId }, 'suspended');
  try {
    // A suspended seller must not keep publishing: scheduled listings go back to drafts.
    await require('../models/schemas/Listing').updateMany({ userId, status: 'scheduled' }, { $set: { status: 'draft', scheduledAt: null } });
  } catch (_) { /* best effort */ }
  forgetCache(null, null);
  accessGuard.invalidate();
  const emailed = await tellUser(user, permanent ? 'banned' : 'suspended', { reason: text.slice(0, 500), at });
  return { userId: String(userId), email: user.email, permanent: !!permanent, emailed };
}

/**
 * Lifts a suspension or a permanent ban. A permanent ban can only be lifted with a message to the person (at least 10 characters):
 * it goes into the mail they get. For a plain suspension the message is optional. Open appeals of that person are closed.
 * @returns {Promise<{ userId: string, email: string, emailed: boolean, wasBanned: boolean, wasSuspended: boolean }>}
 */
async function unsuspendUser(userId, { message = '' } = {}) {
  const user = await User.findById(userId, { email: 1, name: 1, suspendedAt: 1, suspendedPermanent: 1 }).lean();
  if (!user) throw fail('User not found.', 404);
  const wasSuspended = !!user.suspendedAt;
  const wasBanned = wasSuspended && !!user.suspendedPermanent;
  const text = String(message || '').trim().slice(0, MAX_LIFT_MESSAGE);
  if (wasBanned && text.length < MIN_LIFT_MESSAGE) {
    throw fail('Write a message to the person first (at least ' + MIN_LIFT_MESSAGE + ' characters). A permanently banned account can only be reinstated with a message, and it is sent to them by email.');
  }
  await User.updateOne({ _id: userId }, { $set: { suspendedAt: null, suspendedReason: null, suspendedNote: null, suspendedPermanent: false } });
  forgetCache(null, null);
  accessGuard.invalidate();
  if (!wasSuspended) return { userId: String(userId), email: user.email, emailed: false, wasBanned: false, wasSuspended: false };
  try {
    await require('./appealService').closeOpenAppeals(userId, user.email, 'The account was reinstated by an admin' + (text ? ': ' + text : '.'));
  } catch (err) { console.warn('could not close the appeals of ' + user.email + ':', err.message); }
  const emailed = await tellUser(user, 'reinstated', { message: text, wasBanned, at: new Date() });
  return { userId: String(userId), email: user.email, emailed, wasBanned, wasSuspended };
}

/**
 * Blocks an IP address (and optionally browsers).
 * The regular accounts seen on the address stay allowed (exempt) unless they are listed in suspendUserIds,
 * so a shared connection does not ban innocent people. Everyone else on that address is refused.
 */
async function createIpBlock({ ip, deviceIds, reason, note = '', days = 0, suspendUserIds = [], adminId }) {
  const address = normalizeIp(ip);
  const text = String(reason || '').trim();
  if (text.length < 3) throw fail('Write the reason - the person sees it when they try to sign in.');
  const nDays = Number(days) || 0;
  if (nDays < 0 || nDays > 365) throw fail('The block can last 1-365 days, or 0 for no end.');
  if (await IpBlock.exists({ ip: address, active: true })) throw fail('This IP is already blocked. Lift the old block first.', 409);

  const seen = await accountsSeenOnIp(address);
  const seenRegular = seen.filter((a) => a.role !== 'admin');
  const toSuspend = [...new Set((Array.isArray(suspendUserIds) ? suspendUserIds : []).map(String))];
  const exempt = seenRegular.map((a) => a.userId).filter((id) => !toSuspend.includes(id));

  const block = await IpBlock.create({
    ip: address, deviceIds: cleanDeviceIds(deviceIds), reason: text.slice(0, 500), note: String(note || '').slice(0, 1000),
    createdBy: adminId, expiresAt: nDays ? new Date(Date.now() + nDays * 24 * 60 * 60 * 1000) : null, exemptUserIds: exempt,
  });

  const suspended = [];
  for (const id of toSuspend) {
    try { await suspendUser({ userId: id, reason: text, note, adminId }); suspended.push(id); } catch (err) { if (err.statusCode !== 400 && err.statusCode !== 404) throw err; }
  }
  await IpBlock.updateOne({ _id: block._id }, { $set: { suspendedUserIds: suspended } });

  // Everyone who is signed in from this address right now and was not let through is signed out (they get the blocked screen).
  const exemptSet = new Set(exempt);
  const adminIds = new Set((await User.find({ role: 'admin' }, { _id: 1 }).lean()).map((u) => String(u._id)));
  const live = await Session.find({ ip: address, revokedAt: null }, { userId: 1 }).lean();
  const kick = [...new Set(live.map((s) => String(s.userId)))].filter((id) => !exemptSet.has(id) && !adminIds.has(id));
  for (const id of kick) await revokeSessions({ userId: id, ip: address }, 'ip-blocked');
  forgetCache(null, null);
  accessGuard.invalidate();

  return { block: serializeBlock({ ...block.toObject(), suspendedUserIds: suspended }), suspended: suspended.length, allowed: exempt.length, signedOut: kick.length };
}

async function liftIpBlock(id, { adminId, reinstate = false } = {}) {
  const block = await IpBlock.findOneAndUpdate({ _id: id, active: true }, { $set: { active: false, liftedAt: new Date(), liftedBy: adminId } }, { new: true }).lean();
  if (!block) throw fail('That block is not active any more.', 404);
  // A permanently banned account is refused here on purpose (it needs a message to the person), so it stays banned.
  if (reinstate) for (const userId of block.suspendedUserIds || []) await unsuspendUser(userId).catch(() => {});
  accessGuard.invalidate();
  return serializeBlock(block);
}

function serializeBlock(b) {
  return {
    id: String(b._id), ip: b.ip, deviceCount: (b.deviceIds || []).length, reason: b.reason, note: b.note || '',
    createdAt: b.createdAt, expiresAt: b.expiresAt || null, allowedAccounts: (b.exemptUserIds || []).length,
    suspendedAccounts: (b.suspendedUserIds || []).length, active: !!b.active,
  };
}

async function listBlocks() {
  const now = new Date();
  const rows = await IpBlock.find({ active: true, $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] }).sort({ createdAt: -1 }).limit(200).lean();
  return rows.map(serializeBlock);
}

module.exports = { normalizeIp, accountsSeenOnIp, loginHistory, suspendUser, unsuspendUser, createIpBlock, liftIpBlock, listBlocks, serializeBlock };
