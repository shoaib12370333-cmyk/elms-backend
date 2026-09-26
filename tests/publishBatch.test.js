// "Publish all": one request starts the whole selection and answers at once; the person is notified ONCE when every listing of the
// batch has finished; a listing waiting in the runner's line is not failed as "interrupted".
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

// ---- database stand-ins ----
const batches = [];
const listings = new Map();
const notes = [];
stub('models/schemas/PublishBatch', {
  create: async (d) => { const doc = { _id: 'B' + (batches.length + 1), notifiedAt: null, startedAt: new Date(), ...d }; batches.push(doc); return doc; },
  find: (q) => ({ sort: () => ({ limit: () => ({ lean: async () => batches.filter((b) => b.notifiedAt === q.notifiedAt).map((b) => ({ ...b })) }) }) }),
  findOneAndUpdate: async (q, u) => { const b = batches.find((x) => x._id === q._id && x.notifiedAt === q.notifiedAt); if (!b) return null; Object.assign(b, u.$set); return b; },
  findOne: (q) => ({ lean: async () => batches.find((b) => b._id === q._id && String(b.userId) === String(q.userId)) || null }),
});
stub('models/schemas/Listing', {
  aggregate: async ([match]) => {
    const by = {};
    for (const id of match.$match._id.$in) { const l = listings.get(String(id)); if (l) by[l.status] = (by[l.status] || 0) + 1; }
    return Object.entries(by).map(([status, n]) => ({ _id: status, n }));
  },
});
stub('models/systemNotificationsModel', { createSystemNotification: async (userId, data) => { notes.push({ userId, ...data }); } });

const svc = require('../services/publishBatchService');

(async () => {
  // ---- the words ----
  assert.deepStrictEqual(svc.summaryOf(3, { published: 3 }), { level: 'success', title: 'Publishing finished', message: 'All 3 of your products were published to eBay.' });
  assert.strictEqual(svc.summaryOf(1, { published: 1 }).message, 'Your product was published to eBay.');
  const some = svc.summaryOf(1100, { published: 100, error: 1000 });
  assert.strictEqual(some.level, 'warning'); assert.strictEqual(some.title, 'Publishing finished, 1000 failed');
  assert.match(some.message, /^100 of your 1100 products were published to eBay and 1000 failed\..*Needs attention.*retry/);

  // ---- starting a batch: everything is claimed, put in line in order, recorded as one batch, and answered at once ----
  const ids = ['a1', 'a2', 'a3', 'a4', 'a5'];
  const draft = (id, status = 'draft') => ({ id, status, title: 'Product ' + id });
  const claimed = new Set(); const queued = [];
  const deps = {
    claim: async (u, id) => { if (id === 'a3' || id === 'a5') return null; claimed.add(id); return draft(id, 'publishing'); },
    enqueue: (u, l) => queued.push(l.id),
    getListing: async (u, id) => (id === 'a3' ? draft('a3', 'published') : id === 'a5' ? null : draft(id)),
  };
  let out = await svc.startBatch('u1', ids, deps);
  assert.deepStrictEqual(queued, ['a1', 'a2', 'a4'], 'the claimed ones, in the order of the request');
  assert.strictEqual(out.started, 3); assert.strictEqual(out.notStarted, 2);
  assert.deepStrictEqual(out.skipped.map((s) => [s.id, s.error]), [['a3', 'Already published.'], ['a5', 'Not found.']]);
  assert.strictEqual(batches.length, 1); assert.deepStrictEqual(batches[0].listingIds, ['a1', 'a2', 'a4']); assert.strictEqual(batches[0].skipped, 2);
  assert.strictEqual(out.batchId, 'B1');
  // nothing could be started: no batch is made
  out = await svc.startBatch('u1', ['a3'], { ...deps, claim: async () => null });
  assert.strictEqual(out.batchId, null); assert.strictEqual(batches.length, 1);

  // ---- a lot at once: 1100 in one go ----
  const big = Array.from({ length: 1100 }, (_, i) => 'g' + i);
  queued.length = 0;
  const t0 = Date.now();
  out = await svc.startBatch('u1', big, { claim: async (u, id) => { await new Promise((r) => setTimeout(r, 2)); return draft(id, 'publishing'); }, enqueue: (u, l) => queued.push(l.id), getListing: async () => null });
  assert.strictEqual(out.started, 1100); assert.strictEqual(queued.length, 1100);
  assert.ok(Date.now() - t0 < 2000, 'claimed up to 20 at a time, not one by one: ' + (Date.now() - t0) + ' ms');

  // ---- the notification: not while any listing is still publishing; once when the last one is done ----
  for (const id of ['a1', 'a2', 'a4']) listings.set(id, { status: 'publishing' });
  batches.length = 1; batches[0].notifiedAt = null; notes.length = 0; batches[0].userId = 'u1'; batches[0].total = 3;
  assert.strictEqual(await svc.finishDueBatches(), 0); assert.strictEqual(notes.length, 0, 'still publishing: no notification yet');
  listings.get('a1').status = 'published'; listings.get('a2').status = 'error';
  assert.strictEqual(await svc.finishDueBatches(), 0, 'one is still going');
  listings.get('a4').status = 'published';
  assert.strictEqual(await svc.finishDueBatches(), 1);
  assert.strictEqual(notes.length, 1);
  assert.deepStrictEqual([notes[0].userId, notes[0].type, notes[0].level, notes[0].title], ['u1', 'publish_batch_done', 'warning', 'Publishing finished, 1 failed']);
  assert.match(notes[0].message, /^2 of your 3 products were published to eBay and 1 failed\./);
  assert.deepStrictEqual([notes[0].metadata.published, notes[0].metadata.failed, notes[0].metadata.skipped], [2, 1, 2]);
  assert.ok(batches[0].notifiedAt instanceof Date);
  assert.strictEqual(await svc.finishDueBatches(), 0); assert.strictEqual(notes.length, 1, 'told once, however often the job runs');

  // progress: counts only, and only for the person's own batch
  batches.length = 0;
  await svc.createBatch('u5', ['p1', 'p2', 'p3', 'p4'], 0);
  listings.set('p1', { status: 'published' }); listings.set('p2', { status: 'error' }); listings.set('p3', { status: 'publishing' });
  let prog = await svc.batchProgress('u5', batches[0]._id);
  assert.strictEqual(prog, null, 'an id that is not a real object id is refused'); // 'B1' is not 24 hex characters
  batches[0]._id = 'a'.repeat(24);
  prog = await svc.batchProgress('u5', batches[0]._id);
  assert.deepStrictEqual([prog.total, prog.published, prog.failed, prog.publishing, prog.other, prog.done], [4, 1, 1, 1, 1, false]);
  assert.strictEqual(await svc.batchProgress('someone-else', batches[0]._id), null, 'not another person\'s batch');
  listings.set('p3', { status: 'published' }); listings.set('p4', { status: 'published' });
  prog = await svc.batchProgress('u5', batches[0]._id);
  assert.deepStrictEqual([prog.published, prog.publishing, prog.done], [3, 0, true]);

  // two runs at the same moment: the atomic marker lets only one make the notification
  batches.length = 0; notes.length = 0;
  await svc.createBatch('u2', ['z1', 'z2'], 0);
  listings.set('z1', { status: 'published' }); listings.set('z2', { status: 'published' });
  const both = await Promise.all([svc.finishDueBatches(), svc.finishDueBatches()]);
  assert.strictEqual(both[0] + both[1], 1); assert.strictEqual(notes.length, 1); assert.strictEqual(notes[0].message, 'All 2 of your products were published to eBay.');

  // ---- a listing waiting in the runner's line is not failed as "interrupted" ----
  const runner = require('../services/publishRunner');
  runner.hooks.process = () => new Promise(() => {}); // never finishes: the listings stay in line
  for (let i = 0; i < runner.MAX_RUNNING + 3; i += 1) runner.enqueuePublish('u3', { id: 'q' + i });
  assert.strictEqual(runner.isQueued('q0'), true, 'running');
  assert.strictEqual(runner.isQueued('q' + (runner.MAX_RUNNING + 2)), true, 'waiting its turn');
  assert.strictEqual(runner.isQueued('never-queued'), false);

  console.log('publish batch tests passed');
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
