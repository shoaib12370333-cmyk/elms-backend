// Checks announcement batching: batch size, daily cap, cursor, completion. No database or SMTP needed.
const assert = require('assert');
const Module = require('module');

process.env.JWT_SECRET = 'test-secret';

const users = Array.from({ length: 45 }, (_, i) => ({ _id: String(1000 + i), email: 'u' + i + '@x.com' }));
const ann = { status: 'sending', cursor: null, sent: 0, failed: 0, subject: 's', body: 'b', async save() {} };
let quota = 0;
const sentTo = [];
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
  '../models/schemas/Announcement': { findOne: () => ({ sort: async () => (ann.status === 'sending' ? ann : null) }) },
  '../models/schemas/MailQuota': {
    findOne: () => ({ lean: async () => ({ count: quota }) }),
    updateOne: async (_q, u) => { quota += u.$inc.count; },
  },
  '../models/settingsModel': { getLimits: async () => limits },
  './emailService': { sendAnnouncementEmail: async ({ to }) => { sentTo.push(to); }, senderAddress: () => 'support@elmstool.com' },
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
  console.log('announcement tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
