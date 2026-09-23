const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/requireAuth');
const { isValidObjectIdString } = require('../services/validationService');
const {
  createTicket,
  listTicketsForUser,
  getTicketForUser,
  addCustomerMessage,
  closeTicketByCustomer,
  countTicketsSince,
} = require('../models/supportTicketsModel');

const MAX_TICKETS_PER_HOUR = 10;

// The assistant is loaded lazily so a problem there can never stop tickets from being created.
const assistant = () => require('../services/supportAssistantService');

/** Runs the assistant on the newest customer message. Never throws: a failure just leaves the ticket for an admin. */
async function runAssistant(ticketId, opts) {
  try {
    await assistant().handleCustomerMessage(String(ticketId), opts);
  } catch (err) {
    console.warn('[support-ai] failed:', err.message);
  }
}

const badId = (res) => res.status(404).json({ success: false, error: 'Ticket not found.' });

/**
 * POST /api/support-tickets
 * Body: { subject: string, message: string }
 *
 * Opens a ticket. The support assistant answers it before this returns (the answer is in ticket.thread);
 * anything serious goes to an admin instead (see supportAssistantService).
 */
router.post('/', requireAuth, async (req, res) => {
  const subject = String(req.body?.subject || '').trim();
  const message = String(req.body?.message || '').trim();

  if (!subject || !message) {
    return res.status(400).json({ success: false, error: 'A subject and message are required.' });
  }
  if (subject.length > 140 || message.length > 4000) {
    return res.status(400).json({ success: false, error: 'The subject can be 140 characters and the message 4000.' });
  }
  if (await countTicketsSince(req.userId, new Date(Date.now() - 60 * 60 * 1000)) >= MAX_TICKETS_PER_HOUR) {
    return res.status(429).json({ success: false, error: 'You have opened several tickets in the last hour. Please continue in one of them.' });
  }

  const created = await createTicket(req.userId, { subject, message });
  await runAssistant(created.id);
  const ticket = (await getTicketForUser(req.userId, created.id)) || created;
  res.json({ success: true, ticket });
});

/**
 * GET /api/support-tickets
 * Returns the current user's own tickets (each with its whole conversation in `thread`).
 */
router.get('/', requireAuth, async (req, res) => {
  const tickets = await listTicketsForUser(req.userId);
  res.json({ success: true, tickets });
});

/**
 * POST /api/support-tickets/:id/messages
 * Body: { text: string }
 *
 * The customer writes again on their ticket. The assistant answers (or, for a serious topic or after
 * several tries, an admin is alerted). Returns the updated ticket.
 */
router.post('/:id/messages', requireAuth, async (req, res) => {
  if (!isValidObjectIdString(req.params.id)) return badId(res);
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ success: false, error: 'Write a message first.' });
  if (text.length > 4000) return res.status(400).json({ success: false, error: 'A message can be 4000 characters.' });

  const added = await addCustomerMessage(req.userId, req.params.id, text);
  if (added.error) return res.status(added.status || 400).json({ success: false, error: added.error });
  await runAssistant(req.params.id, { followUp: true });
  const ticket = (await getTicketForUser(req.userId, req.params.id)) || added.ticket;
  res.json({ success: true, ticket });
});

/**
 * POST /api/support-tickets/:id/close
 * The customer says it is solved. The ticket is closed; the conversation stays saved for the admin.
 */
router.post('/:id/close', requireAuth, async (req, res) => {
  if (!isValidObjectIdString(req.params.id)) return badId(res);
  const ticket = await closeTicketByCustomer(req.userId, req.params.id);
  if (!ticket) return badId(res);
  res.json({ success: true, ticket });
});

/**
 * POST /api/support-tickets/:id/escalate
 * The customer asks for a person ("Talk to admin"): the ticket is flagged and the admin is alerted.
 */
router.post('/:id/escalate', requireAuth, async (req, res) => {
  if (!isValidObjectIdString(req.params.id)) return badId(res);
  if (!(await getTicketForUser(req.userId, req.params.id))) return badId(res);
  try {
    await assistant().requestAdmin(req.params.id);
  } catch (err) {
    console.warn('[support-ai] escalate failed:', err.message);
    return res.status(500).json({ success: false, error: 'Could not reach the team right now. Please try again in a moment.' });
  }
  res.json({ success: true, ticket: await getTicketForUser(req.userId, req.params.id) });
});

module.exports = router;
