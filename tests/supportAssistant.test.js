// AI-first support: simple questions are answered by the assistant; serious ones, unclear ones, AI failures and
// customers who keep writing go to an admin (flag + alert), and the customer gets a short holding note.
// The customer can also ask for an admin at any time ("Talk to admin").
const assert = require('assert');
process.env.ANTHROPIC_API_KEY = 'test';
delete process.env.SUPPORT_AI_ENABLED;
delete process.env.ADMIN_ALERT_WEBHOOK_URL;

const tickets = {};
const sentToCustomer = [];
const adminAlerts = [];
let aiCalls = 0;
let aiAnswer = '';
let aiFails = false;
let lastPrompt = '';

const cacheSet = (rel, exports) => { const p = require.resolve(rel); require(p); Object.assign(require.cache[p].exports, exports); };
cacheSet('../services/aiService', { askClaude: async ({ prompt }) => { aiCalls += 1; lastPrompt = prompt; if (aiFails) throw new Error('AI down'); return { text: aiAnswer }; } });
const stPath = require.resolve('../models/schemas/SupportTicket');
require.cache[stPath] = { id: stPath, filename: stPath, loaded: true, exports: {
  findById: (id) => ({ lean: async () => (tickets[id] ? JSON.parse(JSON.stringify(tickets[id])) : null) }),
  updateOne: async ({ _id }, update) => {
    const t = tickets[String(_id)];
    Object.assign(t, update.$set || {});
    const push = update.$push && update.$push.thread;
    if (push) (push.$each || [push]).forEach((entry) => t.thread.push(entry));
  },
} };
const userPath = require.resolve('../models/schemas/User');
require.cache[userPath] = { id: userPath, filename: userPath, loaded: true, exports: { findById: () => ({ select: () => ({ lean: async () => ({ name: 'Sam', email: 'sam@example.com', creditBalance: 5 }) }) }) } };
cacheSet('../services/emailService', {
  sendTicketReplyEmail: async (m) => { sentToCustomer.push(m); },
  sendAdminAlert: async (m) => { adminAlerts.push(m); },
});
const { handleCustomerMessage, requestAdmin, SERIOUS, parseDecision, MAX_AI_REPLIES } = require('../services/supportAssistantService');

const newTicket = (id, over = {}) => { tickets[id] = { _id: id, subject: 'Question', message: 'How do I publish?', source: 'app', userId: 'u1', thread: [], escalated: false, ref: 'abcd1234', ...over }; return id; };
const reset = () => { sentToCustomer.length = 0; adminAlerts.length = 0; aiCalls = 0; aiFails = false; };
const fromList = (id) => tickets[id].thread.map((t) => t.from);

(async () => {
  // the safety-net words
  for (const text of ['I want a refund', 'you charged me twice', 'my account got suspended', 'this is URGENT', 'please let me talk to an admin', 'credits missing after payment', 'mujhe paisa wapas chahiye']) assert.ok(SERIOUS.test(text), text);
  for (const text of ['How do I publish a draft?', 'Retry gives error 25001', 'How to connect my eBay store', 'thanks, that worked']) assert.ok(!SERIOUS.test(text), text);
  assert.strictEqual(parseDecision('nope'), null);
  assert.strictEqual(parseDecision('{"action":"maybe","reply":"x"}'), null);
  assert.strictEqual(MAX_AI_REPLIES, 4);

  // 1. a simple question is answered by the AI inside the app (no mail for an in-app chat); no admin alert
  reset(); aiAnswer = 'Here: {"action":"answer","urgent":false,"reason":"FAQ","reply":"Open the draft and press Publish."}';
  let out = await handleCustomerMessage(newTicket('t1'));
  assert.strictEqual(out.action, 'answered');
  assert.strictEqual(tickets.t1.aiStatus, 'answered');
  assert.strictEqual(tickets.t1.escalated, false);
  assert.deepStrictEqual(fromList('t1'), ['ai']);
  assert.strictEqual(sentToCustomer.length, 0);
  assert.strictEqual(adminAlerts.length, 0);

  // 1b. a mail conversation is answered by mail
  reset();
  out = await handleCustomerMessage(newTicket('t1b', { source: 'email', fromEmail: 'x@example.com', userId: undefined }));
  assert.strictEqual(out.action, 'answered');
  assert.strictEqual(sentToCustomer.length, 1);
  assert.strictEqual(sentToCustomer[0].to, 'x@example.com');
  assert.strictEqual(sentToCustomer[0].viaEmail, true);

  // 1c. a follow-up in the chat: the AI sees the conversation, and system notes are not part of it
  reset(); aiAnswer = '{"action":"answer","urgent":false,"reason":"","reply":"Press Retry."}';
  newTicket('t1c', { thread: [{ from: 'ai', text: 'Open the draft.' }, { from: 'system', text: 'internal note' }, { from: 'customer', text: 'It shows error 25001 now' }] });
  out = await handleCustomerMessage('t1c', { followUp: true });
  assert.strictEqual(out.action, 'answered');
  assert.match(lastPrompt, /Assistant: Open the draft/);
  assert.match(lastPrompt, /It shows error 25001 now/);
  assert.doesNotMatch(lastPrompt, /internal note/);

  // 2. a serious topic never reaches the AI: flagged urgent, holding note, admin alerted
  reset();
  out = await handleCustomerMessage(newTicket('t2', { subject: 'Refund', message: 'You charged me twice, I want my money back' }));
  assert.strictEqual(out.action, 'escalated');
  assert.strictEqual(aiCalls, 0);
  assert.strictEqual(tickets.t2.escalated, true);
  assert.strictEqual(tickets.t2.urgent, true);
  assert.strictEqual(adminAlerts.length, 1);
  assert.match(adminAlerts[0].subject, /URGENT/);

  // 2b. typing "talk to admin" in the chat escalates right away
  reset();
  newTicket('t2b', { thread: [{ from: 'ai', text: 'Try this.' }, { from: 'customer', text: 'not solved, talk to admin please' }] });
  out = await handleCustomerMessage('t2b', { followUp: true });
  assert.strictEqual(out.action, 'escalated');
  assert.strictEqual(aiCalls, 0);
  assert.strictEqual(adminAlerts.length, 1);

  // 2c. on a follow-up only the new message counts, not the old subject
  reset(); aiAnswer = '{"action":"answer","urgent":false,"reason":"","reply":"Sure."}';
  newTicket('t2c', { subject: 'Refund question earlier', thread: [{ from: 'customer', text: 'how do I connect my store' }] });
  out = await handleCustomerMessage('t2c', { followUp: true });
  assert.strictEqual(out.action, 'answered');

  // 3. the AI itself says escalate -> flagged (not urgent) and alerted
  reset(); aiAnswer = '{"action":"escalate","urgent":false,"reason":"Needs account access","reply":"A person will look."}';
  out = await handleCustomerMessage(newTicket('t3', { message: 'My listings vanished from my account' }));
  assert.strictEqual(out.action, 'escalated');
  assert.strictEqual(tickets.t3.urgent, false);
  assert.strictEqual(tickets.t3.escalationReason, 'Needs account access');
  assert.strictEqual(adminAlerts.length, 1);
  assert.doesNotMatch(adminAlerts[0].subject, /URGENT/);

  // 4. the AI is down or answers nonsense -> the ticket still reaches a person
  reset(); aiFails = true;
  out = await handleCustomerMessage(newTicket('t4'));
  assert.strictEqual(out.action, 'escalated');
  assert.strictEqual(tickets.t4.aiStatus, 'error');
  assert.strictEqual(adminAlerts.length, 1);
  reset(); aiAnswer = 'I cannot help';
  out = await handleCustomerMessage(newTicket('t4b'));
  assert.strictEqual(out.action, 'escalated');

  // 5. a customer who keeps writing after four AI answers gets a person
  reset(); aiAnswer = '{"action":"answer","urgent":false,"reason":"","reply":"Try again."}';
  const busy = [];
  for (let i = 0; i < MAX_AI_REPLIES; i += 1) busy.push({ from: 'ai', text: 'answer ' + i }, { from: 'customer', text: 'still broken ' + i });
  newTicket('t5', { thread: busy });
  out = await handleCustomerMessage('t5', { followUp: true });
  assert.strictEqual(out.action, 'escalated');
  assert.strictEqual(aiCalls, 0);
  assert.strictEqual(adminAlerts.length, 1);

  // 6. more messages on a ticket a person already owns only re-alert the admin, and not more often than every 10 minutes
  reset();
  out = await handleCustomerMessage('t5', { followUp: true });
  assert.strictEqual(out.action, 'skipped');
  assert.strictEqual(adminAlerts.length, 0, 'alerted a moment ago, so no second mail');
  assert.ok(tickets.t5.lastAlertAt);
  tickets.t5.lastAlertAt = new Date(Date.now() - 11 * 60 * 1000).toISOString();
  out = await handleCustomerMessage('t5', { followUp: true });
  assert.strictEqual(adminAlerts.length, 1);
  assert.match(adminAlerts[0].lines.join(' '), /wrote again/);

  // 7. "Talk to admin" button: flagged, a note in the conversation, admin alerted once
  reset();
  newTicket('t7', { thread: [{ from: 'ai', text: 'Try this.' }] });
  assert.strictEqual(await requestAdmin('t7'), true);
  assert.strictEqual(tickets.t7.escalated, true);
  assert.strictEqual(tickets.t7.urgent, false);
  assert.deepStrictEqual(fromList('t7'), ['ai', 'system', 'ai']);
  assert.strictEqual(adminAlerts.length, 1);
  assert.strictEqual(await requestAdmin('t7'), true);
  assert.strictEqual(adminAlerts.length, 1, 'a second press does not mail again');
  assert.strictEqual(await requestAdmin('nope'), false);

  // 8. no AI (switched off or no key): the admin is told instead of nothing happening
  reset(); process.env.SUPPORT_AI_ENABLED = 'false';
  out = await handleCustomerMessage(newTicket('t8'));
  assert.deepStrictEqual(out, { action: 'skipped', reason: 'disabled' });
  assert.strictEqual(aiCalls, 0);
  assert.strictEqual(tickets.t8.escalated, true);
  assert.strictEqual(adminAlerts.length, 1);
  assert.strictEqual(sentToCustomer.length, 0);
  console.log('support assistant tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
