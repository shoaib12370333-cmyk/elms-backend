const crypto = require('crypto');
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
  owner: { type: String, default: null }, // set by acquireLease: who holds it, so only the holder can renew or release it
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
async function acquireLock(jobName, durationMs, owner = null) {
  const now = new Date();
  const lockedUntil = new Date(now.getTime() + durationMs);

  try {
    const result = await JobLock.findOneAndUpdate(
      {
        jobName,
        $or: [{ lockedUntil: { $lte: now } }, { lockedUntil: { $exists: false } }],
      },
      { jobName, lockedAt: now, lockedUntil, owner },
      { upsert: true, new: true, includeResultMetadata: true }
    );

    // If this call created a brand-new document (via upsert) or updated an
    // existing expired one, we got the lock.
    // Mongoose 8 removed 'rawResult'; 'includeResultMetadata' returns { value, lastErrorObject }. A document only
    // comes back when the filter matched (expired lock) or the upsert inserted - a held lock ends in E11000 below.
    if (result && result.lastErrorObject) {
      return !!result.lastErrorObject.updatedExisting || !!result.lastErrorObject.upserted;
    }
    return !!(result && result._id);
  } catch (err) {
    // A duplicate-key error here means another instance's upsert won the
    // race for a brand-new lock document - we simply didn't get it.
    if (err.code === 11000) return false;
    throw err;
  }
}

/**
 * A lock that is HELD until the run is over, for a job that can take longer than its schedule (the publish queue, a bulk import).
 * acquireLock only lasts durationMs: a run that takes longer than that is joined by the next tick and the two work on the same
 * things (a listing published twice, an item charged twice, a mail sent twice). With a lease the next tick finds it taken and skips.
 * If the process dies the lease simply runs out after durationMs.
 * @returns {Promise<string|null>} a token to renew / release it with, or null when another run holds it
 */
async function acquireLease(jobName, durationMs) {
  const token = crypto.randomUUID();
  return (await acquireLock(jobName, durationMs, token)) ? token : null;
}

/** Keeps a lease for another durationMs (call it between the parts of a long run). False when it was lost. */
async function renewLease(jobName, token, durationMs) {
  const res = await JobLock.updateOne({ jobName, owner: token }, { $set: { lockedUntil: new Date(Date.now() + durationMs) } });
  return !!(res && (res.modifiedCount || res.nModified || res.matchedCount));
}

/** Gives a lease back at the end of a run so the next tick can start at once. */
async function releaseLease(jobName, token) {
  await JobLock.updateOne({ jobName, owner: token }, { $set: { lockedUntil: new Date() } });
}

/**
 * Runs `work({ renew })` while holding the lease of `jobName`, and always gives it back. Returns { skipped: true } without running
 * anything when another run holds it. `renew()` extends the lease by durationMs.
 */
async function withLease(jobName, durationMs, work) {
  const token = await acquireLease(jobName, durationMs).catch(() => null);
  if (!token) return { skipped: true };
  try {
    return { skipped: false, result: await work({ renew: () => renewLease(jobName, token, durationMs).catch(() => false) }) };
  } finally {
    await releaseLease(jobName, token).catch(() => {});
  }
}

module.exports = { acquireLock, acquireLease, renewLease, releaseLease, withLease };
