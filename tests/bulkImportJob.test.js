// Checks the bulk-import background processor's state machine: submit -> poll -> save,
// partial credit shortfalls, rejected/failed items, submit-retry exhaustion, and item
// timeout. No database or network calls - everything bulkImportProcessor.js imports is
// mocked via Module._load, scoped to requires coming from that file.
const assert = require('assert');
const Module = require('module');
const real = require('../services/easyparserAmazonService'); // reused only for its (already-tested) domain map

let hasCreditsImpl = async () => true;
let submitImpl;
let pollImpl;
const savedDrafts = [];

const fakes = {
  // Indirection matters here: bulkImportProcessor.js destructures `hasCredits` once at
  // require time, so reassigning `fakes[...].hasCredits` afterwards would be a no-op -
  // this stable wrapper instead reads the current `hasCreditsImpl` on every call, so the
  // test can freely swap behavior between ticks (same reason submitImpl/pollImpl are used
  // below instead of reassigning fakes[...].submitBulkDetail/pollResult directly).
  '../models/usersModel': { hasCredits: (...args) => hasCreditsImpl(...args) },
  '../services/easyparserAmazonService': {
    toEasyparserDomain: real.toEasyparserDomain,
    submitBulkDetail: (...args) => submitImpl(...args),
    pollResult: (...args) => pollImpl(...args),
    normalizeDetail: (raw, url) => ({ asin: raw.asin, title: raw.title || 'T', price: 10, currency: 'USD', images: [], bulletPoints: [], specifications: [], categories: [], variants: [], sourceUrl: url }),
  },
  '../services/productCacheService': { setCachedProduct: async () => {} },
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (fakes[request] && parent && /bulkImportProcessor/.test(parent.filename)) return fakes[request];
  return origLoad.apply(this, arguments);
};
const { processOneJob } = require('../jobs/bulkImportProcessor');
Module._load = origLoad;

function makeItem(asin, country, url) {
  return { amazonUrl: url, asin, country, status: 'pending', queryId: null, submittedAt: null, product: null, draftId: null, error: null, outOfCredits: false };
}
function makeJob(items) {
  return { userId: 'u1', markupPercent: 10, status: 'queued', items, total: items.length, done: 0, failed: 0, submitAttempts: 0, lastError: null, finishedAt: null, save: async () => {} };
}
const fakeSave = async (userId, product) => { savedDrafts.push(product.asin); return { draft: { id: 'draft-' + product.asin } }; };

(async () => {
  // --- happy path across ticks, plus a credit shortfall that resolves later ---
  const job = makeJob([makeItem('B1', 'US', 'url1'), makeItem('B2', 'GB', 'url2')]);
  let pollCalls = 0;
  submitImpl = async (itemsByDomain) => {
    assert.deepStrictEqual(itemsByDomain.find((g) => g.domain === '.com').asins, ['B1']);
    assert.deepStrictEqual(itemsByDomain.find((g) => g.domain === '.co.uk').asins, ['B2']);
    return { accepted: [{ asin: 'B1', domain: '.com', queryId: 'q1' }, { asin: 'B2', domain: '.co.uk', queryId: 'q2' }], rejected: [], meta: null };
  };
  pollImpl = async () => { pollCalls++; return { status: 'pending' }; }; // tick 1: freshly submitted, not ready yet

  await processOneJob(job, fakeSave);
  assert.strictEqual(job.status, 'polling');
  assert.strictEqual(job.items[0].queryId, 'q1');
  assert.strictEqual(job.items[1].queryId, 'q2');
  assert.strictEqual(job.items[0].status, 'pending', 'still pending after a "pending" poll result');

  // tick 2: both resolve, but only one credit is available - exactly one item should be
  // saved and the other left "fetched" (order between B1/B2 isn't guaranteed since they
  // resolve concurrently, so the assertions below don't assume which one wins).
  pollImpl = async (queryId) => ({ status: 'success', raw: { asin: queryId === 'q1' ? 'B1' : 'B2' } });
  let creditChecks = 0;
  hasCreditsImpl = async () => creditChecks++ === 0; // only the first check succeeds
  await processOneJob(job, fakeSave);

  const doneAfterTick2 = job.items.filter((i) => i.status === 'done');
  const fetchedAfterTick2 = job.items.filter((i) => i.status === 'fetched');
  assert.strictEqual(doneAfterTick2.length, 1, 'exactly one item saved with the one available credit');
  assert.strictEqual(doneAfterTick2[0].draftId, 'draft-' + doneAfterTick2[0].asin);
  assert.strictEqual(fetchedAfterTick2.length, 1, 'the other item is fetched but not saved yet');
  assert.strictEqual(fetchedAfterTick2[0].outOfCredits, true);
  assert.strictEqual(job.status, 'polling', 'job is not done while an item is only "fetched"');
  assert.strictEqual(job.done, 1);

  // tick 3: credits topped up - the "fetched" item is retried without polling Easyparser again
  const pollCallsBefore = pollCalls;
  hasCreditsImpl = async () => true;
  submitImpl = async () => { throw new Error('should not resubmit - already has a product'); };
  await processOneJob(job, fakeSave);

  assert.strictEqual(pollCalls, pollCallsBefore, 'no new Easyparser poll for an already-fetched item');
  assert.strictEqual(job.items.every((i) => i.status === 'done'), true);
  assert.strictEqual(job.status, 'done', 'job finishes once every item is done or error');
  assert.ok(job.finishedAt);
  assert.deepStrictEqual(savedDrafts.sort(), ['B1', 'B2']);

  // --- rejected item never gets polled ---
  const job2 = makeJob([makeItem('B3', 'US', 'url3')]);
  submitImpl = async () => ({ accepted: [], rejected: [{ asin: 'B3', domain: '.com', reason: 'Invalid ASIN' }], meta: null });
  pollImpl = async () => { throw new Error('should not poll a rejected item'); };
  await processOneJob(job2, fakeSave);
  assert.strictEqual(job2.items[0].status, 'error');
  assert.strictEqual(job2.items[0].error, 'Invalid ASIN');
  assert.strictEqual(job2.status, 'done');
  assert.strictEqual(job2.failed, 1);

  // --- submit keeps failing: gives up after MAX_SUBMIT_ATTEMPTS and closes the job out ---
  const job3 = makeJob([makeItem('B4', 'US', 'url4')]);
  submitImpl = async () => { throw new Error('Easyparser is down'); };
  for (let i = 0; i < 5; i++) await processOneJob(job3, fakeSave);
  assert.strictEqual(job3.items[0].status, 'error');
  assert.strictEqual(job3.status, 'done');
  assert.strictEqual(job3.submitAttempts, 5);

  // --- an item stuck "pending" past the timeout is marked failed without a fresh poll call ---
  const job4 = makeJob([makeItem('B5', 'US', 'url5')]);
  job4.items[0].status = 'pending';
  job4.items[0].queryId = 'q5';
  job4.items[0].submittedAt = new Date(Date.now() - 31 * 60 * 1000); // 31 minutes ago
  job4.status = 'polling';
  pollImpl = async () => { throw new Error('should not poll a timed-out item'); };
  await processOneJob(job4, fakeSave);
  assert.strictEqual(job4.items[0].status, 'error');
  assert.ok(/Timed out/.test(job4.items[0].error));
  assert.strictEqual(job4.status, 'done');

  // --- dropped for the per-minute limit: only that item is sent again on the next run, and the job does not hang ---
  const job5 = makeJob([makeItem('B6', 'US', 'url6'), makeItem('B7', 'US', 'url7')]);
  const sent = [];
  submitImpl = async (groups) => {
    sent.push(groups[0].asins.slice());
    if (groups[0].asins.length === 2) return { accepted: [{ asin: 'B6', domain: '.com', queryId: 'q6' }], rejected: [{ asin: 'B7', domain: '.com', reason: '[!] Minute request limit exceeded.', retryable: true }], meta: null };
    return { accepted: [{ asin: 'B7', domain: '.com', queryId: 'q7' }], rejected: [], meta: null };
  };
  pollImpl = async () => ({ status: 'pending' });
  await processOneJob(job5, fakeSave);
  assert.strictEqual(job5.items[1].status, 'pending', 'not an error yet: it is tried again');
  assert.strictEqual(job5.items[1].queryId, null);
  assert.strictEqual(job5.status, 'polling');
  assert.strictEqual(job5.submitAttempts, 1);
  assert.ok(/limit exceeded/.test(job5.lastError), 'the job says why some products are waiting');
  await processOneJob(job5, fakeSave);
  assert.deepStrictEqual(sent, [['B6', 'B7'], ['B7']], 'the second run sends only the one that was dropped');
  assert.strictEqual(job5.items[1].queryId, 'q7');
  pollImpl = async (queryId) => ({ status: 'success', raw: { asin: queryId === 'q6' ? 'B6' : 'B7' } });
  hasCreditsImpl = async () => true;
  await processOneJob(job5, fakeSave);
  assert.strictEqual(job5.status, 'done');
  assert.strictEqual(job5.done, 2);

  // dropped every time: after MAX_SUBMIT_ATTEMPTS it is an error that says why (never a job that hangs)
  const job6 = makeJob([makeItem('B8', 'US', 'url8')]);
  submitImpl = async () => ({ accepted: [], rejected: [{ asin: 'B8', domain: '.com', reason: '[!] Minute request limit exceeded.', retryable: true }], meta: null });
  for (let i = 0; i < 4; i++) { await processOneJob(job6, fakeSave); assert.strictEqual(job6.items[0].status, 'pending'); assert.strictEqual(job6.status, 'polling'); }
  await processOneJob(job6, fakeSave);
  assert.strictEqual(job6.items[0].status, 'error');
  assert.ok(/limit exceeded/.test(job6.items[0].error));
  assert.strictEqual(job6.status, 'done');
  assert.strictEqual(job6.failed, 1);

  // an item that the answer does not mention at all ends the same way instead of waiting for ever
  const job7 = makeJob([makeItem('B9', 'US', 'url9')]);
  submitImpl = async () => ({ accepted: [], rejected: [], meta: null });
  for (let i = 0; i < 5; i++) await processOneJob(job7, fakeSave);
  assert.strictEqual(job7.items[0].status, 'error');
  assert.ok(/did not take/.test(job7.items[0].error));
  assert.strictEqual(job7.status, 'done');

  console.log('bulk import job tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
