const BulkImportJob = require('./schemas/BulkImportJob');

async function createBulkImportJob(userId, { ebayAccountId, markupPercent, items }) {
  const doc = await BulkImportJob.create({
    userId,
    ebayAccountId: ebayAccountId || null,
    markupPercent: markupPercent || 0,
    items,
    total: items.length,
  });
  return serialize(doc);
}

/** How many imports the user has running and how many of their products still wait to be saved (each needs a credit). */
async function activeJobStats(userId) {
  const rows = await BulkImportJob.find({ userId, status: { $in: ['queued', 'submitting', 'polling'] } }).select('total done failed').lean();
  return { jobs: rows.length, pendingItems: rows.reduce((n, r) => n + Math.max(0, (r.total || 0) - (r.done || 0) - (r.failed || 0)), 0) };
}

async function getBulkImportJob(userId, id) {
  const doc = await BulkImportJob.findOne({ _id: id, userId });
  return doc ? serialize(doc) : null;
}

/** Newest 20 jobs for this user, items omitted (they can be large) - the list is a summary. */
async function listBulkImportJobs(userId) {
  const docs = await BulkImportJob.find({ userId }).select('-items').sort({ createdAt: -1 }).limit(20).lean();
  return docs.map((d) => serializeSummary(d));
}

async function cancelBulkImportJob(userId, id) {
  const doc = await BulkImportJob.findOneAndUpdate(
    { _id: id, userId, status: { $in: ['queued', 'submitting', 'polling'] } },
    { status: 'cancelled', finishedAt: new Date() },
    { new: true }
  );
  return doc ? serialize(doc) : null;
}

/** Re-queues a finished job's failed items. Items marked outOfCredits just retry the save (no new Easyparser call); genuine Easyparser failures are resubmitted. */
async function retryBulkImportJob(userId, id) {
  const doc = await BulkImportJob.findOne({ _id: id, userId });
  if (!doc) return null;
  if (doc.status === 'submitting' || doc.status === 'polling') throw new Error('This job is still running.');
  const retryable = doc.items.filter((i) => i.status === 'error');
  if (!retryable.length) throw new Error('There are no failed items to retry.');
  for (const item of retryable) {
    if (item.outOfCredits) {
      item.status = 'fetched'; // product already known - processor will just re-attempt the save
    } else {
      item.status = 'pending'; // will be resubmitted to Easyparser
      item.queryId = null;
      item.submittedAt = null;
    }
    item.error = null;
    item.outOfCredits = false;
  }
  doc.status = doc.items.some((i) => i.status === 'pending') ? 'queued' : 'polling';
  doc.lastError = null;
  doc.finishedAt = null;
  await doc.save();
  return serialize(doc);
}

function serializeItem(item) {
  return {
    amazonUrl: item.amazonUrl,
    asin: item.asin,
    country: item.country,
    status: item.status,
    draftId: item.draftId || null,
    error: item.error || null,
    outOfCredits: !!item.outOfCredits,
  };
}

function serialize(doc) {
  const obj = doc.toObject ? doc.toObject() : doc;
  return {
    id: String(obj._id),
    status: obj.status,
    total: obj.total,
    done: obj.done,
    failed: obj.failed,
    pending: obj.total - obj.done - obj.failed,
    lastError: obj.lastError || null,
    items: (obj.items || []).map(serializeItem),
    createdAt: obj.createdAt,
    finishedAt: obj.finishedAt,
  };
}

function serializeSummary(obj) {
  return {
    id: String(obj._id),
    status: obj.status,
    total: obj.total,
    done: obj.done,
    failed: obj.failed,
    pending: obj.total - obj.done - obj.failed,
    createdAt: obj.createdAt,
    finishedAt: obj.finishedAt,
  };
}

module.exports = {
  activeJobStats,
  createBulkImportJob,
  getBulkImportJob,
  listBulkImportJobs,
  cancelBulkImportJob,
  retryBulkImportJob,
};
