// Bulk imports: a saved product is dropped from the job (a 1000-product job no longer outgrows MongoDB's 16 MB document), every saved
// item is written to the database at once (a restart cannot charge it again), products that wait for credits are given up after a day,
// jobs are worked on in turn (a stuck one does not hold up the rest), and only one run works at a time.
const assert = require('assert');
const Module = require('module');
const path = require('path');
const { fakeModel } = require('./helpers/fakeMongo');
const stubCache = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

let hasCreditsImpl = async () => true;
let submitImpl = async () => ({ accepted: [], rejected: [], meta: null });
let pollImpl = async () => ({ status: 'pending' });
const savedDrafts = [];
const real = require('../services/easyparserAmazonService'); // only for its (already tested) domain map

// the jobs collection, and the lease / cron the processor uses
const jobRows = [];
stubCache('models/schemas/BulkImportJob.js', fakeModel(jobRows));
const cronTasks = [];
const leaseLog = { held: false, runs: 0, skipped: 0 };
const fakes = {
  '../models/usersModel': { hasCredits: (...a) => hasCreditsImpl(...a) },
  '../services/easyparserAmazonService': {
    toEasyparserDomain: real.toEasyparserDomain,
    submitBulkDetail: (...a) => submitImpl(...a),
    pollResult: (...a) => pollImpl(...a),
    normalizeDetail: (raw, url) => ({ asin: raw.asin, title: 'T', price: 10, currency: 'USD', images: [], bulletPoints: [], specifications: [], categories: [], variants: [], sourceUrl: url, description: 'x'.repeat(2000) }),
  },
  '../services/productCacheService': { setCachedProduct: async () => {} },
  '../routes/fetchProduct': { saveProductAsDraft: async (userId, product) => { savedDrafts.push(product.asin); return { draft: { id: 'draft-' + product.asin } }; } },
  'node-cron': { schedule: (expr, fn) => { cronTasks.push(fn); } },
  '../services/jobLockService': {
    withLease: async (name, ms, work) => {
      if (leaseLog.held) { leaseLog.skipped += 1; return { skipped: true }; }
      leaseLog.held = true; leaseLog.runs += 1;
      try { return { skipped: false, result: await work({ renew: async () => true }) }; } finally { leaseLog.held = false; }
    },
  },
};
const origLoad = Module._load;
Module._load = function (request, parent) {
  if (fakes[request] && parent && /bulkImportProcessor/.test(parent.filename)) return fakes[request];
  return origLoad.apply(this, arguments);
};
const { processOneJob, runBulkImportProcessor, startBulkImportProcessor } = require('../jobs/bulkImportProcessor');

const item = (asin, over = {}) => ({ amazonUrl: 'u-' + asin, asin, country: 'US', status: 'pending', queryId: null, submittedAt: null, product: null, draftId: null, error: null, outOfCredits: false, ...over });
const job = (items, over = {}) => ({ userId: 'u1', markupPercent: 0, status: 'polling', items, total: items.length, done: 0, failed: 0, submitAttempts: 0, lastError: null, finishedAt: null, save: async () => {}, ...over });
const fetchedItem = (asin, over = {}) => item(asin, { status: 'fetched', outOfCredits: true, queryId: 'q-' + asin, product: { asin, title: 'T', description: 'x'.repeat(2000) }, ...over });

(async () => {
  // ---- a saved product is dropped from the job and written to the database at once
  const persisted = [];
  const persistItem = async (j, it) => { persisted.push([it.asin, it.status, it.draftId, it.product]); };
  pollImpl = async (q) => ({ status: 'success', raw: { asin: q.replace('q-', '') } });
  const j1 = job([item('B1', { queryId: 'q-B1', submittedAt: new Date() }), item('B2', { queryId: 'q-B2', submittedAt: new Date() })]);
  const saveFn = async (userId, product) => { savedDrafts.push(product.asin); return { draft: { id: 'draft-' + product.asin } }; };
  await processOneJob(j1, saveFn, { persistItem });
  assert.deepStrictEqual(j1.items.map((i) => i.status), ['done', 'done']);
  assert.deepStrictEqual(j1.items.map((i) => i.product), [null, null], 'the product is not kept once it is a draft');
  assert.deepStrictEqual(persisted.map((p) => p.slice(0, 3)).sort(), [['B1', 'done', 'draft-B1'], ['B2', 'done', 'draft-B2']], 'each saved item was written straight away');
  assert.ok(persisted.every((p) => p[3] === null));
  assert.ok(j1.lastProcessedAt instanceof Date, 'the job notes when it was last worked on');
  assert.strictEqual(j1.status, 'done');

  // without the hook (as in the other tests) nothing else changes
  const j1b = job([item('B9', { queryId: 'q-B9', submittedAt: new Date() })]);
  await processOneJob(j1b, saveFn);
  assert.strictEqual(j1b.items[0].status, 'done');

  // ---- products that wait for credits keep their product for a day, then become errors that say so (Retry saves them later)
  hasCreditsImpl = async () => false;
  const j2 = job([fetchedItem('B3'), fetchedItem('B4')], { createdAt: new Date(Date.now() - 23 * 3600 * 1000) });
  await processOneJob(j2, saveFn);
  assert.deepStrictEqual(j2.items.map((i) => i.status), ['fetched', 'fetched'], 'still waiting after 23 hours');
  assert.strictEqual(j2.status, 'polling');
  const j3 = job([fetchedItem('B5'), fetchedItem('B6'), item('B7', { status: 'error', error: 'x' })], { createdAt: new Date(Date.now() - 25 * 3600 * 1000) });
  await processOneJob(j3, saveFn);
  assert.deepStrictEqual(j3.items.map((i) => i.status), ['error', 'error', 'error']);
  assert.ok(j3.items[0].outOfCredits && /not enough credits/.test(j3.items[0].error) && /Retry/.test(j3.items[0].error));
  assert.ok(j3.items[0].product && j3.items[0].product.asin === 'B5', 'the product is kept: Retry saves it without fetching again');
  assert.strictEqual(j3.status, 'done', 'the job ends instead of staying in the processor\'s list for ever');
  hasCreditsImpl = async () => true;

  // ---- a job cancelled while the run was busy with it stays cancelled; the lease is renewed while a job is worked on
  pollImpl = async (q) => ({ status: 'success', raw: { asin: q.replace('q-', '') } });
  let renews = 0;
  const hooks = { renew: async () => { renews += 1; }, isCancelled: async () => true };
  const j5 = job([item('B8', { queryId: 'q-B8', submittedAt: new Date() })]);
  await processOneJob(j5, saveFn, hooks);
  assert.strictEqual(j5.status, 'cancelled', 'saving the job did not bring it back to life');
  assert.ok(renews >= 1, 'the lease was renewed while the job was worked on');
  const j6 = job([item('B10', { queryId: 'q-B10', submittedAt: new Date() })]);
  await processOneJob(j6, saveFn, { ...hooks, isCancelled: async () => false });
  assert.strictEqual(j6.status, 'done', 'a job nobody cancelled ends as usual');

  // ---- jobs are worked on in turn: the one worked on longest ago first, a job that cannot move goes to the back each time
  jobRows.length = 0;
  const mk = (id, over = {}) => {
    const r = { _id: id, userId: 'u1', status: 'polling', items: [fetchedItem('S' + id)], total: 1, done: 0, failed: 0, submitAttempts: 0, lastProcessedAt: null, ...over };
    r.save = async function save() { r.lastProcessedAt = this.lastProcessedAt; };
    return r;
  };
  for (let i = 1; i <= 10; i++) jobRows.push(mk('stuck' + i)); // no credits: these never finish
  jobRows.push(mk('fresh1', { status: 'queued', items: [item('F1')], lastProcessedAt: null }));
  jobRows.push(mk('fresh2', { status: 'queued', items: [item('F2')], lastProcessedAt: null }));
  hasCreditsImpl = async () => false;
  const submitted = [];
  submitImpl = async (groups) => { submitted.push(...groups.flatMap((g) => g.asins)); return { accepted: [], rejected: [], meta: null }; };
  await runBulkImportProcessor();
  assert.deepStrictEqual(submitted, [], 'run 1 worked on the ten oldest jobs (none of them had ever been worked on)');
  assert.ok(jobRows.slice(0, 10).every((r) => r.lastProcessedAt instanceof Date), 'and noted it');
  await runBulkImportProcessor();
  assert.deepStrictEqual(submitted.sort(), ['F1', 'F2'], 'run 2: the new jobs go first - they are not held up by the stuck ones');

  // ---- one run at a time: the second tick finds the lease taken and does nothing
  cronTasks.length = 0; leaseLog.runs = 0; leaseLog.skipped = 0;
  jobRows.length = 0;
  let findCalls = 0;
  const model = require('../models/schemas/BulkImportJob');
  const realFind = model.find;
  model.find = (...a) => { findCalls += 1; const chain = realFind(...a); const origThen = chain.then.bind(chain); chain.then = (res, rej) => new Promise((r) => setTimeout(r, 40)).then(() => origThen(res, rej)); return chain; };
  startBulkImportProcessor();
  assert.strictEqual(cronTasks.length, 1, 'scheduled once');
  await Promise.all([cronTasks[0](), cronTasks[0](), cronTasks[0]()]);
  assert.strictEqual(leaseLog.runs, 1, 'only one run worked');
  assert.strictEqual(leaseLog.skipped, 2, 'the other ticks skipped');
  assert.strictEqual(findCalls, 1);
  model.find = realFind;
  await cronTasks[0]();
  assert.strictEqual(leaseLog.runs, 2, 'and the next tick after it finished runs again');

  Module._load = origLoad;
  console.log('bulk import safety tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
