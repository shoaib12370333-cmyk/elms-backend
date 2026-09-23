const crypto = require('crypto');
const Session = require('../models/schemas/Session');
const LoginEvent = require('../models/schemas/LoginEvent');
const User = require('../models/schemas/User');
const { parseUserAgent, clientIp, lookupLocation } = require('./deviceInfoService');
const { SESSION_TTL_MS } = require('./sessionService');
const { createSystemNotification } = require('../models/systemNotificationsModel');
const accessGuard = require('./accessGuard');

function deviceIdOf(req) {
  const raw = String(req.headers['x-device-id'] || '').trim();
  if (/^[a-zA-Z0-9-]{8,64}$/.test(raw)) return raw;
  // No id from the browser: fall back to a hash of what we can see, so the same browser still matches.
  return 'ua-' + crypto.createHash('sha256').update(String(req.headers['user-agent'] || '')).digest('hex').slice(0, 24);
}

function placeText(e) {
  return [e.city, e.region, e.country].filter(Boolean).join(', ') || 'Unknown location';
}

/**
 * Records a successful sign-in and starts a session. Returns the sid to put in the token.
 * A device the account has never signed in from (once it has signed in before) raises a new-device alert.
 */
async function startSession(req, userId, method = 'password') {
  const info = parseUserAgent(req.headers['user-agent']);
  const ip = clientIp(req);
  const deviceId = deviceIdOf(req);
  // A suspended account, or a blocked address / browser, gets no session (admins and accounts the admin let through do).
  const who = await User.findById(userId, { role: 1, suspendedAt: 1, suspendedReason: 1 }).lean();
  const denied = await accessGuard.checkAccess({ user: who, ip, deviceId });
  if (denied) throw accessGuard.blockedError(denied);
  const sid = crypto.randomUUID();
  const [hadAny, knownDevice] = await Promise.all([
    LoginEvent.exists({ userId, success: true }),
    LoginEvent.exists({ userId, success: true, deviceId }),
  ]);
  const isNewDevice = !!hadAny && !knownDevice;
  await Promise.all([
    Session.create({ userId, sid, deviceId, ...info, ip, method, expiresAt: new Date(Date.now() + SESSION_TTL_MS) }),
    LoginEvent.create({ userId, success: true, method, deviceId, ...info, ip, isNewDevice, sid }),
  ]);
  // Place lookup and the alert happen after the response, so signing in is never slowed down by them.
  finishSignIn({ userId, sid, ip, info, method, isNewDevice }).catch((e) => console.warn('[security] ' + e.message));
  return sid;
}

async function finishSignIn({ userId, sid, ip, info, method, isNewDevice }) {
  const loc = await lookupLocation(ip);
  await Promise.all([
    Session.updateOne({ sid }, { $set: { city: loc.city, region: loc.region, country: loc.country } }),
    LoginEvent.updateOne({ sid }, { $set: { city: loc.city, region: loc.region, country: loc.country } }),
  ]);
  if (!isNewDevice) return;
  const user = await User.findById(userId, { email: 1, notifyNewDevice: 1 }).lean();
  const device = info.browser + ' on ' + info.os;
  const where = placeText(loc) + (ip ? ' (' + ip + ')' : '');
  await createSystemNotification(userId, {
    type: 'security', level: 'warning', title: 'New device signed in',
    message: device + ' from ' + where + '. If this was not you, open Settings \u2192 Security and log out everywhere, then change your password.',
    metadata: { sid, device, where, method },
  }).catch(() => {});
  if (user?.email && user.notifyNewDevice !== false) {
    require('./emailService').sendNewDeviceEmail({ to: user.email, device, where, method, when: new Date() })
      .catch((e) => console.error('new-device email failed:', e.message));
  }
}

/** A wrong password on a real account is part of the login activity too. */
async function recordFailedLogin(req, email) {
  try {
    const user = await User.findOne({ email: String(email || '').trim().toLowerCase() }, { _id: 1 }).lean();
    if (!user) return;
    const info = parseUserAgent(req.headers['user-agent']);
    const ip = clientIp(req);
    const ev = await LoginEvent.create({ userId: user._id, success: false, method: 'password', deviceId: deviceIdOf(req), ...info, ip });
    lookupLocation(ip).then((loc) => LoginEvent.updateOne({ _id: ev._id }, { $set: { city: loc.city, region: loc.region, country: loc.country } })).catch(() => {});
  } catch (_) { /* never block the login response */ }
}

// ---- checking a token on every request (cached for a few seconds)
const cache = new Map();
const CACHE_MS = 15000;
const TOUCH_MS = 5 * 60 * 1000;

/** What the guard needs to know about a request. */
function requestContext(req) {
  return { ip: clientIp(req), deviceId: deviceIdOf(req) };
}

async function assertSessionActive({ userId, sid, iat }, ctx = null) {
  const key = sid || 'legacy:' + userId;
  let entry = cache.get(key);
  if (!entry || Date.now() - entry.at > CACHE_MS) {
    const [user, session] = await Promise.all([
      User.findById(userId, { sessionsValidFrom: 1, role: 1, suspendedAt: 1, suspendedReason: 1 }).lean(),
      sid ? Session.findOne({ sid }, { revokedAt: 1, lastSeenAt: 1 }).lean() : null,
    ]);
    entry = { at: Date.now(), user, session, touched: entry?.touched || 0 };
    cache.set(key, entry);
    if (cache.size > 5000) cache.clear();
  }
  if (!entry.user) return fail();
  const from = entry.user.sessionsValidFrom ? new Date(entry.user.sessionsValidFrom).getTime() : 0;
  if (from && (iat + 1) * 1000 <= from) return fail();
  if (sid && (!entry.session || entry.session.revokedAt)) return fail();
  // Suspended account / blocked address: every request is refused, whatever session it uses (the extension included).
  if (ctx) {
    const denied = await accessGuard.checkAccess({ user: { ...entry.user, _id: userId }, ip: ctx.ip, deviceId: ctx.deviceId });
    if (denied) throw accessGuard.blockedError(denied);
  }
  if (sid && Date.now() - entry.touched > TOUCH_MS) {
    entry.touched = Date.now();
    Session.updateOne({ sid }, { $set: { lastSeenAt: new Date() } }).catch(() => {});
  }
}
function fail() {
  const err = new Error('You were signed out of this device. Please sign in again.');
  err.statusCode = 401;
  throw err;
}
function forgetCache(sidOrNull, userId) {
  if (sidOrNull) cache.delete(sidOrNull);
  if (userId) cache.delete('legacy:' + userId);
  if (!sidOrNull) cache.clear();
}

module.exports = { startSession, recordFailedLogin, assertSessionActive, requestContext, forgetCache, placeText };
