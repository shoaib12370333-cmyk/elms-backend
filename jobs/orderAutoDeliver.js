const cron = require('node-cron');
const { autoMarkDelivered } = require('../models/ordersModel');
const { acquireLock } = require('../services/jobLockService');

async function runOrderAutoDeliver() {
  const updated = await autoMarkDelivered(new Date());
  if (updated) console.log(`[order-auto-deliver] Marked ${updated} order(s) as delivered (past their estimated delivery date).`);
}

/** Once a day is enough - this only ever moves a date-based status forward once that date has already passed, nothing time-critical about running it more often. */
function startOrderAutoDeliver() {
  cron.schedule('0 3 * * *', async () => {
    const gotLock = await acquireLock('order-auto-deliver', 10 * 60 * 1000).catch(() => false);
    if (!gotLock) return;
    runOrderAutoDeliver().catch((err) => console.error('[order-auto-deliver] Unexpected error:', err.message));
  });
  console.log('[order-auto-deliver] Order auto-deliver scheduled (daily at 03:00).');
}

module.exports = { startOrderAutoDeliver, runOrderAutoDeliver };
