// Admin Panel -> Categories: the admin uploads eBay's category CSV for any country (GET lists them all, PUT saves or replaces one, DELETE removes it).
// A bad file is refused with a message, and saves nothing. The real routes and the real list service run; MongoDB is a stand-in.
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

stub('middleware/requireAuth', { requireAuth: (req, res, next) => next() });
stub('middleware/requireAdmin', { requireAdmin: (req, res, next) => next(), requireSuperAdmin: (req, res, next) => next() });
const stored = new Map();
stub('models/schemas/EbayCategoryList', {
  findOneAndUpdate: async (q, u) => { stored.set(q.marketplaceId, { marketplaceId: q.marketplaceId, ...u.$set, updatedAt: new Date('2026-09-27T10:00:00Z') }); },
  find: () => ({ select: () => ({ lean: async () => [...stored.values()].map(({ data, ...rest }) => rest) }) }),
  findOne: () => ({ select: () => ({ lean: async () => null }), then: (res) => Promise.resolve(null).then(res) }),
  deleteOne: async (q) => ({ deletedCount: stored.delete(q.marketplaceId) ? 1 : 0 }),
});
const router = require('../routes/admin');

const handler = (method, p) => { const l = router.stack.find((x) => x.route && x.route.path === p && x.route.methods[method]); return l.route.stack[l.route.stack.length - 1].handle; };
const call = async (method, p, req) => { const out = { status: 200 }; await handler(method, p)({ params: {}, body: {}, query: {}, ...req }, { status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; } }); return out; };

const csv = 'CategoryID,Category Path\r\n' + Array.from({ length: 30 }, (_, i) => (100 + i) + ',"Home & Garden > Kitchen, Dining & Bar > Thing ' + i + '"').join('\r\n') + '\r\n';

(async () => {
  let r = await call('get', '/category-lists');
  assert.strictEqual(r.body.success, true); assert.strictEqual(r.body.lists.length, 19);
  assert.ok(r.body.lists.every((l) => l.uploaded === false), 'nothing uploaded yet');
  assert.deepStrictEqual(r.body.lists.slice(0, 2).map((l) => [l.marketplaceId, l.domain]), [['EBAY_US', 'ebay.com'], ['EBAY_GB', 'ebay.co.uk']]);

  // the admin uploads the UK list
  r = await call('put', '/category-lists/:marketplaceId', { params: { marketplaceId: 'EBAY_GB' }, body: { csv, filename: 'CategoryIDs-UK.csv' } });
  assert.deepStrictEqual([r.status, r.body.success, r.body.marketplaceId, r.body.count], [200, true, 'EBAY_GB', 30]);
  r = await call('get', '/category-lists');
  const gb = r.body.lists.find((l) => l.marketplaceId === 'EBAY_GB');
  assert.deepStrictEqual([gb.uploaded, gb.count, gb.filename], [true, 30, 'CategoryIDs-UK.csv']);
  assert.ok(!('data' in gb), 'the rows themselves never go to the page');

  // refused: no file text, a file that is not a category list, a marketplace ELMS does not support
  r = await call('put', '/category-lists/:marketplaceId', { params: { marketplaceId: 'EBAY_GB' }, body: {} });
  assert.strictEqual(r.status, 400); assert.match(r.body.error, /CSV text is required/);
  r = await call('put', '/category-lists/:marketplaceId', { params: { marketplaceId: 'EBAY_DE' }, body: { csv: 'Name,Price\nA,1\n' } });
  assert.strictEqual(r.status, 400); assert.match(r.body.error, /does not look like eBay's category list/);
  r = await call('put', '/category-lists/:marketplaceId', { params: { marketplaceId: 'EBAY_XX' }, body: { csv } });
  assert.strictEqual(r.status, 400); assert.match(r.body.error, /Unsupported eBay marketplace/);
  assert.deepStrictEqual([...stored.keys()], ['EBAY_GB'], 'the refused files saved nothing');

  // removed
  r = await call('delete', '/category-lists/:marketplaceId', { params: { marketplaceId: 'EBAY_GB' } });
  assert.deepStrictEqual([r.body.success, r.body.removed], [true, true]);
  r = await call('delete', '/category-lists/:marketplaceId', { params: { marketplaceId: 'EBAY_GB' } });
  assert.strictEqual(r.body.removed, false, 'removing what is not there is not an error');

  console.log('admin category lists tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
