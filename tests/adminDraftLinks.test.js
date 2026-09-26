// Admin -> Users -> "Draft links": a CSV with the Amazon link of every draft of one user, and nothing else. The user is not told.
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

// ---- the drafts collection (only what the query asks for comes back) ----
let rows = [];
let lastQuery = null;
stub('models/schemas/Listing', {
  find: (query) => {
    lastQuery = query;
    let out = rows.filter((r) => query.userId === r.userId && query.status.$in.includes(r.status));
    const q = { select: () => q, populate: () => q, sort: (s) => { out = out.slice().sort((a, b) => (a.createdAt - b.createdAt) * (s.createdAt || 1)); return q; }, lean: async () => out.map((r) => ({ importId: r.importId, createdAt: r.createdAt })) };
    return q;
  },
});
const listingsModel = require('../models/listingsModel');
const d = (n) => new Date(2026, 8, n);
const row = (over) => ({ userId: 'u1', status: 'draft', createdAt: d(1), importId: { amazonUrl: 'https://www.amazon.co.uk/dp/B0AAAAAAAA' }, ...over });

(async () => {
  rows = [
    row({ createdAt: d(3), importId: { amazonUrl: 'https://www.amazon.co.uk/dp/B0CCCCCCCC' } }),
    row({ createdAt: d(1), importId: { amazonUrl: 'https://www.amazon.co.uk/dp/B0AAAAAAAA' } }),
    row({ createdAt: d(2), status: 'error', importId: { amazonUrl: 'https://www.amazon.com/dp/B0BBBBBBBB' } }),
    row({ createdAt: d(4), importId: { amazonUrl: 'https://www.amazon.co.uk/dp/B0AAAAAAAA' } }),        // the same product in a second store: once
    row({ createdAt: d(5), status: 'published', importId: { amazonUrl: 'https://www.amazon.com/dp/B0LIVE00000' } }), // live: not a draft
    row({ createdAt: d(6), status: 'ended', importId: { amazonUrl: 'https://www.amazon.com/dp/B0ENDED0000' } }),
    row({ createdAt: d(7), status: 'scheduled', importId: { amazonUrl: 'https://www.amazon.com/dp/B0SCHED0000' } }),
    row({ createdAt: d(8), importId: null }),                                                            // no import: no link, none made up
    row({ createdAt: d(9), importId: { amazonUrl: '' } }),
    row({ createdAt: d(10), importId: { amazonUrl: 'javascript:alert(1)' } }),
    row({ createdAt: d(11), userId: 'u2', importId: { amazonUrl: 'https://www.amazon.com/dp/B0OTHERUSER' } }), // someone else's
  ];
  const links = await listingsModel.listDraftAmazonLinks('u1');
  assert.deepStrictEqual(links, ['https://www.amazon.co.uk/dp/B0AAAAAAAA', 'https://www.amazon.com/dp/B0BBBBBBBB', 'https://www.amazon.co.uk/dp/B0CCCCCCCC'], 'drafts and failed drafts, oldest first, each link once, real links only');
  assert.deepStrictEqual(lastQuery.status.$in, ['draft', 'error'], 'only the drafts');
  assert.deepStrictEqual(await listingsModel.listDraftAmazonLinks('nobody'), []);

  // ---- the admin route ----
  let users = { a1: { _id: 'a1' } };
  stub('middleware/requireAuth', { requireAuth: (req, res, next) => next() });
  stub('middleware/requireAdmin', { requireAdmin: (req, res, next) => next(), requireSuperAdmin: (req, res, next) => next() });
  stub('models/schemas/User', { findById: (id) => ({ lean: async () => users[id] || null }) });
  const notices = [];
  let modelLinks = [];
  const realModel = require('../models/listingsModel');
  stub('models/listingsModel', { ...realModel, listDraftAmazonLinks: async (id) => { notices.push('read ' + id); return modelLinks; } });
  const router = require('../routes/admin');
  const handler = (() => { const l = router.stack.find((x) => x.route && x.route.path === '/users/:id/draft-links' && x.route.methods.get); assert.ok(l, 'the route exists'); return l.route.stack[l.route.stack.length - 1].handle; })();
  const call = async (id) => { const out = { headers: {}, status: 200 }; const res = { status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; }, setHeader(k, v) { out.headers[k] = v; }, send(b) { out.text = b; return this; } }; await handler({ params: { id } }, res); return out; };

  const ID = 'a'.repeat(24);
  users[ID] = { _id: ID };
  modelLinks = ['https://www.amazon.co.uk/dp/B0AAAAAAAA', 'https://www.amazon.com/dp/B0BBBBBBBB?a=1,2', 'https://www.amazon.com/dp/B0QUOTE"X'];
  let out = await call(ID);
  assert.strictEqual(out.status, 200);
  assert.match(out.headers['Content-Type'], /^text\/csv/);
  assert.match(out.headers['Content-Disposition'], /^attachment; filename="draft-amazon-links-\d{4}-\d{2}-\d{2}\.csv"$/);
  assert.strictEqual(out.text, 'Amazon link\r\nhttps://www.amazon.co.uk/dp/B0AAAAAAAA\r\n"https://www.amazon.com/dp/B0BBBBBBBB?a=1,2"\r\n"https://www.amazon.com/dp/B0QUOTE""X"\r\n', 'one column, one link a row, a comma or quote inside a link is escaped');
  assert.deepStrictEqual(notices, ['read ' + ID], 'a plain read: nothing is recorded and nobody is notified');

  modelLinks = [];
  out = await call(ID);
  assert.strictEqual(out.status, 404); assert.match(out.body.error, /no drafts with an Amazon link/);
  assert.strictEqual(out.text, undefined, 'no empty file');
  out = await call('b'.repeat(24)); assert.strictEqual(out.status, 404); assert.match(out.body.error, /User not found/);
  out = await call('not-an-id'); assert.strictEqual(out.status, 404);
  out = await call(undefined); assert.strictEqual(out.status, 404);

  console.log('admin draft links: all good');
})().catch((err) => { console.error(err); process.exit(1); });
