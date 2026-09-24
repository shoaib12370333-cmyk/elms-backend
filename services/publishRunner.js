/**
 * Publishes listings in the background, so the person does not sit and wait for eBay (a publish can take a minute or more).
 *
 * The route claims the listing first (status "publishing", so nothing else touches it), answers at once, and hands it here.
 * At most MAX_RUNNING publishes run at the same time - eBay answers "system error" when it is hit with many at once - and the
 * waiting ones are served one user at a time in turn, so one person publishing hundreds does not hold up everybody else.
 * The result lives on the listing itself (published / error + the message), which the app reads back; a listing whose publish
 * was interrupted by a restart is turned into "error" by recoverStalePublishingListings after 30 minutes.
 */
const MAX_RUNNING = 3;

let running = 0;
const queues = new Map();   // userId -> [job]
const rotation = [];        // users with waiting jobs, in the order they are served
const known = new Set();    // listing ids that are waiting or running (a listing is never queued twice)

// Replaceable for tests; by default the real ones (loaded when first needed, so requiring this file is cheap).
const hooks = {
  process: (listing) => require('./publishQueueService').processOneQueuedListing(listing),
  fail: (userId, id, message) => require('../models/listingsModel').markError(userId, id, message),
};

function nextJob() {
  while (rotation.length) {
    const userId = rotation.shift();
    const queue = queues.get(userId);
    if (!queue || !queue.length) { queues.delete(userId); continue; }
    const job = queue.shift();
    if (queue.length) rotation.push(userId); else queues.delete(userId);
    return job;
  }
  return null;
}

async function run(job) {
  try {
    // A failed publish comes back as the listing in "error" status (it does not throw); nothing more to do then.
    await hooks.process(job.listing);
  } catch (err) {
    console.error(`[publish-runner] ${job.id}:`, err && err.message);
    try { await hooks.fail(job.userId, job.id, (err && err.message) || 'eBay listing publish failed.'); } catch (markErr) { console.error('[publish-runner] could not mark the listing failed:', markErr.message); }
  }
}

function pump() {
  while (running < MAX_RUNNING) {
    const job = nextJob();
    if (!job) return;
    running += 1;
    run(job).finally(() => { running -= 1; known.delete(job.id); pump(); });
  }
}

/** Puts an already-claimed listing in line. Returns false when it is already waiting or running. */
function enqueuePublish(userId, listing) {
  const id = String(listing.id || listing._id);
  if (known.has(id)) return false;
  known.add(id);
  const key = String(userId);
  if (!queues.has(key)) queues.set(key, []);
  queues.get(key).push({ userId, id, listing });
  if (!rotation.includes(key)) rotation.push(key);
  pump();
  return true;
}

const stats = () => ({ running, waiting: [...queues.values()].reduce((n, q) => n + q.length, 0) });

module.exports = { enqueuePublish, stats, hooks, MAX_RUNNING };
