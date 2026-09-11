const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/requireAuth');
const { createTicket, listTicketsForUser } = require('../models/supportTicketsModel');

/**
 * POST /api/support-tickets
 * Requires a valid session token.
 * Body: { subject: string, message: string }
 *
 * Creates a support ticket for the current user (e.g. "I'm out of credits").
 */
router.post('/', requireAuth, async (req, res) => {
  const { subject, message } = req.body;

  if (!subject || !message) {
    return res.status(400).json({ success: false, error: 'A subject and message are required.' });
  }

  const ticket = await createTicket(req.userId, { subject, message });
  res.json({ success: true, ticket });
});

/**
 * GET /api/support-tickets
 * Requires a valid session token.
 *
 * Returns the current user's own tickets.
 */
router.get('/', requireAuth, async (req, res) => {
  const tickets = await listTicketsForUser(req.userId);
  res.json({ success: true, tickets });
});

module.exports = router;
