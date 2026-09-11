const mongoose = require('mongoose');

/**
 * A simple distributed lock, stored in MongoDB, so that if this app is ever
 * scaled to run on multiple server instances, only ONE instance actually
 * executes a given scheduled job at a time (the others skip it for that run).
 *
 * This matters once there's more than one instance - right now (a single
 * Render instance) it's a no-op safety net, but it means scaling up later
 * won't cause jobs like stock-monitor or order-sync to run duplicated,
 * double-charging credits or double-syncing orders.
 */
const lockSchema = new mongoose.Schema({
  jobName: { type: String, required: true, unique: true },
  lockedAt: { type: Date, required: true },
  lockedUntil: { type: Date, required: true },
});
const JobLock = mongoose.models.JobLock || mongoose.model('JobLock', lockSchema);

/**
 * Attempts to acquire a lock for the given job name, valid for
 * durationMs. Returns true if the lock was acquired (safe to run the job),
 * or false if another instance already holds a still-valid lock for it.
 *
 * Uses an atomic findOneAndUpdate with an upsert, so even if two instances
 * call this at the exact same moment, only one succeeds - MongoDB
 * guarantees the atomicity of the single document write.
 */
async function acquireLock(jobName, durationMs) {
  const now = new Date();
  const lockedUntil = new Date(now.getTime() + durationMs);

  try {
    const result = await JobLock.findOneAndUpdate(
      {
        jobName,
        $or: [{ lockedUntil: { $lte: now } }, { lockedUntil: { $exists: false } }],
      },
      { jobName, lockedAt: now, lockedUntil },
      { upsert: true, new: true, rawResult: true }
    );

    // If this call created a brand-new document (via upsert) or updated an
    // existing expired one, we got the lock.
    return !!result.lastErrorObject?.updatedExisting || !!result.lastErrorObject?.upserted;
  } catch (err) {
    // A duplicate-key error here means another instance's upsert won the
    // race for a brand-new lock document - we simply didn't get it.
    if (err.code === 11000) return false;
    throw err;
  }
}

module.exports = { acquireLock };
