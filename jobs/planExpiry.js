const cron = require('node-cron');
const { acquireLock } = require('../services/jobLockService');
const { expireDuePlans } = require('../services/planExpiryService');

/** Every hour (and shortly after start-up): close the monthly / yearly plans that have run out. */
function startPlanExpiry() {
  const run = async () => {
    const gotLock = await acquireLock('plan-expiry', 10 * 60 * 1000).catch(() => false);
    if (!gotLock) return;
    try {
      const closed = await expireDuePlans();
      if (closed) console.log('[plans] ' + closed + ' plan(s) ended.');
    } catch (err) {
      console.error('[plans] Expiry run failed:', err.message);
    }
  };
  cron.schedule('7 * * * *', run);
  setTimeout(run, 45 * 1000);
  console.log('[plans] Plan expiry scheduled (every hour).');
}

module.exports = { startPlanExpiry };
