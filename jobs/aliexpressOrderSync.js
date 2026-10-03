const cron = require('node-cron');
const { acquireLock } = require('../services/jobLockService');

/**
 * Keeps the AliExpress orders ELMS placed up to date: every 30 minutes it reads the status, total and shipment of each open one back
 * from AliExpress (services/aliexpressOrderService.js refreshOrder). It ONLY reads and saves - it never places, pays, or sends a
 * tracking number to eBay or the buyer; those stay the seller's clicks. It also turns a claim that has been "in flight" for far too
 * long (the server stopped mid-request) into UNKNOWN, so the seller is told to check AliExpress instead of seeing it stuck.
 */

const MAX_FAILURES_PER_USER = 3; // AliExpress is not answering for this seller (a dead connection): leave their other orders for the next run

// Replaceable for tests.
const deps = {
  expireStale: () => require('../models/ordersModel').expireStalePlacingAliexpressOrders(),
  list: () => require('../models/ordersModel').listAliexpressOrdersToSync({ limit: 200 }),
  refresh: (userId, orderId) => require('../services/aliexpressOrderService').refreshOrder(userId, orderId),
};

async function runAliexpressOrderSync(d = deps) {
  const expired = await d.expireStale();
  if (expired) console.warn(`[aliexpress-orders] ${expired} order(s) were still "being placed" long after the request: marked unknown, the seller must check AliExpress.`);
  const rows = await d.list();
  const failures = new Map();
  let refreshed = 0;
  for (const row of rows) {
    const userId = String(row.userId);
    if ((failures.get(userId) || 0) >= MAX_FAILURES_PER_USER) continue;
    try {
      const out = await d.refresh(userId, String(row._id));
      if (out && out.error === 'changed') continue; // the line changed while it was being read (a click or another run got there first): nothing is wrong, the next run reads it again
      if (out && out.error) throw new Error(out.message || out.error);
      refreshed += 1;
      failures.set(userId, 0);
    } catch (err) {
      failures.set(userId, (failures.get(userId) || 0) + 1);
      console.warn(`[aliexpress-orders] could not refresh order ${row._id}: ${err.message}`);
    }
  }
  if (refreshed) console.log(`[aliexpress-orders] refreshed ${refreshed} AliExpress order(s).`);
  return { refreshed, expired };
}

/** Every 30 minutes. A run with nothing open costs one database read. */
function startAliexpressOrderSync() {
  cron.schedule('*/30 * * * *', async () => {
    const gotLock = await acquireLock('aliexpress-order-sync', 25 * 60 * 1000).catch(() => false);
    if (!gotLock) return;
    runAliexpressOrderSync().catch((err) => console.error('[aliexpress-orders] Unexpected error:', err.message));
  });
  console.log('[aliexpress-orders] AliExpress order sync scheduled (every 30 minutes).');
}

module.exports = { startAliexpressOrderSync, runAliexpressOrderSync, deps, MAX_FAILURES_PER_USER };
