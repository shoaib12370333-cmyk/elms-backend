// The "Importing X of Y products" line of the Drafts page reads the job's done / failed counts. They used to be written only when a whole run of the
// processor ended, so during a run over hundreds of products the drafts were already appearing while the line still said "Importing 0 of 200".
// Now the counts are written after every chunk of 20 products. The real processor runs; Easyparser and MongoDB are stand-ins.
const assert = require('assert');
const Module = require('module');
const real = require('../services/easyparserAmazonService');

let pollImpl;
const fakes = {
  '../models/usersModel': { hasCredits: async () => true },
  '../services/easyparserAmazonService': {
    toEasyparserDomain: real.toEasyparserDomain,
    submitBulkDetail: async () => ({ accepted: [], rejected: [], meta: null }),
    pollResult: (...args) => pollImpl(...args),
    normalizeDetail: (raw, url) => ({ asin: raw.asin, title: 'T', price: 10, currency: 'USD', images: [], bulletPoints: [], specifications: [], categories: [], variants: [], sourceUrl: url }),
  },
  '../services/productCacheService': { setCachedProduct: async () => {} },
};
const origLoad = Module._load;
Module._load = function (request, parent) {
  if (fakes[request] && parent && /bulkImportProcessor/.test(parent.filename)) return fakes[request];
  return origLoad.apply(this, arguments);
};
const { processOneJob } = require('../jobs/bulkImportProcessor');
Module._load = origLoad;

const item = (i) => ({ amazonUrl: 'url' + i, asin: 'B' + i, country: 'US', status: 'pending', queryId: 'q' + i, submittedAt: new Date(), product: null, draftId: null, error: null, outOfCredits: false });
const makeJob = (n) => ({ _id: 'j1', userId: 'u1', markupPercent: 10, status: 'polling', items: Array.from({ length: n }, (_, i) => item(i)), total: n, done: 0, failed: 0, submitAttempts: 0, lastError: null, finishedAt: null, save: async () => {} });
const save = async (u, product) => ({ draft: { id: 'draft-' + product.asin } });

(async () => {
  // 45 products, three of them fail: the counts are written after every chunk of 20, so the page moves DURING the run
  const job = makeJob(45);
  pollImpl = async (queryId) => (['q3', 'q22', 'q41'].includes(queryId) ? { status: 'failure', error: 'no such product' } : { status: 'success', raw: { asin: 'B' + queryId.slice(1) } });
  const seen = [];
  await processOneJob(job, save, { persistCounts: async (j) => { seen.push([j.done, j.failed]); } });
  assert.deepStrictEqual(seen.slice(0, 3), [[19, 1], [38, 2], [42, 3]], 'chunk by chunk: 20 products, 40, 45 (failed ones counted as they fail)');
  assert.deepStrictEqual([job.done, job.failed, job.status], [42, 3, 'done'], 'and the job ends with the same numbers');
  assert.ok(seen.every(([d, f], i) => i === 0 || d + f >= seen[i - 1][0] + seen[i - 1][1]), 'the numbers only go up');

  // no hook (the tests of the older behaviour, or a caller that does not care): nothing breaks
  const job2 = makeJob(3);
  pollImpl = async (queryId) => ({ status: 'success', raw: { asin: 'B' + queryId.slice(1) } });
  await processOneJob(job2, save);
  assert.deepStrictEqual([job2.done, job2.failed, job2.status], [3, 0, 'done']);

  // 25 products: a chunk of 20 and a chunk of 5, each one reported
  const job3 = makeJob(25);
  const seen3 = [];
  await processOneJob(job3, save, { persistCounts: async (j) => { seen3.push(j.done); } });
  assert.deepStrictEqual(seen3.slice(0, 2), [20, 25]); assert.strictEqual(job3.done, 25);

  console.log('bulk import progress tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
