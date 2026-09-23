// AI-first support: simple questions are answered by the assistant; serious ones, unclear ones, AI failures and
// customers who keep writing go to an admin (flag + alert), and the customer gets a short holding note.
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

const cacheSet = (rel, exports) => { const p = require.resolve(rel); require(p); Object.assign(require.cache[p].exports, exports); };
cacheSet('../services/aiService', { askClaude: async () => { aiCalls += 1; if (aiFails) throw new Error('AI down'); return { text: aiAnswer }; } });
const stPath = require.resolve('../models/schemas/SupportTicket');
require.cache[stPath] = { id: stPath, filename: stPath, loaded: true, exports: {
  findById: (id) => ({ lean: async () => (tickets[id] ? JSON.parse(JSON.stringify(tickets[id])) : null) }),
  updateOne: async ({ _id }, update) => {
    const t = tickets[String(_id)];
    Object.assign(t, update.$set || {});
    if (update.$push && update.$push.thread) t.thread.push(update.$push.thread);
  },
} };
const userPath = require.resolve('../models/schemas/User');
require.cache[userPath] = { id: userPath, filename: userPath, loaded: true, exports: { findById: () => ({ select: () => ({ lean: async () => ({ name: 'Sam', email: 'sam@example.com', creditBalance: 5 }) }) }) } };
cacheSet('../services/emailService', {
  sendTicketReplyEmail: async (m) => { sentToCustomer.push(m); },
  sendAdminAlert: async (m) => { adminAlerts.push(m); },
});
const { handleCustomerMessage, SERIOUS, parseDecision } = require('../services/supportAssistantService');

const newTicket = (id, over = {}) => { tickets[id] = { _id: id, subject: 'Question', message: 'How do I publish?', source: 'app', userId: 'u1', thread: [], escalated: false, ref: 'abcd1234', ...over }; return id; };
const reset = () => { sentToCustomer.length = 0; adminAlerts.length = 0; aiCalls = 0; aiFails = false; };

(async () => {
  // the safety-net words
  for (const text of ['I want a refund', 'you charged me twice', 'my account got suspended', 'this is URGENT', 'please let me talk to an admin', 'credits missing after payment', 'mujhe paisa wapas chahiye']) assert.ok(SERIOUS.test(text), text);
  for (const text of ['How do I publish a draft?', 'Retry gives error 25001', 'How to connect my eBay store']) assert.ok(!SERIOUS.test(text), text);
  assert.strictEqual(parseDecision('nope'), null);
  assert.strictEqual(parseDecision('{"action":"maybe","reply":"x"}'), null);

  // 1. a simple question is answered by the AI and mailed to the customer; no admin alert
  reset(); aiAnswer = 'Here: {"action":"answer","urgent":false,"reason":"FAQ","reply":"Open the draft and press Publish."}';
  let out = await handleCustomerMessage(newTicket('t1'));
  assert.strictEqual(out.action, 'answered');
  assert.strictEqual(tickets.t1.aiStatus, 'answered');
  assert.strictEqual(tickets.t1.escalated, false);
  assert.deepStrictEqual(tickets.t1.thread.map((t) => t.from), ['ai']);
  assert.strictEqual(sentToCustomer.length, 1);
  assert.strictEqual(sentToCustomer[0].to, 'sam@example.com');
  assert.strictEqual(sentToCustomer[0].viaEmail, false);
  assert.strictEqual(adminAlerts.length, 0);

  // 2. a serious topic never reaches the AI: flagged urgent, holding note to the customer, admin alerted
  reset();
  out = await handleCustomerMessage(newTicket('t2', { subject: 'Refund', message: 'You charged me twice, I want my money back' }));
  assert.strictEqual(out.action, 'escalated');
  assert.strictEqual(aiCalls, 0);
  assert.strictEqual(tickets.t2.escalated, true);
  assert.strictEqual(tickets.t2.urgent, true);
  assert.strictEqual(sentToCustomer[0].holding, true);
  assert.strictEqual(adminAlerts.length, 1);
  assert.match(adminAlerts[0].subject, /URGENT/);

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

  // 5. a customer who keeps writing after two AI answers gets a person
  reset(); aiAnswer = '{"action":"answer","urgent":false,"reason":"","reply":"Try again."}';
  newTicket('t5', { source: 'email', fromEmail: 'x@example.com', userId: undefined, thread: [
    { from: 'ai', text: 'first' }, { from: 'customer', text: 'still broken' }, { from: 'ai', text: 'second' }, { from: 'customer', text: 'STILL broken' }] });
  out = await handleCustomerMessage('t5', { followUp: true });
  assert.strictEqual(out.action, 'escalated');
  assert.strictEqual(aiCalls, 0);
  assert.strictEqual(sentToCustomer[0].to, 'x@example.com');

  // 6. a new message on a ticket a person already owns only alerts the admin again
  reset();
  out = await handleCustomerMessage('t5', { followUp: true });
  assert.strictEqual(out.action, 'skipped');
  assert.strictEqual(sentToCustomer.length, 0);
  assert.strictEqual(adminAlerts.length, 1);
  assert.match(adminAlerts[0].lines.join(' '), /wrote again/);

  // 7. switched off -> nothing happens
  reset(); process.env.SUPPORT_AI_ENABLED = 'false';
  out = await handleCustomerMessage(newTicket('t7'));
  assert.deepStrictEqual(out, { action: 'skipped', reason: 'disabled' });
  assert.strictEqual(sentToCustomer.length + adminAlerts.length + aiCalls, 0);
  console.log('support assistant tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
