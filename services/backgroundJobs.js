/**
 * Runs a slow piece of work in the background and lets the page ask how it is going, so a button press does not keep the
 * person waiting for eBay (syncing messages or orders can take a minute).
 *
 * One job per key (for example "messages:<user>:<store>"): pressing the button again while it runs joins the running job
 * instead of starting a second one. The last result is kept for a few minutes so the page can read it once it is done.
 * Kept in memory: after a restart the page simply sees "no job" and loads the saved data.
 */
const KEEP_MS = 10 * 60 * 1000;
const jobs = new Map();

const snapshot = (job) => (job ? { status: job.status, startedAt: job.startedAt, finishedAt: job.finishedAt, result: job.result, error: job.error } : null);

/**
 * @param {string} key
 * @param {() => Promise<any>} work
 * @returns {{ started: boolean, job: object }} started=false when the same job was already running
 */
function startJob(key, work) {
  const running = jobs.get(key);
  if (running && running.status === 'running') return { started: false, job: snapshot(running) };

  const job = { status: 'running', startedAt: Date.now(), finishedAt: null, result: null, error: null };
  jobs.set(key, job);
  Promise.resolve()
    .then(work)
    .then((result) => { job.status = 'done'; job.result = result === undefined ? null : result; })
    .catch((err) => { job.status = 'error'; job.error = (err && err.message) || 'The job failed.'; console.error(`[background-job] ${key}:`, job.error); })
    .finally(() => {
      job.finishedAt = Date.now();
      const timer = setTimeout(() => { if (jobs.get(key) === job) jobs.delete(key); }, KEEP_MS);
      if (timer.unref) timer.unref();
    });
  return { started: true, job: snapshot(job) };
}

/** The job for this key (running, or finished within the last few minutes), or null. */
function getJob(key) {
  return snapshot(jobs.get(key));
}

module.exports = { startJob, getJob };
