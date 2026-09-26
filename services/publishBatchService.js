const PublishBatch = require('../models/schemas/PublishBatch');
const Listing = require('../models/schemas/Listing');
const { createSystemNotification } = require('../models/systemNotificationsModel');
const { mapPool } = require('./asyncPool');

/**
 * "Publish all" is one batch. It answers at once ("your products are being published") and the person is told when the whole batch is
 * done: a notification in the bell (also when the page was closed), with how many went live and how many failed.
 */

async function createBatch(userId, listingIds, skipped = 0) {
  const ids = [...new Set((listingIds || []).map(String))];
  if (!ids.length) return null;
  const doc = await PublishBatch.create({ userId, listingIds: ids, total: ids.length, skipped: Number(skipped) || 0 });
  return { id: String(doc._id), total: doc.total };
}

/**
 * Starts a whole selection: every listing is claimed (status "publishing", atomically: one already being published or live is left
 * alone) up to 20 at a time, put in line for the background runner, and recorded as one batch. Answers at once: what eBay does with
 * them happens in the background.
 * @param {{ claim: (userId, id) => Promise<object|null>, enqueue: (userId, listing) => any, getListing: (userId, id) => Promise<object|null>, createBatch?: Function }} deps
 */
async function startBatch(userId, ids, deps) {
  const claims = await mapPool(ids, 20, async (id) => ({ id, listing: await deps.claim(userId, id) }));
  const started = claims.filter((c) => c.listing).map((c) => c.listing);
  const notStarted = claims.filter((c) => !c.listing).map((c) => c.id);
  for (const listing of started) deps.enqueue(userId, listing);
  const batch = started.length ? await (deps.createBatch || createBatch)(userId, started.map((l) => l.id), notStarted.length) : null;
  // the reason for the first few that were not started
  const skipped = await mapPool(notStarted.slice(0, 20), 10, async (id) => {
    const l = await deps.getListing(userId, id).catch(() => null);
    const error = !l ? 'Not found.' : l.status === 'published' ? 'Already published.' : l.status === 'publishing' ? 'Already being published.' : 'Could not be started.';
    return { id, title: l ? (l.title || l.sku || null) : null, error };
  });
  return { started: started.length, notStarted: notStarted.length, skipped, batchId: batch ? batch.id : null };
}

/** How a batch is going: { total, published, failed, publishing, other, done }. null when it is not this user's batch. */
async function batchProgress(userId, batchId) {
  if (!/^[a-f0-9]{24}$/i.test(String(batchId || ''))) return null;
  const batch = await PublishBatch.findOne({ _id: batchId, userId }).lean();
  if (!batch) return null;
  const rows = await Listing.aggregate([{ $match: { _id: { $in: batch.listingIds } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]);
  const by = {};
  for (const r of rows) by[r._id] = r.n;
  const publishing = by.publishing || 0;
  const published = by.published || 0;
  const failed = by.error || 0;
  return { id: String(batch._id), total: batch.total, published, failed, publishing, other: Math.max(0, batch.total - published - failed - publishing), done: !publishing, startedAt: batch.startedAt };
}

/** The words of the notification. `by` is how many of the batch are in each status. */
function summaryOf(total, by) {
  const published = by.published || 0;
  const failed = by.error || 0;
  if (!failed) {
    return {
      level: 'success',
      title: 'Publishing finished',
      message: published >= total
        ? (total === 1 ? 'Your product was published to eBay.' : 'All ' + total + ' of your products were published to eBay.')
        : published + ' of your ' + total + ' products were published to eBay.',
    };
  }
  return {
    level: 'warning',
    title: 'Publishing finished, ' + failed + ' failed',
    message: published + ' of your ' + total + ' products were published to eBay and ' + failed + ' failed. Open Drafts: the failed ones are under "Needs attention" with the reason, and you can retry them there.',
  };
}

/**
 * Makes the notification for every batch whose listings have all finished (none is "publishing" any more). Once per batch: the
 * marker is set by one atomic update, so two runs at the same moment (or two servers) never send it twice.
 * @returns {Promise<number>} how many batches were finished now
 */
async function finishDueBatches({ limit = 50 } = {}) {
  const open = await PublishBatch.find({ notifiedAt: null }).sort({ startedAt: 1 }).limit(limit).lean();
  let finished = 0;
  for (const batch of open) {
    const rows = await Listing.aggregate([{ $match: { _id: { $in: batch.listingIds } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]);
    const by = {};
    for (const r of rows) by[r._id] = r.n;
    if (by.publishing) continue; // still going
    const mine = await PublishBatch.findOneAndUpdate({ _id: batch._id, notifiedAt: null }, { $set: { notifiedAt: new Date() } });
    if (!mine) continue; // someone else made it
    const words = summaryOf(batch.total, by);
    try {
      await createSystemNotification(batch.userId, { type: 'publish_batch_done', ...words, metadata: { batchId: String(batch._id), total: batch.total, published: by.published || 0, failed: by.error || 0, skipped: batch.skipped || 0 } });
    } catch (err) {
      console.warn('[publish-batch] could not make the notification:', err.message);
    }
    finished += 1;
  }
  return finished;
}

module.exports = { createBatch, finishDueBatches, startBatch, batchProgress, summaryOf };
