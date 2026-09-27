// POST /api/admin/cleanup-images: runs the orphaned-image cleanup (jobs/imageCleanup.js's daily job) on demand, for
// reclaiming Render Disk space immediately instead of waiting for the 3am schedule.
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

stub('middleware/requireAuth', { requireAuth: (req, res, next) => next() });
stub('middleware/requireAdmin', { requireAdmin: (req, res, next) => next(), requireSuperAdmin: (req, res, next) => next() });

let nextResult = async () => ({ checked: 3, foldersRemoved: 2, freedBytes: 5_242_880 }); // 5 MiB
stub('services/imageCleanupService', { cleanupOrphanedImages: () => nextResult() });

const router = require('../routes/admin');
const handler = (() => { const l = router.stack.find((x) => x.route && x.route.path === '/cleanup-images' && x.route.methods.post); return l.route.stack[l.route.stack.length - 1].handle; })();
const call = async () => { const out = { statusCode: 200 }; await handler({}, { status(c) { out.statusCode = c; return this; }, json: (b) => { out.body = b; } }); return out; };

(async () => {
  let res = await call();
  assert.strictEqual(res.body.success, true);
  assert.deepStrictEqual(res.body, { success: true, checked: 3, foldersRemoved: 2, freedBytes: 5242880, freedMb: 5 });

  nextResult = async () => { throw new Error('disk error'); };
  res = await call();
  assert.strictEqual(res.statusCode, 500);
  assert.strictEqual(res.body.success, false);
  assert.match(res.body.error, /disk error/);

  console.log('admin cleanup-images: all good');
})().catch((e) => { console.error(e); process.exit(1); });
