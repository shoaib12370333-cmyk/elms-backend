// A lease is held until the run is over: the next tick skips while it is going, only the holder can renew or release it, a lease
// that ran out (the process died) can be taken over, and it is always given back - also when the work throws.
const assert = require('assert');
const mongoose = require('mongoose');

const locks = new Map(); // jobName -> { jobName, lockedAt, lockedUntil, owner }
mongoose.models.JobLock = {
  // what MongoDB does for acquireLock's upsert: the filter only matches a lock that ran out; a lock that is still held makes the
  // upsert try to insert a second document for the same jobName, which the unique index refuses (E11000)
  findOneAndUpdate: async (filter, update) => {
    const now = new Date();
    const cur = locks.get(filter.jobName);
    if (cur && cur.lockedUntil > now) throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
    locks.set(filter.jobName, { ...update });
    return { value: { _id: 1 }, lastErrorObject: cur ? { updatedExisting: true } : { upserted: 'x' } };
  },
  updateOne: async (filter, update) => {
    const cur = locks.get(filter.jobName);
    if (!cur || cur.owner !== filter.owner) return { matchedCount: 0, modifiedCount: 0 };
    Object.assign(cur, update.$set);
    return { matchedCount: 1, modifiedCount: 1 };
  },
};
const { acquireLock, acquireLease, renewLease, releaseLease, withLease } = require('../services/jobLockService');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ---- a lease is taken once, until it is given back
  const t1 = await acquireLease('job', 60000);
  assert.ok(t1 && typeof t1 === 'string', 'the first caller gets a token');
  assert.strictEqual(await acquireLease('job', 60000), null, 'a second caller is refused while it is held');
  assert.strictEqual(await acquireLock('job', 60000), false, 'the plain lock sees it as held too');
  assert.strictEqual(await renewLease('job', 'someone-else', 60000), false, 'only the holder can renew it');
  assert.strictEqual(await renewLease('job', t1, 60000), true);
  await releaseLease('job', 'someone-else');
  assert.strictEqual(await acquireLease('job', 60000), null, 'and only the holder can release it');
  await releaseLease('job', t1);
  const t2 = await acquireLease('job', 60000);
  assert.ok(t2 && t2 !== t1, 'released: the next run can start at once');

  // ---- the process died without releasing: the lease runs out and another run takes over
  locks.get('job').lockedUntil = new Date(Date.now() - 1);
  const t3 = await acquireLease('job', 60000);
  assert.ok(t3, 'an expired lease is taken over');
  assert.strictEqual(await renewLease('job', t2, 60000), false, 'the old holder can no longer renew it');

  // ---- withLease: one run at a time, the second tick skips, the lease is free again afterwards
  let running = 0; let maxRunning = 0; let runs = 0;
  const work = async () => { runs += 1; running += 1; maxRunning = Math.max(maxRunning, running); await sleep(30); running -= 1; return 'done'; };
  const [a, b] = await Promise.all([withLease('w', 60000, work), withLease('w', 60000, work)]);
  assert.strictEqual(runs, 1, 'the work ran once');
  assert.strictEqual(maxRunning, 1);
  assert.deepStrictEqual([a, b].map((r) => r.skipped).sort(), [false, true], 'the other tick was skipped');
  assert.strictEqual([a, b].find((r) => !r.skipped).result, 'done');
  const again = await withLease('w', 60000, work);
  assert.strictEqual(again.skipped, false, 'given back at the end: the next tick runs');
  assert.strictEqual(runs, 2);

  // ---- renew is handed to the work, and a throwing job still gives the lease back
  let renewed = null;
  await withLease('r', 60000, async ({ renew }) => { renewed = await renew(); });
  assert.strictEqual(renewed, true, 'the holder can renew from inside the work');
  await assert.rejects(() => withLease('x', 60000, async () => { throw new Error('boom'); }), /boom/);
  assert.ok(await acquireLease('x', 60000), 'the lease was released although the work threw');

  // ---- the announcement sender: a slow batch is not joined by the next tick (nobody is mailed twice)
  const Module = require('module');
  const tasks = [];
  let batches = 0;
  const fakes = { 'node-cron': { schedule: (expr, fn) => tasks.push(fn) }, '../services/announcementService': { sendNextBatch: async () => { batches += 1; await sleep(30); return { sent: 1 }; } } };
  const origLoad = Module._load;
  Module._load = function (request, parent) {
    if (fakes[request] && parent && /announcementSender/.test(parent.filename)) return fakes[request];
    return origLoad.apply(this, arguments);
  };
  const { startAnnouncementSender } = require('../jobs/announcementSender');
  Module._load = origLoad;
  startAnnouncementSender();
  await Promise.all([tasks[0](), tasks[0](), tasks[0]()]);
  assert.strictEqual(batches, 1, 'one batch at a time');
  await tasks[0]();
  assert.strictEqual(batches, 2, 'the next tick after it finished sends the next batch');

  console.log('job lease tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
