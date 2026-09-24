// An admin can answer inside the ticket and keep talking; the pending request clears when the admin answers, resolves it or the
// customer closes it, comes back when the customer writes again, and the assistant stays out while an admin is in the conversation.
const assert = require('assert');
process.env.ANTHROPIC_API_KEY = 'test';
delete process.env.SUPPORT_AI_ENABLED;
delete process.env.ADMIN_ALERT_WEBHOOK_URL;

const tickets = {};
const mails = [];
const adminAlerts = [];
let aiCalls = 0;

const cacheSet = (rel, exports) => { const p = require.resolve(rel); require(p); Object.assign(require.cache[p].exports, exports); };
cacheSet('../services/aiService', { askClaude: async () => { aiCalls += 1; return { text: '{"action":"answer","urgent":false,"reason":"FAQ","reply":"Press Retry."}' }; } });
cacheSet('../services/emailService', { sendTicketReplyEmail: async (m) => { mails.push(m); }, sendAdminAlert: async (m) => { adminAlerts.push(m); } });
cacheSet('../models/usersModel', { getUserById: async () => ({ id: 'u1', email: 'sam@example.com' }) });

// an in-memory SupportTicket: enough of the mongoose surface for the model, the assistant and the routes
const apply = (t, update) => {
  Object.assign(t, update.$set || {});
  const push = update.$push && update.$push.thread;
  if (push) (push.$each || [push]).forEach((entry) => t.thread.push(entry));
  // mongoose treats fields without an operator as $set
  Object.assign(t, Object.fromEntries(Object.entries(update).filter(([k]) => !k.startsWith('$'))));
};
const asDoc = (t) => (t ? { toObject: () => JSON.parse(JSON.stringify({ ...t, _id: { toString: () => t._id } })) , ...t } : null);
const stPath = require.resolve('../models/schemas/SupportTicket');
require.cache[stPath] = { id: stPath, filename: stPath, loaded: true, exports: {
  findById: (id) => ({ lean: async () => (tickets[id] ? JSON.parse(JSON.stringify(tickets[id])) : null) }),
  findOne: async ({ _id }) => asDoc(tickets[_id]),
  findByIdAndUpdate: async (id, update) => { const t = tickets[id]; if (!t) return null; apply(t, update); return asDoc(t); },
  findOneAndUpdate: async ({ _id, status }, update) => { const t = tickets[_id]; if (!t || (status && status.$ne && t.status === status.$ne)) return null; apply(t, update); return asDoc(t); },
  updateOne: async ({ _id }, update) => { apply(tickets[String(_id)], update); },
} };
const userPath = require.resolve('../models/schemas/User');
require.cache[userPath] = { id: userPath, filename: userPath, loaded: true, exports: { findById: () => ({ select: () => ({ lean: async () => ({ name: 'Sam', email: 'sam@example.com', creditBalance: 5 }) }) }) } };

const model = require('../models/supportTicketsModel');
const assistant = require('../services/supportAssistantService');
const admin = require('../routes/admin');

const ID = '64b7f0c2a1b2c3d4e5f60718';
const fresh = (over = {}) => { tickets[ID] = { _id: ID, subject: 'Refund please', message: 'I was charged twice', source: 'app', userId: 'u1', status: 'open', thread: [], escalated: false, adminEngaged: false, urgent: false, ref: 'abcd1234', ...over }; mails.length = 0; adminAlerts.length = 0; aiCalls = 0; return tickets[ID]; };
const routeHandler = (method, path) => { const l = admin.stack.find((x) => x.route && x.route.path === path && x.route.methods[method]); assert.ok(l, method + ' ' + path); return l.route.stack[l.route.stack.length - 1].handle; };
const call = async (path, req) => { const res = { statusCode: 200 }; res.status = (c) => { res.statusCode = c; return res; }; res.json = (b) => { res.body = b; return res; }; await routeHandler('post', path)({ params: {}, body: {}, ...req }, res); return res; };

(async () => {
  // ---- 1. a serious ticket is pending for the admin; the admin answers and it is not pending any more ----
  let t = fresh({ escalated: true, urgent: true, escalationReason: 'Sensitive topic', aiStatus: 'escalated' });
  let out = await model.adminReplyToTicket(ID, 'Hi Sam, I am checking the payment now.');
  assert.strictEqual(out.status, 'open', 'answering does not close it');
  assert.deepStrictEqual([out.escalated, out.urgent, out.adminEngaged], [false, false, true], 'the request is cleared, an admin is in the conversation');
  assert.deepStrictEqual(t.thread.map((m) => m.from), ['admin']);
  assert.strictEqual(await model.adminReplyToTicket(ID, '   '), null, 'an empty answer is not sent');
  assert.strictEqual(await model.adminReplyToTicket('missing', 'hello'), null);

  // ---- 2. the customer writes back: pending again, the admin is told at once, the assistant stays out ----
  t.lastAlertAt = new Date(); // an alert went out a moment ago: this one is not held back
  t.thread.push({ from: 'customer', text: 'Thanks, any news?' });
  out = await assistant.handleCustomerMessage(ID, { followUp: true });
  assert.deepStrictEqual([out.action, out.reason], ['skipped', 'admin_engaged']);
  assert.strictEqual(aiCalls, 0, 'the assistant does not step in while an admin is in the conversation');
  assert.deepStrictEqual([t.escalated, t.adminEngaged], [true, true]);
  assert.strictEqual(adminAlerts.length, 1);
  assert.ok(adminAlerts[0].lines[0].includes('wrote again'));

  // a second message while it is pending re-alerts only after a while (as before)
  t.thread.push({ from: 'customer', text: 'hello?' });
  out = await assistant.handleCustomerMessage(ID, { followUp: true });
  assert.strictEqual(out.reason, 'already_escalated');
  assert.strictEqual(adminAlerts.length, 1);

  // ---- 3. the admin answers again: pending cleared again ----
  out = await model.adminReplyToTicket(ID, 'Refund done.');
  assert.strictEqual(out.escalated, false);

  // "Talk to admin" after an admin answered: pending again, with an alert
  assert.strictEqual(await assistant.requestAdmin(ID), true);
  assert.strictEqual(t.escalated, true);
  assert.strictEqual(adminAlerts.length, 2);
  assert.ok(t.thread.some((m) => m.from === 'system' && /asked for an admin again/.test(m.text)));

  // ---- 4. resolving clears everything; the next message starts fresh (the assistant answers first) ----
  out = await model.resolveTicket(ID, 'All sorted.');
  assert.deepStrictEqual([out.status, out.escalated, out.urgent, out.adminEngaged], ['resolved', false, false, false]);
  t.status = 'open'; // the customer writes again (the model reopens it)
  t.thread.push({ from: 'customer', text: 'How do I publish a draft?' });
  t.subject = 'Question'; t.message = 'How do I publish a draft?';
  out = await assistant.handleCustomerMessage(ID, { followUp: true });
  assert.strictEqual(out.action, 'answered', 'the assistant is back');
  assert.strictEqual(aiCalls, 1);

  // ---- 5. the customer closes it as solved: nothing pending, no admin engaged ----
  t = fresh({ escalated: true, urgent: true, adminEngaged: true });
  out = await model.closeTicketByCustomer('u1', ID);
  assert.deepStrictEqual([out.status, out.escalated, out.urgent, out.adminEngaged], ['resolved', false, false, false]);

  // ---- 6. the admin route ----
  t = fresh({ source: 'email', fromEmail: 'buyer@example.com', userId: undefined, escalated: true });
  let res = await call('/tickets/:id/reply', { params: { id: ID }, body: { reply: '  We are on it.  ' } });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual([res.body.ticket.status, res.body.ticket.escalated, res.body.ticket.adminEngaged, res.body.emailed], ['open', false, true, true]);
  assert.strictEqual(mails.length, 1);
  assert.strictEqual(mails[0].to, 'buyer@example.com');
  assert.strictEqual(mails[0].reply, 'We are on it.');
  assert.strictEqual(t.thread[t.thread.length - 1].text, 'We are on it.');

  // an in-app ticket is mailed to the account's address
  t = fresh({ escalated: true });
  res = await call('/tickets/:id/reply', { params: { id: ID }, body: { reply: 'Checking.' } });
  assert.strictEqual(res.body.emailed, true);
  assert.strictEqual(mails[0].to, 'sam@example.com');

  res = await call('/tickets/:id/reply', { params: { id: ID }, body: { reply: '   ' } });
  assert.strictEqual(res.statusCode, 400);
  res = await call('/tickets/:id/reply', { params: { id: ID }, body: { reply: 'x'.repeat(4001) } });
  assert.strictEqual(res.statusCode, 400);
  res = await call('/tickets/:id/reply', { params: { id: 'not-an-id' }, body: { reply: 'hi' } });
  assert.strictEqual(res.statusCode, 404);
  res = await call('/tickets/:id/reply', { params: { id: '64b7f0c2a1b2c3d4e5f6ffff' }, body: { reply: 'hi' } });
  assert.strictEqual(res.statusCode, 404);

  // resolve still works and clears the pending request
  t = fresh({ escalated: true, urgent: true, adminEngaged: true });
  res = await call('/tickets/:id/resolve', { params: { id: ID }, body: { adminReply: 'Done.' } });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual([t.status, t.escalated, t.urgent, t.adminEngaged], ['resolved', false, false, false]);
  assert.strictEqual(res.body.emailed, true);

  console.log('support admin chat tests passed');
})().catch((err) => { console.error(err); process.exit(1); });
