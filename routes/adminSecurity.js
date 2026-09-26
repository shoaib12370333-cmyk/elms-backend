const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/requireAuth');
const { requireAdmin } = require('../middleware/requireAdmin');
const svc = require('../services/accessAdminService');
const AdminNotice = require('../models/schemas/AdminNotice');
const User = require('../models/schemas/User');
const { isValidObjectIdString } = require('../services/validationService');

router.use(requireAuth, requireAdmin);

const send = (res, err) => res.status(err.statusCode || 500).json({ success: false, error: err.statusCode ? err.message : 'Something went wrong.' });
const wrap = (fn) => async (req, res) => { try { await fn(req, res); } catch (err) { if (!err.statusCode) console.error('[admin-security]', err); send(res, err); } };
const problem = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const notFound = () => problem('Not found.', 404);

/** GET /api/admin/security/users/:id/logins - recent sign-ins of one account (IP, place, device). */
router.get('/users/:id/logins', wrap(async (req, res) => {
  if (!isValidObjectIdString(req.params.id)) throw notFound();
  res.json({ success: true, logins: await svc.loginHistory(req.params.id) });
}));

/** GET /api/admin/security/ip/:ip - who signed in from this address (to decide who is suspended and who is let through). */
router.get('/ip/:ip', wrap(async (req, res) => {
  const ip = svc.normalizeIp(req.params.ip);
  res.json({ success: true, ip, accounts: await svc.accountsSeenOnIp(ip) });
}));

router.get('/blocks', wrap(async (req, res) => res.json({ success: true, blocks: await svc.listBlocks() })));

/** POST /api/admin/security/blocks  { ip, reason, note?, days?, suspendUserIds?, deviceIds? } */
router.post('/blocks', wrap(async (req, res) => {
  const out = await svc.createIpBlock({ ...req.body, adminId: req.userId });
  res.json({ success: true, ...out });
}));

/** POST /api/admin/security/blocks/:id/lift  { reinstate? } */
router.post('/blocks/:id/lift', wrap(async (req, res) => {
  if (!isValidObjectIdString(req.params.id)) throw notFound();
  res.json({ success: true, block: await svc.liftIpBlock(req.params.id, { adminId: req.userId, reinstate: !!req.body?.reinstate }) });
}));

/**
 * POST /api/admin/security/users/:id/suspend  { reason, note?, permanent? }
 * permanent: true is a ban for good (no appeal). The person is told by mail either way; `emailed` says whether the mail was accepted.
 */
router.post('/users/:id/suspend', wrap(async (req, res) => {
  if (!isValidObjectIdString(req.params.id)) throw notFound();
  const out = await svc.suspendUser({ userId: req.params.id, reason: req.body?.reason, note: req.body?.note, adminId: req.userId, permanent: req.body?.permanent === true });
  res.json({ success: true, permanent: out.permanent, emailed: out.emailed });
}));

/**
 * POST /api/admin/security/users/:id/unsuspend  { message? }
 * Reinstates the account and mails the person. The message is required (10+ characters) to lift a permanent ban; it is optional for a suspension.
 */
router.post('/users/:id/unsuspend', wrap(async (req, res) => {
  if (!isValidObjectIdString(req.params.id)) throw notFound();
  const out = await svc.unsuspendUser(req.params.id, { message: req.body?.message });
  res.json({ success: true, emailed: out.emailed, wasBanned: out.wasBanned });
}));

/** GET /api/admin/security/appeals - every appeal (open first) with the state of the account it is about, and how many are open. */
router.get('/appeals', wrap(async (req, res) => {
  res.json({ success: true, ...(await require('../services/appealService').listAppeals()) });
}));

// ---------- messages that pop up on a user's screen ----------

/** GET /api/admin/security/notices - the latest messages sent, with how many people pressed OK. */
router.get('/notices', wrap(async (req, res) => {
  const rows = await AdminNotice.find().sort({ createdAt: -1 }).limit(50).populate('userId', 'email name').lean();
  res.json({
    success: true,
    notices: rows.map((n) => ({
      id: String(n._id), kind: n.kind, title: n.title, body: n.body, createdAt: n.createdAt, expiresAt: n.expiresAt || null,
      to: n.userId ? (n.userId.email || String(n.userId._id)) : 'Everyone', seenCount: (n.seenBy || []).length,
    })),
  });
}));

/** POST /api/admin/security/notices  { userId?: string|null (null = everyone), title, body, kind?, days? } */
router.post('/notices', wrap(async (req, res) => {
  const title = String(req.body?.title || '').trim();
  const body = String(req.body?.body || '').trim();
  if (title.length < 2 || title.length > 120) throw problem('The title needs 2-120 characters.');
  if (body.length < 2 || body.length > 2000) throw problem('The message needs 2-2000 characters.');
  const userId = req.body?.userId || null;
  if (userId && (!isValidObjectIdString(userId) || !(await User.exists({ _id: userId })))) throw problem('That user does not exist.', 404);
  const days = Number(req.body?.days) || 0;
  const notice = await AdminNotice.create({
    userId: userId || null,
    kind: ['message', 'offer', 'warning'].includes(req.body?.kind) ? req.body.kind : 'message',
    title,
    body,
    createdBy: req.userId,
    expiresAt: days > 0 && days <= 365 ? new Date(Date.now() + days * 24 * 60 * 60 * 1000) : null,
  });
  res.json({ success: true, id: String(notice._id) });
}));

/** DELETE /api/admin/security/notices/:id - recall a message. */
router.delete('/notices/:id', wrap(async (req, res) => {
  if (!isValidObjectIdString(req.params.id)) throw notFound();
  await AdminNotice.deleteOne({ _id: req.params.id });
  res.json({ success: true });
}));

module.exports = router;
