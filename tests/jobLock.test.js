// The lock must report "acquired" for both result shapes Mongoose can return, and "not acquired" on E11000.
const assert = require('assert');
const mongoose = require('mongoose');

let mode = 'metadata-updated';
const seenOptions = [];
mongoose.models.JobLock = {
  findOneAndUpdate: async (_f, _u, opts) => {
    seenOptions.push(opts);
    if (mode === 'held') { const e = new Error('dup'); e.code = 11000; throw e; }
    if (mode === 'metadata-updated') return { value: { _id: 1 }, lastErrorObject: { updatedExisting: true } };
    if (mode === 'metadata-upserted') return { value: { _id: 1 }, lastErrorObject: { upserted: 'x' } };
    if (mode === 'plain-doc') return { _id: 1 };
    return null;
  },
};
const { acquireLock } = require('../services/jobLockService');

(async () => {
  for (const m of ['metadata-updated', 'metadata-upserted', 'plain-doc']) {
    mode = m;
    assert.strictEqual(await acquireLock('j', 1000), true, m + ' should acquire');
  }
  mode = 'held';
  assert.strictEqual(await acquireLock('j', 1000), false, 'held lock is not acquired');
  assert.ok(seenOptions.every((o) => o.includeResultMetadata === true && o.rawResult === undefined), 'uses includeResultMetadata');
  console.log('job lock tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
