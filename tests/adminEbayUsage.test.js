// GET /api/admin/ebay-usage: ELMS's own Trading budget for today next to eBay's count of every API allowance. eBay not answering only hides its part.
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

stub('middleware/requireAuth', { requireAuth: (req, res, next) => next() });
stub('middleware/requireAdmin', { requireAdmin: (req, res, next) => next(), requireSuperAdmin: (req, res, next) => next() });
stub('services/ebayCallBudget', { snapshot: async () => ({ day: '2026-09-26', limit: 5000, statsLimit: 3500, total: 120, stats: 100, exhausted: false }) });
stub('services/listingStatsService', { getLastRun: () => ({ stores: 2, synced: 40, calls: 2, viewsInBulk: false }) });
let rate = async () => [{ apiName: 'TradingAPI', used: 4100, limit: 5000, percent: 82 }];
const seen = [];
stub('services/ebayRateLimitService', { fetchRateLimits: async (o) => { seen.push(o); return rate(); } });
const router = require('../routes/admin');

const handler = (() => { const l = router.stack.find((x) => x.route && x.route.path === '/ebay-usage' && x.route.methods.get); return l.route.stack[l.route.stack.length - 1].handle; })();
const call = async (query) => { const out = {}; await handler({ query: query || {} }, { json: (b) => { out.body = b; } }); return out.body; };

(async () => {
  let body = await call();
  assert.strictEqual(body.success, true);
  assert.strictEqual(body.usage.total, 120);
  assert.strictEqual(body.lastStatsRun.viewsInBulk, false);
  assert.strictEqual(body.ebay[0].apiName, 'TradingAPI');
  assert.strictEqual(body.ebayError, null);
  assert.deepStrictEqual(seen[0], { force: false });
  await call({ refresh: '1' });
  assert.deepStrictEqual(seen[1], { force: true }, 'the refresh button asks eBay again');

  rate = async () => { throw new Error('EBAY_CLIENT_ID or EBAY_CLIENT_SECRET is not set in the .env file.'); };
  body = await call();
  assert.strictEqual(body.success, true, 'eBay not answering does not break the panel');
  assert.strictEqual(body.ebay, null);
  assert.match(body.ebayError, /EBAY_CLIENT_ID/);
  assert.strictEqual(body.usage.limit, 5000, 'ELMS\'s own numbers are still there');
  console.log('admin ebay usage: all good');
})().catch((e) => { console.error(e); process.exit(1); });
