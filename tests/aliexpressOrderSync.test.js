// jobs/aliexpressOrderSync.js: reads each open AliExpress order back (and only reads), turns a stuck claim into "unknown", and stops
// asking for a seller after a few failures in a row instead of hammering a dead connection.
const assert = require('assert');
const stub = (specifier, exports) => { const p = require.resolve(specifier); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub('node-cron', { schedule: () => {} });
stub('../services/jobLockService', { acquireLock: async () => true });
const job = require('../jobs/aliexpressOrderSync');

const refreshed = [];
let rows = []; let expiredCount = 0; let refreshBehaviour = async () => ({ order: {} });
const deps = {
  expireStale: async () => expiredCount,
  list: async () => rows,
  refresh: async (userId, orderId) => { refreshed.push([userId, orderId]); return refreshBehaviour(userId, orderId); },
};
const row = (user, n) => ({ _id: { toString: () => 'o' + n }, userId: { toString: () => user } });

(async () => {
  rows = [row('u1', 1), row('u2', 2), row('u1', 3)];
  expiredCount = 1;
  let out = await job.runAliexpressOrderSync(deps);
  assert.deepStrictEqual(refreshed, [['u1', 'o1'], ['u2', 'o2'], ['u1', 'o3']], 'every open order, ids as plain strings');
  assert.deepStrictEqual(out, { refreshed: 3, expired: 1 });

  // an order the service refuses to read (error answer) or a crash is skipped, and does not stop the others
  refreshed.length = 0;
  refreshBehaviour = async (u, o) => { if (o === 'o1') throw new Error('AliExpress down'); if (o === 'o2') return { error: 'not_placed', message: 'No AliExpress order was placed for this line.' }; return { order: {} }; };
  out = await job.runAliexpressOrderSync(deps);
  assert.strictEqual(refreshed.length, 3);
  assert.strictEqual(out.refreshed, 1);

  // 3 failures in a row for one seller: the rest of THEIR orders wait for the next run; another seller's are still read
  refreshed.length = 0;
  rows = [row('u1', 1), row('u1', 2), row('u1', 3), row('u1', 4), row('u1', 5), row('u2', 6)];
  refreshBehaviour = async (u) => { if (u === 'u1') throw new Error('invalid session'); return { order: {} }; };
  out = await job.runAliexpressOrderSync(deps);
  assert.strictEqual(job.MAX_FAILURES_PER_USER, 3);
  assert.deepStrictEqual(refreshed.map((r) => r[1]), ['o1', 'o2', 'o3', 'o6'], 'u1 is given up on after 3; u2 is still read');
  assert.strictEqual(out.refreshed, 1);

  // a success resets the count (flaky is not dead)
  refreshed.length = 0;
  rows = [row('u1', 1), row('u1', 2), row('u1', 3), row('u1', 4), row('u1', 5)];
  let n = 0;
  refreshBehaviour = async () => { n += 1; if (n === 3) return { order: {} }; throw new Error('flaky'); };
  out = await job.runAliexpressOrderSync(deps);
  assert.strictEqual(refreshed.length, 5, 'a good answer in the middle keeps the run going');

  // a line that changed while it was being read ('changed') is not a failure: it does not count toward giving up on the seller
  refreshed.length = 0;
  rows = [row('u1', 1), row('u1', 2), row('u1', 3), row('u1', 4), row('u1', 5)];
  refreshBehaviour = async () => ({ error: 'changed', message: 'This order changed while it was being read.' });
  out = await job.runAliexpressOrderSync(deps);
  assert.deepStrictEqual([refreshed.length, out.refreshed], [5, 0], 'all five are tried: five "changed" answers never reach the 3-failure limit');

  // nothing open
  refreshed.length = 0; rows = []; expiredCount = 0;
  out = await job.runAliexpressOrderSync(deps);
  assert.deepStrictEqual([refreshed.length, out], [0, { refreshed: 0, expired: 0 }]);

  console.log('aliexpress order sync tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
