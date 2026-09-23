const axios = require('axios');
const { askClaude, aiConfigured } = require('./aiService');
const { ACTION_COSTS } = require('../config/actionCosts');

/**
 * AI-first support. When a customer writes to support (the in-app form or a mail to the support address) the
 * assistant answers first. Anything serious or that it cannot answer with confidence goes to an admin instead:
 * the ticket is flagged (urgent ones on top of Admin -> Tickets), the customer gets a short "a person will look
 * at this" note, and the admin is alerted by email (ADMIN_ALERT_EMAIL) and, optionally, by a webhook
 * (ADMIN_ALERT_WEBHOOK_URL) that can drive a phone push or call through Telegram / Slack / ntfy / Twilio.
 *
 * SUPPORT_AI_ENABLED=false turns the assistant off (tickets then wait for an admin as before).
 */

const MAX_AI_REPLIES = 4; // after that a customer who is still writing gets a person
const FOLLOW_UP_ALERT_GAP_MS = 10 * 60 * 1000; // a chatty customer on an escalated ticket alerts the admin at most this often

const HOLDING_REPLY = "Thanks for writing to us. This needs a person on our team, so I have passed it to an admin now. You will get their reply here as soon as they have looked at it.";

// Topics that always go to a person, whatever the AI would say: money, account access/security, legal,
// data, anger about being ignored, and asking for a human.
const SERIOUS = new RegExp(
  '\\b(' + [
    'refund(ed|s)?', 'charge ?back', 'dispute', 'double charge(d)?', 'charged (me )?(twice|two times|again)', 'money back',
    'payment', 'paid', 'paypal', 'billing', 'invoice',
    'credits? (are |is |were |got )?(missing|gone|not added|not received|deducted|lost)',
    'suspend(ed)?', 'banned?', 'restricted', 'hack(ed)?', 'stolen', 'fraud', 'scam(med)?', 'lawyer', 'legal', 'sue', 'police', 'court',
    'gdpr', 'privacy', 'data leak', 'delete my (account|data)', 'close my account', 'cancel my (account|subscription)',
    'unauthori[sz]ed', 'security', 'urgent(ly)?', 'asap', 'emergency',
    '(talk|speak|connect|chat|contact) (to|with) (an? )?(admin|human|real person|person|manager|agent|someone)',
    'real person', 'human (agent|support)', 'admin se baat', 'paisa', 'paise', 'dhoka', 'dhokha', 'jaldi', 'zaroori',
  ].join('|') + ')\\b',
  'i'
);

function enabled() {
  return aiConfigured() && String(process.env.SUPPORT_AI_ENABLED || '').toLowerCase() !== 'false';
}

function knowledgeBase() {
  const c = ACTION_COSTS;
  return [
    'ELMS is a tool that helps people sell products from Amazon on eBay (dropshipping). Website: elmstool.com.',
    'Import: paste an Amazon link on the Import page (or use the Chrome extension). The product becomes a draft under Drafts.',
    'Drafts: open a draft with Edit to change the title, price, category, description, photos and item specifics (the Item Specifications tab). "Publish" sends it to eBay; "Publish all" sends the selected ones.',
    'A failed listing shows its reason in red on the card; Retry publishes it again. eBay error 25001 is a temporary eBay-side error: wait a minute and press Retry.',
    'eBay needs the required item specifics of the category. In the editor, Item Specifications tab: fill the ones marked Required, or press "Fill with AI".',
    'If the seller\'s shipping policy uses calculated shipping, eBay needs a package weight: add a custom specification "Package Weight" (for example "1.5 lb").',
    'VeRO words are brand or character names that eBay removes listings for; ELMS marks them in red and "Remove with AI" takes them out.',
    'Connect an eBay account with the button in the left sidebar. Live listings, Orders and Messages appear after that.',
    'Credits pay for actions: Amazon import ' + c.AMAZON_IMPORT + ', publish ' + c.EBAY_PUBLISH + ', each AI action ' + c.AI_TITLE + ', a daily stock check ' + c.STOCK_MONITORING + ' per listing. Credits can be bought on the Plans / Credits page.',
    'After an update, press Cmd+Shift+R (Windows: Ctrl+Shift+R) to reload the newest version of the site.',
  ].join('\n');
}

function buildPrompt({ ticket, customerText, history, user }) {
  return [
    'You are the first-line support assistant of ELMS. Answer the customer using ONLY the knowledge below. Never invent features, prices, dates, policies or account facts.',
    'Reply in the same language the customer wrote (English, Urdu, Hinglish, ...). Be short, warm and concrete: give the steps.',
    'Decide:',
    '- "answer": the knowledge below really answers it.',
    '- "escalate": you are not sure, it needs a look at the customer\'s account or data, it is a bug you cannot fix with the steps above, or the customer is upset or repeats that it still does not work.',
    'Never promise refunds, credits, fixes or timelines. Never ask for passwords or card numbers.',
    'Reply with ONLY a JSON object: {"action":"answer"|"escalate","urgent":true|false,"reason":"one short sentence for the admin","reply":"the message to the customer"}.',
    'For "escalate", "reply" is a short note that a person will look at it (no attempt to solve it).',
    '',
    'Knowledge:',
    knowledgeBase(),
    '',
    user ? 'Customer: ' + (user.name || 'unknown') + ', credit balance ' + (user.creditBalance ?? 'unknown') + '.' : 'Customer: not an ELMS account holder (wrote by email).',
    'Ticket subject: ' + ticket.subject,
    history ? 'Earlier in this conversation:\n' + history : '',
    'Customer message:',
    String(customerText).slice(0, 4000),
  ].filter((x) => x !== '').join('\n');
}

function parseDecision(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  let parsed;
  try { parsed = JSON.parse(text.slice(start, end + 1)); } catch (_) { return null; }
  const reply = typeof parsed.reply === 'string' ? parsed.reply.trim() : '';
  if (!reply || !['answer', 'escalate'].includes(parsed.action)) return null;
  return { action: parsed.action, urgent: parsed.urgent === true, reason: String(parsed.reason || '').slice(0, 300), reply: reply.slice(0, 3000) };
}

async function ownerOf(ticket) {
  if (!ticket.userId) return null;
  const User = require('../models/schemas/User');
  return User.findById(ticket.userId).select('name email creditBalance').lean();
}

async function sendToCustomer(ticket, owner, reply, holding) {
  // A customer chatting inside the app sees the answer right there; only mail conversations are answered by mail.
  if (ticket.source !== 'email') return false;
  const to = ticket.fromEmail || (owner && owner.email) || null;
  if (!to) return false;
  try {
    await require('./emailService').sendTicketReplyEmail({ to, subject: ticket.subject, reply, ref: ticket.ref, inReplyTo: ticket.emailMessageId || undefined, ai: true, holding, viaEmail: ticket.source === 'email' });
    return true;
  } catch (err) {
    console.warn('[support-ai] could not email the customer:', err.message);
    return false;
  }
}

/** Tells the admin: email, plus a webhook when ADMIN_ALERT_WEBHOOK_URL is set. Best effort, never throws. */
async function alertAdmin(ticket, { urgent, reason, followUp }) {
  const who = ticket.fromName || ticket.fromEmail || 'a customer';
  const lines = [
    (urgent ? 'URGENT. ' : '') + (followUp ? 'The customer wrote again on a ticket that is waiting for you.' : 'A support ticket needs a person.'),
    'From: ' + who + (ticket.fromEmail ? ' <' + ticket.fromEmail + '>' : ''),
    'Subject: ' + ticket.subject,
    'Why: ' + (reason || 'needs a human'),
    '',
    String(ticket.message || '').slice(0, 800),
    '',
    'Answer it in the ELMS Admin panel -> Tickets.',
  ];
  const subject = (urgent ? 'URGENT support ticket: ' : 'Support ticket needs you: ') + ticket.subject;
  try { await require('./emailService').sendAdminAlert({ subject, lines }); } catch (err) { console.warn('[support-ai] admin email failed:', err.message); }
  try { await require('../models/schemas/SupportTicket').updateOne({ _id: ticket._id }, { $set: { lastAlertAt: new Date() } }); } catch (_) { /* only used to throttle */ }
  const hook = String(process.env.ADMIN_ALERT_WEBHOOK_URL || '').trim();
  if (hook) {
    const text = subject + '\n' + lines.slice(1, 4).join('\n');
    try { await axios.post(hook, { text, content: text, urgent: !!urgent, ticketId: String(ticket._id), subject: ticket.subject, reason }, { timeout: 8000 }); } catch (err) { console.warn('[support-ai] admin webhook failed:', err.message); }
  }
}

/**
 * Handles a customer message on a ticket (the first one, or a follow-up mail): answers it or escalates it.
 * @returns {Promise<{ action: 'answered'|'escalated'|'skipped', reason?: string }>}
 */
async function handleCustomerMessage(ticketId, { followUp = false } = {}) {
  const SupportTicket = require('../models/schemas/SupportTicket');
  const ticket = await SupportTicket.findById(ticketId).lean();
  if (!ticket) return { action: 'skipped', reason: 'missing' };

  if (ticket.escalated) {
    // A person already owns this ticket; a new customer message only re-alerts them (not more than every few minutes).
    const recentlyAlerted = ticket.lastAlertAt && Date.now() - new Date(ticket.lastAlertAt).getTime() < FOLLOW_UP_ALERT_GAP_MS;
    if (followUp && !recentlyAlerted) await alertAdmin(ticket, { urgent: ticket.urgent, reason: 'The customer replied.', followUp: true });
    return { action: 'skipped', reason: 'already_escalated' };
  }

  if (!enabled()) {
    // No assistant (switched off or no AI key): every ticket needs a person, so the admin is told instead of nothing happening.
    await SupportTicket.updateOne({ _id: ticket._id }, { $set: { escalated: true, urgent: false, escalationReason: 'The AI assistant is switched off or not configured, so this needs a person.' } });
    await alertAdmin(ticket, { urgent: false, reason: 'The AI assistant is switched off or not configured.' });
    return { action: 'skipped', reason: 'disabled' };
  }

  const thread = Array.isArray(ticket.thread) ? ticket.thread : [];
  const lastCustomer = [...thread].reverse().find((t) => t.from === 'customer');
  const customerText = followUp && lastCustomer ? lastCustomer.text : ticket.message;
  const aiReplies = thread.filter((t) => t.from === 'ai').length;
  const owner = await ownerOf(ticket);

  let decision;
  // On a follow-up only the new message counts (the subject was already judged when the ticket was opened).
  if (SERIOUS.test(followUp ? customerText : ticket.subject + ' ' + customerText)) {
    decision = { action: 'escalate', urgent: true, reason: 'Sensitive topic (money, account, legal, security or a request for a person).', reply: HOLDING_REPLY };
  } else if (aiReplies >= MAX_AI_REPLIES) {
    decision = { action: 'escalate', urgent: false, reason: 'The assistant already answered ' + aiReplies + ' times and the customer is still writing.', reply: HOLDING_REPLY };
  } else {
    try {
      const history = thread.filter((t) => t.from !== 'system').slice(-8).map((t) => (t.from === 'customer' ? 'Customer' : t.from === 'ai' ? 'Assistant' : 'Admin') + ': ' + String(t.text || '').slice(0, 500)).join('\n');
      const answer = await askClaude({ prompt: buildPrompt({ ticket, customerText, history, user: owner }), maxTokens: 700 });
      decision = parseDecision(answer.text) || { action: 'escalate', urgent: false, reason: 'The assistant\'s answer could not be read.', reply: HOLDING_REPLY };
    } catch (err) {
      console.warn('[support-ai] AI call failed:', err.message);
      decision = { action: 'escalate', urgent: false, reason: 'The AI was unavailable (' + err.message + ').', reply: HOLDING_REPLY, aiError: true };
    }
  }

  const escalate = decision.action === 'escalate';
  await SupportTicket.updateOne({ _id: ticket._id }, {
    $set: escalate
      ? { aiStatus: decision.aiError ? 'error' : 'escalated', escalated: true, urgent: !!decision.urgent, escalationReason: decision.reason }
      : { aiStatus: 'answered' },
    $push: { thread: { from: 'ai', text: decision.reply, at: new Date() } },
  });
  await sendToCustomer(ticket, owner, decision.reply, escalate);
  if (escalate) await alertAdmin(ticket, { urgent: decision.urgent, reason: decision.reason });
  return { action: escalate ? 'escalated' : 'answered' };
}

/** Runs the assistant in the background so the request that created the ticket is not slowed down. */
function kickAssistant(ticketId, opts) {
  setImmediate(() => {
    try {
      handleCustomerMessage(String(ticketId), opts).catch((err) => console.warn('[support-ai] failed:', err.message));
    } catch (err) {
      console.warn('[support-ai] failed:', err.message);
    }
  });
}

/**
 * The customer pressed "Talk to admin": the ticket goes to a person now (flagged, admin alerted).
 * @returns {Promise<boolean>} false when the ticket does not exist
 */
async function requestAdmin(ticketId) {
  const SupportTicket = require('../models/schemas/SupportTicket');
  const ticket = await SupportTicket.findById(ticketId).lean();
  if (!ticket) return false;
  if (ticket.escalated) {
    await SupportTicket.updateOne({ _id: ticket._id }, { $push: { thread: { from: 'system', text: 'The customer asked for an admin again.', at: new Date() } } });
    const recentlyAlerted = ticket.lastAlertAt && Date.now() - new Date(ticket.lastAlertAt).getTime() < FOLLOW_UP_ALERT_GAP_MS;
    if (!recentlyAlerted) await alertAdmin(ticket, { urgent: ticket.urgent, reason: 'The customer asked for an admin.', followUp: true });
    return true;
  }
  await SupportTicket.updateOne({ _id: ticket._id }, {
    $set: { aiStatus: 'escalated', escalated: true, urgent: false, escalationReason: 'The customer asked to talk to an admin.', status: 'open', resolvedAt: null },
    $push: { thread: { $each: [{ from: 'system', text: 'The customer asked to talk to an admin.', at: new Date() }, { from: 'ai', text: HOLDING_REPLY, at: new Date() }] } },
  });
  await alertAdmin(ticket, { urgent: false, reason: 'The customer asked to talk to an admin.' });
  return true;
}

module.exports = { requestAdmin, handleCustomerMessage, kickAssistant, SERIOUS, parseDecision, HOLDING_REPLY, MAX_AI_REPLIES };
