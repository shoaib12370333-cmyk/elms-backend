const IpBlock = require('../models/schemas/IpBlock');

/**
 * Decides whether a sign-in / a request is allowed:
 *  - a suspended ACCOUNT is refused everywhere, with the admin's reason;
 *  - a blocked IP (or a blocked browser id) refuses everyone EXCEPT admins and the accounts the admin let through
 *    (`exemptUserIds`). So regular users who only share the address are not affected.
 * Lookups are cached for a few seconds; the admin routes call invalidate() so a change takes effect at once.
 */

const CACHE_MS = 20 * 1000;
const cache = new Map();

const APPEAL_HINT = 'If you think this is a mistake, use the appeal form and tell us what happened.';

/** The browser id the site sends. The fallback ("ua-...") is shared by everyone with the same browser, never blocked on. */
function usableDeviceId(deviceId) {
  const id = String(deviceId || '').trim();
  return id && !id.startsWith('ua-') ? id : null;
}

/** The live block that matches this IP or browser, or null. */
async function findBlock({ ip, deviceId }) {
  const device = usableDeviceId(deviceId);
  if (!ip && !device) return null;
  const key = (ip || '') + '|' + (device || '');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.block;
  const now = new Date();
  const or = [];
  if (ip) or.push({ ip });
  if (device) or.push({ deviceIds: device });
  const block = await IpBlock.findOne({
    active: true,
    $and: [{ $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] }, { $or: or }],
  }).lean();
  cache.set(key, { at: Date.now(), block: block || null });
  if (cache.size > 5000) cache.clear();
  return block || null;
}

const sameId = (a, b) => String(a) === String(b);

/**
 * @param {{ user: { _id?, id?, role?, suspendedAt?, suspendedReason? }, ip?: string, deviceId?: string }} ctx
 * @returns {Promise<null | { kind: 'account'|'ip', reason: string }>} null = allowed
 */
async function checkAccess({ user, ip, deviceId }) {
  if (!user) return null;
  if (user.role === 'admin') return null; // an admin can never be locked out
  if (user.suspendedAt) {
    return { kind: 'account', reason: (user.suspendedReason || 'Your account has been suspended.') + ' ' + APPEAL_HINT };
  }
  const block = await findBlock({ ip, deviceId });
  if (!block) return null;
  const userId = user._id || user.id;
  if ((block.exemptUserIds || []).some((id) => sameId(id, userId))) return null;
  return { kind: 'ip', reason: (block.reason || 'Access from this network has been blocked.') + ' ' + APPEAL_HINT };
}

/** A new account (or a sign-in that would create one) from a blocked address / browser is refused: nobody new can be "let through". */
async function checkNewAccount({ ip, deviceId }) {
  const block = await findBlock({ ip, deviceId });
  if (!block) return null;
  return { kind: 'ip', reason: (block.reason || 'Access from this network has been blocked.') + ' ' + APPEAL_HINT };
}

/** The error the routes turn into a 403 with `blocked: { kind, reason }` so the site can show the blocked screen. */
function blockedError(access) {
  const err = new Error(access.reason);
  err.statusCode = 403;
  err.blocked = { kind: access.kind, reason: access.reason };
  return err;
}

function invalidate() {
  cache.clear();
}

module.exports = { checkAccess, checkNewAccount, blockedError, findBlock, invalidate, usableDeviceId };
