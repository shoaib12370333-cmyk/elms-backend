// Checks announcement batching: batch size, daily cap, cursor, completion. No database or SMTP needed.
const assert = require('assert');
const Module = require('module');

process.env.JWT_SECRET = 'test-secret';

const users = Array.from({ length: 45 }, (_, i) => ({ _id: String(1000 + i), email: 'u' + i + '@x.com' }));
const ann = { status: 'sending', cursor: null, sent: 0, failed: 0, failedUsers: [], subject: 's', body: 'b', async save() {}, markModified() {} };
let quota = 0;
const sentTo = [];
let failFor = () => false;
let limits = { mailBatchSize: 20, mailDailyCap: 30, bulkImportMax: 25 };

const fakes = {
  '../models/schemas/User': {
    countDocuments: async () => users.length,
    find(q) {
      let list = users.filter((u) => !q._id || u._id > q._id.$gt);
      const chain = { sort: () => chain, limit: (n) => { list = list.slice(0, n); return chain; }, select: () => chain, lean: async () => list };
      return chain;
    },
  },
  '../models/schemas/Announcement': {
    findOne: (q) => (q && q._id ? Promise.resolve(null) : { sort: async () => (ann.status === 'sending' ? ann : null) }),
    findById: async () => ann,
  },
  '../models/schemas/MailQuota': {
    findOne: () => ({ lean: async () => ({ count: quota }) }),
    updateOne: async (_q, u) => { quota += u.$inc.count; },
  },
  '../models/settingsModel': { getLimits: async () => limits },
  './emailService': { sendAnnouncementEmail: async ({ to }) => { if (failFor(to)) throw new Error('535 auth failed'); sentTo.push(to); }, senderAddress: () => 'support@elmstool.com' },
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (fakes[request] && parent && /announcementService/.test(parent.filename)) return fakes[request];
  return origLoad.apply(this, arguments);
};
const svc = require('../services/announcementService');
Module._load = origLoad;

(async () => {
  let r = await svc.sendNextBatch();
  assert.strictEqual(r.sent, 20, 'first batch is the batch size');
  r = await svc.sendNextBatch();
  assert.strictEqual(r.sent, 10, 'second batch is cut to what is left of the daily cap');
  r = await svc.sendNextBatch();
  assert.strictEqual(r.capped, true, 'daily cap stops sending');
  assert.strictEqual(sentTo.length, 30);
  assert.strictEqual(new Set(sentTo).size, 30, 'nobody is mailed twice');

  limits = { mailBatchSize: 20, mailDailyCap: 1000, bulkImportMax: 25 };
  await svc.sendNextBatch();
  await svc.sendNextBatch();
  assert.strictEqual(sentTo.length, 45);
  assert.strictEqual(new Set(sentTo).size, 45, 'still nobody twice');
  r = await svc.sendNextBatch();
  assert.strictEqual(ann.status, 'done', 'announcement finishes when the list is exhausted');
  // --- failures ---
  const users0 = users.length;
  Object.assign(ann, { status: 'sending', cursor: null, sent: 0, failed: 0, failedUsers: [], lastError: null });
  limits = { mailBatchSize: 10, mailDailyCap: 100000, bulkImportMax: 25 };
  sentTo.length = 0; quota = 0;

  failFor = () => true; // whole batch fails -> pause, keep position, show reason
  r = await svc.sendNextBatch();
  assert.strictEqual(r.paused, true);
  assert.strictEqual(ann.status, 'paused');
  assert.strictEqual(ann.cursor, null, 'position kept when everything failed');
  assert.ok(/auth failed/.test(ann.lastError));

  failFor = (to) => to === 'u3@x.com' || to === 'u7@x.com'; // partial failure
  ann.status = 'sending'; ann.lastError = null;
  r = await svc.sendNextBatch();
  assert.strictEqual(r.sent, 8);
  assert.strictEqual(ann.failed, 2);
  assert.deepStrictEqual(ann.failedUsers.map((f) => f.email), ['u3@x.com', 'u7@x.com']);

  while (ann.status === 'sending') await svc.sendNextBatch(); // finish the rest
  assert.strictEqual(ann.status, 'done');
  assert.strictEqual(sentTo.length, users0 - 2);

  failFor = () => false; // provider fixed -> retry only the failed ones
  const n = await svc.retryFailed('x');
  assert.strictEqual(n, 2);
  assert.strictEqual(ann.status, 'sending');
  while (ann.status === 'sending') await svc.sendNextBatch();
  assert.strictEqual(ann.status, 'done');
  assert.strictEqual(ann.failed, 0);
  assert.strictEqual(ann.failedUsers.length, 0);
  assert.strictEqual(sentTo.length, users0, 'everyone got exactly one mail');
  assert.strictEqual(new Set(sentTo).size, users0);
  console.log('announcement tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
