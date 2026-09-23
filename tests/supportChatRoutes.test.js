// The customer's side of the support chat: open a ticket, write again, close it as solved, ask for an admin.
const assert = require('assert');
const Module = require('module');

const calls = [];
let ticketsToday = 0;
const store = { good: { id: 'good', status: 'open', thread: [], userId: 'u1' } };
const ID = '64b7f0c2a1b2c3d4e5f60718';
store[ID] = { id: ID, status: 'open', thread: [], userId: 'u1' };

const fakes = {
  '../models/supportTicketsModel': {
    createTicket: async (u, t) => { calls.push(['create', u, t.subject]); store.created = { id: '64b7f0c2a1b2c3d4e5f60999', status: 'open', thread: [], userId: u }; store['64b7f0c2a1b2c3d4e5f60999'] = store.created; return store.created; },
    listTicketsForUser: async () => Object.values(store),
    getTicketForUser: async (u, id) => store[id] || null,
    countTicketsSince: async () => ticketsToday,
    addCustomerMessage: async (u, id, text) => { calls.push(['message', id, text]); if (id === '64b7f0c2a1b2c3d4e5f6ffff') return { error: 'Too fast.', status: 429 }; if (!store[id]) return { error: 'Ticket not found.', status: 404 }; store[id].thread.push({ from: 'customer', text }); return { ticket: store[id] }; },
    closeTicketByCustomer: async (u, id) => { calls.push(['close', id]); if (!store[id]) return null; store[id].status = 'resolved'; return store[id]; },
  },
  '../services/supportAssistantService': {
    handleCustomerMessage: async (id, opts) => { calls.push(['assistant', id, !!(opts && opts.followUp)]); if (store[id]) store[id].thread.push({ from: 'ai', text: 'answer' }); },
    requestAdmin: async (id) => { calls.push(['escalate', id]); store[id].escalated = true; },
  },
};
const origLoad = Module._load;
Module._load = function (request, parent) {
  if (fakes[request] && parent && /routes.supportTickets.js$/.test(parent.filename)) return fakes[request];
  return origLoad.apply(this, arguments);
};
const router = require('../routes/supportTickets');
// the hook stays on: the routes load the assistant lazily, on the first request

const handler = (method, path) => {
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  assert.ok(layer, method + ' ' + path + ' is registered');
  return layer.route.stack[layer.route.stack.length - 1].handle;
};
const fakeRes = () => { const r = { statusCode: 200 }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
const run = async (method, path, req) => { const res = fakeRes(); await handler(method, path)({ userId: 'u1', params: {}, body: {}, ...req }, res); return res; };

(async () => {
  // opening a ticket: the assistant answers before the response, the ticket comes back with its answer
  let res = await run('post', '/', { body: { subject: 'Publish fails', message: 'It says 25001' } });
  assert.strictEqual(res.body.success, true);
  assert.deepStrictEqual(res.body.ticket.thread, [{ from: 'ai', text: 'answer' }]);
  assert.deepStrictEqual(calls.filter((c) => c[0] === 'assistant').pop(), ['assistant', '64b7f0c2a1b2c3d4e5f60999', false]);

  res = await run('post', '/', { body: { subject: '', message: 'x' } });
  assert.strictEqual(res.statusCode, 400);
  res = await run('post', '/', { body: { subject: 'x'.repeat(141), message: 'x' } });
  assert.strictEqual(res.statusCode, 400);
  ticketsToday = 10;
  res = await run('post', '/', { body: { subject: 'Again', message: 'again' } });
  assert.strictEqual(res.statusCode, 429);
  ticketsToday = 0;

  // writing again: saved, assistant runs as a follow-up, the updated ticket comes back
  res = await run('post', '/:id/messages', { params: { id: ID }, body: { text: 'still not working' } });
  assert.strictEqual(res.body.success, true);
  assert.deepStrictEqual(res.body.ticket.thread.map((t) => t.from), ['customer', 'ai']);
  assert.deepStrictEqual(calls.filter((c) => c[0] === 'assistant').pop(), ['assistant', ID, true]);
  res = await run('post', '/:id/messages', { params: { id: ID }, body: { text: '   ' } });
  assert.strictEqual(res.statusCode, 400);
  res = await run('post', '/:id/messages', { params: { id: 'not-an-id' }, body: { text: 'hi' } });
  assert.strictEqual(res.statusCode, 404);
  const before = calls.length;
  res = await run('post', '/:id/messages', { params: { id: '64b7f0c2a1b2c3d4e5f6ffff' }, body: { text: 'hi' } });
  assert.strictEqual(res.statusCode, 429);
  assert.strictEqual(calls.length, before + 1, 'a refused message never reaches the assistant');

  // solved -> closed
  res = await run('post', '/:id/close', { params: { id: ID } });
  assert.strictEqual(res.body.ticket.status, 'resolved');
  res = await run('post', '/:id/close', { params: { id: '64b7f0c2a1b2c3d4e5f60000' } });
  assert.strictEqual(res.statusCode, 404);

  // talk to admin
  res = await run('post', '/:id/escalate', { params: { id: ID } });
  assert.strictEqual(res.body.ticket.escalated, true);
  res = await run('post', '/:id/escalate', { params: { id: '64b7f0c2a1b2c3d4e5f60000' } });
  assert.strictEqual(res.statusCode, 404);
  console.log('support chat routes tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
