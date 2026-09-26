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
 * Saved as a ticket for the admins (Admin -> Appeals, and Support, marked "Appeal"). The assistant never answers appeals.
 * A person who already has an open appeal adds to it instead of opening another one.
 * A permanently banned account cannot appeal: nothing is saved and the person is told so.
 */
router.post('/', appealLimiter, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const message = String(req.body?.message || '').trim();
  if (!EMAIL_REGEX.test(email)) return res.status(400).json({ success: false, error: 'Enter the email address of your ELMS account.' });
  if (message.length < 5 || message.length > 2000) return res.status(400).json({ success: false, error: 'Tell us what happened (5-2000 characters).' });

  const ip = clientIp(req);
  const user = await User.findOne({ email }, { _id: 1, name: 1, suspendedAt: 1, suspendedReason: 1, suspendedPermanent: 1 }).lean();
  if (user && user.suspendedAt && user.suspendedPermanent) {
    return res.status(403).json({ success: false, permanent: true, error: 'This account was permanently banned. Appeals cannot be sent for a permanent ban.' });
  }
  const body = message + '\n\n--\nSent from the blocked screen. IP: ' + (ip || 'unknown')
    + (user ? '' : '. No ELMS account has this email.')
    + (user && user.suspendedAt ? '\nAccount is suspended: ' + (user.suspendedReason || '') : '');

  // Someone who is still waiting for an answer adds to the same appeal, so the admin sees one row per person.
  let ticket = await SupportTicket.findOneAndUpdate(
    { source: 'appeal', status: 'open', fromEmail: email },
    { $push: { thread: { from: 'customer', text: body, at: new Date() } }, $set: { escalated: true } },
    { new: true }
  );
  const followUp = !!ticket;
  if (!ticket) {
    ticket = await SupportTicket.create({
      userId: user ? user._id : undefined,
      subject: 'Access appeal',
      message: body,
      source: 'appeal',
      fromEmail: email,
      fromName: user && user.name ? user.name : undefined,
      escalated: true,
      urgent: false,
      aiStatus: 'escalated',
      escalationReason: 'Appeal against a block or suspension.',
    });
  }
  try {
    const reason = followUp ? 'Another message on an open appeal.' : 'Appeal against a block or suspension.';
    await require('../services/supportAssistantService').alertAdmin(ticket.toObject(), { urgent: false, reason });
  } catch (_) { /* the ticket is saved either way */ }
  res.json({ success: true });
});

module.exports = router;
