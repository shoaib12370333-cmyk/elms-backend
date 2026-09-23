const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const SupportTicket = require('../models/schemas/SupportTicket');
const User = require('../models/schemas/User');
const { clientIp } = require('../services/deviceInfoService');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const appealLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'You have sent several appeals in the last hour. Please wait, we will read them.' },
});

/**
 * POST /api/appeals   { email, message }      (no sign-in: a blocked person cannot sign in)
 * Saved as an urgent ticket for the admins (Admin -> Tickets, marked "Appeal"). The assistant never answers appeals.
 */
router.post('/', appealLimiter, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const message = String(req.body?.message || '').trim();
  if (!EMAIL_REGEX.test(email)) return res.status(400).json({ success: false, error: 'Enter the email address of your ELMS account.' });
  if (message.length < 5 || message.length > 2000) return res.status(400).json({ success: false, error: 'Tell us what happened (5-2000 characters).' });

  const ip = clientIp(req);
  const user = await User.findOne({ email }, { _id: 1, name: 1, suspendedAt: 1, suspendedReason: 1 }).lean();
  const ticket = await SupportTicket.create({
    userId: user ? user._id : undefined,
    subject: 'Access appeal',
    message: message + '\n\n--\nSent from the blocked screen. IP: ' + (ip || 'unknown')
      + (user ? '' : '. No ELMS account has this email.')
      + (user && user.suspendedAt ? '\nAccount is suspended: ' + (user.suspendedReason || '') : ''),
    source: 'appeal',
    fromEmail: email,
    fromName: user && user.name ? user.name : undefined,
    escalated: true,
    urgent: false,
    aiStatus: 'escalated',
    escalationReason: 'Appeal against a block or suspension.',
  });
  try {
    await require('../services/supportAssistantService').alertAdmin(ticket.toObject(), { urgent: false, reason: 'Appeal against a block or suspension.' });
  } catch (_) { /* the ticket is saved either way */ }
  res.json({ success: true });
});

module.exports = router;
