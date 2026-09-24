const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/requireAuth');
const { requireAdmin } = require('../middleware/requireAdmin');
const { isValidObjectIdString } = require('../services/validationService');
const { getPlanById } = require('../models/plansModel');
const users = require('../models/referralsModel'); // its user search / lookup by id
const model = require('../models/vouchersModel');
const vouchers = require('../services/voucherService');

// Every route in this file requires the user to be signed in AND an admin.
router.use(requireAuth, requireAdmin);

async function rowsFor(list) {
  const people = await users.getUsersByIds(list.map((v) => v.userId));
  const planNames = new Map();
  for (const id of new Set(list.map((v) => v.planId).filter(Boolean))) planNames.set(id, ((await getPlanById(id)) || {}).name || null);
  const now = Date.now();
  return list.map((v) => ({
    id: v.id,
    user: (people.get(v.userId) || {}).email || null,
    userId: v.userId,
    kind: v.kind,
    description: vouchers.describe(v, planNames.get(v.planId)),
    note: v.note,
    state: vouchers.stateOf(v, now),
    expiresAt: v.expiresAt,
    usedAt: v.usedAt,
    usedFor: v.usedFor,
    createdAt: v.createdAt,
  }));
}

/**
 * GET /api/admin/vouchers?status=active|used|revoked&kind=&q=email
 * Every voucher given (newest 200), with the counts.
 */
router.get('/', async (req, res) => {
  try {
    let userIds;
    const q = String(req.query.q || '').trim();
    if (q) userIds = (await users.searchUsers(q, 25)).map((u) => u.id);
    const [list, counts] = await Promise.all([model.adminList({ status: req.query.status, kind: req.query.kind, userIds }), model.adminCounts()]);
    res.json({ success: true, counts, vouchers: await rowsFor(list) });
  } catch (err) {
    console.error('admin vouchers list error:', err.message);
    res.status(500).json({ success: false, error: 'Could not load the vouchers.' });
  }
});

/** GET /api/admin/vouchers/users?q=  - find the person to give a voucher to (email, name or username). */
router.get('/users', async (req, res) => {
  const found = await users.searchUsers(req.query.q, 8);
  res.json({ success: true, users: found.map((u) => ({ id: u.id, email: u.email, name: u.name || u.username || null })) });
});

/**
 * POST /api/admin/vouchers
 * Body: { userId, kind: purchase_discount|credits|free_plan|ebay_accounts,
 *         percent | amountUsd (purchase_discount), planId (free_plan; optional for purchase_discount),
 *         credits, ebayAccounts, expiresInDays?, note? }
 * Gives the voucher to that user (who is told by email).
 */
router.post('/', async (req, res) => {
  const body = req.body || {};
  if (!isValidObjectIdString(String(body.userId || ''))) return res.status(400).json({ success: false, error: 'Choose the user first.' });
  try {
    const user = await users.getUser(body.userId);
    if (!user) return res.status(404).json({ success: false, error: 'User not found.' });
    const voucher = await vouchers.giveVoucher({ adminId: req.userId, user, input: body });
    const [row] = await rowsFor([voucher]);
    res.json({ success: true, voucher: row });
  } catch (err) {
    if (err.userFacing) return res.status(err.statusCode).json({ success: false, error: err.message });
    console.error('admin voucher create error:', err.message);
    res.status(500).json({ success: false, error: 'Could not create the voucher.' });
  }
});

/** POST /api/admin/vouchers/:id/revoke  - takes back an unused voucher. */
router.post('/:id/revoke', async (req, res) => {
  if (!isValidObjectIdString(req.params.id)) return res.status(404).json({ success: false, error: 'Voucher not found.' });
  const done = await model.revoke(req.params.id);
  if (!done) return res.status(409).json({ success: false, error: 'Only a voucher that is still unused can be taken back.' });
  const [row] = await rowsFor([done]);
  res.json({ success: true, voucher: row });
});

module.exports = router;
