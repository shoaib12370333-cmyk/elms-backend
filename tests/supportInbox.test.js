// Mail sent to the support address becomes a support ticket (shown in Admin -> Tickets).
const assert = require('node:assert/strict');
const Module = require('module');

const tickets = [];
const updates = [];
let recentCount = 0;
const SupportTicket = {
  exists: async (q) => {
    const ids = (q.$or || []).flatMap((c) => Object.values(c));
    return tickets.some((t) => ids.includes(t.emailMessageId)) ? { _id: 'x' } : null;
  },
  findOne: async (q) => tickets.find((t) => t.ref === q.ref) || null,
  updateOne: async (filter, update) => { updates.push({ filter, update }); },
  countDocuments: async () => recentCount,
  create: async (doc) => { const t = { _id: 't' + (tickets.length + 1), ref: 'a1b2c3d4', ...doc }; tickets.push(t); return t; },
};
const User = { findOne: () => ({ select: () => ({ lean: async () => (global.__knownUser || null) }) }) };

const origLoad = Module._load;
Module._load = function (request, parent) {
  if (parent && /supportInboxService\.js/.test(parent.filename)) {
    if (request === '../models/schemas/SupportTicket') return SupportTicket;
    if (request === '../models/schemas/User') return User;
  }
  return origLoad.apply(this, arguments);
};
const { handleParsedMail, cleanSubject, extractRef, stripQuoted, isAutomated } = require('../services/supportInboxService');

const mail = (over = {}) => ({
  from: { value: [{ address: 'Buyer@Example.com', name: 'Sam Buyer' }] },
  subject: 'Help with credits',
  text: 'Hello,\nI ran out of credits.',
  messageId: '<m1@example.com>',
  headers: new Map(),
  date: new Date(),
  ...over,
});
const OWN = ['noreply@elmstool.com', 'support@elmstool.com'];

(async () => {
  // helpers
  assert.equal(cleanSubject('Re: RE: Fwd: Help  me [Ticket #a1b2c3d4]'), 'Help me');
  assert.equal(cleanSubject(''), '(no subject)');
  assert.equal(extractRef('Re: Help [Ticket #A1B2C3D4]'), 'a1b2c3d4');
  assert.equal(extractRef('Help'), null);
  assert.equal(stripQuoted('Thanks, fixed!\n\nOn Mon, 1 Jan 2026, Support wrote:\n> old text\n> more'), 'Thanks, fixed!');
  assert.equal(stripQuoted('Line1\n> quoted\nLine2'), 'Line1\nLine2');

  // automated / own mail is ignored
  assert.equal(isAutomated(mail({ from: { value: [{ address: 'MAILER-DAEMON@x.com' }] } }), OWN), true);
  assert.equal(isAutomated(mail({ from: { value: [{ address: 'support@elmstool.com' }] } }), OWN), true);
  assert.equal(isAutomated(mail({ headers: new Map([['auto-submitted', 'auto-replied']]) }), OWN), true);
  assert.equal(isAutomated(mail({ headers: new Map([['precedence', 'bulk']]) }), OWN), true);
  assert.equal(isAutomated(mail({ subject: 'Automatic reply: away' }), OWN), true);
  assert.equal(isAutomated(mail(), OWN), false);

  // a stranger's mail -> new email ticket, no user linked, sender lower-cased
  let out = await handleParsedMail(mail(), OWN);
  assert.equal(out.action, 'created');
  assert.equal(tickets[0].source, 'email');
  assert.equal(tickets[0].fromEmail, 'buyer@example.com');
  assert.equal(tickets[0].userId, undefined);
  assert.equal(tickets[0].subject, 'Help with credits');
  assert.equal(tickets[0].emailMessageId, '<m1@example.com>');

  // the same mail read again is not duplicated
  out = await handleParsedMail(mail(), OWN);
  assert.deepEqual([out.action, out.reason], ['skipped', 'duplicate']);
  assert.equal(tickets.length, 1);

  // an ELMS user's mail is linked to their account
  global.__knownUser = { _id: 'user-1' };
  await handleParsedMail(mail({ messageId: '<m2@example.com>', from: { value: [{ address: 'owner@example.com' }] } }), OWN);
  assert.equal(tickets[1].userId, 'user-1');
  global.__knownUser = null;

  // an answer to our reply ("[Ticket #ref]") reopens the ticket and joins its thread instead of making a new one
  out = await handleParsedMail(mail({ messageId: '<m3@example.com>', subject: 'Re: Help with credits [Ticket #a1b2c3d4]', text: 'Still not fixed\n\nOn Tue, Support wrote:\n> we fixed it' }), OWN);
  assert.equal(out.action, 'appended');
  assert.equal(tickets.length, 2, 'no new ticket');
  const upd = updates[0].update;
  assert.equal(upd.$set.status, 'open');
  assert.equal(upd.$push.thread.from, 'customer');
  assert.equal(upd.$push.thread.text, 'Still not fixed');

  // a flood from one sender is cut off
  recentCount = 20;
  out = await handleParsedMail(mail({ messageId: '<m4@example.com>', from: { value: [{ address: 'spam@example.com' }] } }), OWN);
  assert.deepEqual([out.action, out.reason], ['skipped', 'rate_limited']);

  console.log('support inbox tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
