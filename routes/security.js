const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/requireAuth');
const Session = require('../models/schemas/Session');
const LoginEvent = require('../models/schemas/LoginEvent');
const User = require('../models/schemas/User');
const { forgetCache, placeText, oneSessionPerDevice } = require('../services/sessionTracker');

router.use(requireAuth);

function serializeSession(s, currentSid) {
  return {
    id: String(s._id), current: s.sid === currentSid, device: s.browser + ' on ' + s.os, browser: s.browser, os: s.os, device_type: s.deviceType,
    ip: s.ip, location: placeText(s), method: s.method, signed_in_at: s.createdAt, last_active_at: s.lastSeenAt,
  };
}

/** GET /api/security/overview - devices signed in right now, recent login activity and the alert switch. */
router.get('/overview', async (req, res) => {
  const [sessions, events, user] = await Promise.all([
    Session.find({ userId: req.userId, revokedAt: null, expiresAt: { $gt: new Date() } }).sort({ lastSeenAt: -1 }).lean(),
    LoginEvent.find({ userId: req.userId }).sort({ createdAt: -1 }).limit(40).lean(),
    User.findById(req.userId, { notifyNewDevice: 1 }).lean(),
  ]);
  res.json({
    success: true,
    notifyNewDevice: user?.notifyNewDevice !== false,
    sessions: oneSessionPerDevice(sessions, req.sid).map((s) => serializeSession(s, req.sid)),
    activity: events.map((e) => ({
      id: String(e._id), success: e.success, method: e.method, device: (e.browser || 'Unknown browser') + ' on ' + (e.os || 'Unknown system'),
      device_type: e.deviceType, ip: e.ip, location: placeText(e), is_new_device: !!e.isNewDevice, created_at: e.createdAt, current: !!req.sid && e.sid === req.sid,
    })),
  });
});

router.put('/settings', async (req, res) => {
  await User.updateOne({ _id: req.userId }, { $set: { notifyNewDevice: !!req.body?.notifyNewDevice } });
  res.json({ success: true, notifyNewDevice: !!req.body?.notifyNewDevice });
});

async function revoke(filter, reason) {
  const rows = await Session.find({ ...filter, revokedAt: null }, { sid: 1, userId: 1 }).lean();
  if (!rows.length) return 0;
  await Session.updateMany({ _id: { $in: rows.map((r) => r._id) } }, { $set: { revokedAt: new Date(), revokedReason: reason } });
  rows.forEach((r) => forgetCache(r.sid, String(r.userId)));
  return rows.length;
}

/** DELETE /api/security/sessions/:id - log one device out. */
router.delete('/sessions/:id', async (req, res) => {
  const n = await revoke({ _id: req.params.id, userId: req.userId }, 'logged_out_by_user');
  if (!n) return res.status(404).json({ success: false, error: 'That device is already signed out.' });
  res.json({ success: true });
});

/** POST /api/security/revoke-others - log out every device except this one. */
router.post('/revoke-others', async (req, res) => {
  const filter = { userId: req.userId };
  if (req.sid) filter.sid = { $ne: req.sid };
  const n = await revoke(filter, 'logged_out_others');
  res.json({ success: true, loggedOut: n });
});

/** POST /api/security/logout - end this session (the Logout button). */
router.post('/logout', async (req, res) => {
  if (req.sid) await revoke({ sid: req.sid, userId: req.userId }, 'logout');
  res.json({ success: true });
});

/** POST /api/security/logout-everywhere - end every session including this one, and any token issued before now. */
router.post('/logout-everywhere', async (req, res) => {
  await User.updateOne({ _id: req.userId }, { $set: { sessionsValidFrom: new Date() } });
  const n = await revoke({ userId: req.userId }, 'logged_out_everywhere');
  forgetCache(null, req.userId);
  res.json({ success: true, loggedOut: n });
});

module.exports = router;
