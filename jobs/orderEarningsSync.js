const cron = require('node-cron');
const EbayAccount = require('../models/schemas/EbayAccount');
const { getEbayAccountRefreshToken } = require('../models/ebayAccountsModel');
const { listOrdersNeedingEarnings, setOrderEarningsBulk } = require('../models/ordersModel');
const { fetchSaleTransactionsForOrder, netEarningFromTransactions } = require('../services/ebayFinancesService');
const { acquireLock } = require('../services/jobLockService');

// Gives eBay time to settle a sale into a Finances transaction before the first attempt - a brand-new order's payout
// is rarely available within minutes of payment.
const MIN_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Splits one eBay order's total net earning across its ELMS line items, proportional to each line's own sale price -
 * eBay's fee data here is fetched at the order level (services/ebayFinancesService.js), not reliably per line item. A
 * single-line order (the common case) gets the whole amount.
 */
function splitProportionally(totalAmount, lines) {
  const withPrice = lines.filter((l) => Number.isFinite(Number(l.salePrice)) && Number(l.salePrice) > 0);
  if (!withPrice.length) {
    // No usable sale price to split by - give it all to the first line rather than losing the figure entirely.
    return [{ id: String(lines[0]._id), orderEarning: totalAmount }];
  }
  const sum = withPrice.reduce((s, l) => s + Number(l.salePrice), 0);
  return withPrice.map((l) => ({ id: String(l._id), orderEarning: totalAmount * (Number(l.salePrice) / sum) }));
}

/** A seller who hasn't reconnected eBay since sell.finances was added fails every call the same way - stop after the
 * first such failure for this account instead of repeating the same warning once per pending order. */
function looksLikeMissingScope(err) {
  return err.statusCode === 401 || err.statusCode === 403;
}

async function syncOneAccount(account) {
  const refreshToken = await getEbayAccountRefreshToken(account.userId.toString(), account._id.toString());
  if (!refreshToken) return { updated: 0 };

  const pending = await listOrdersNeedingEarnings(account._id, MIN_AGE_MS);
  if (!pending.length) return { updated: 0 };

  const byOrder = new Map();
  for (const line of pending) {
    if (!byOrder.has(line.ebayOrderId)) byOrder.set(line.ebayOrderId, []);
    byOrder.get(line.ebayOrderId).push(line);
  }

  const updates = [];
  for (const [ebayOrderId, lines] of byOrder) {
    try {
      const transactions = await fetchSaleTransactionsForOrder(refreshToken, ebayOrderId, account.marketplaceId);
      const earning = netEarningFromTransactions(transactions);
      if (!earning) continue; // not settled on eBay's side yet - try again next run
      updates.push(...splitProportionally(earning.amount, lines));
    } catch (err) {
      if (looksLikeMissingScope(err)) {
        console.warn(`[order-earnings] ${account.ebayUserId}: ${err.message} - likely needs to reconnect eBay for the new Finances permission. Skipping this account for now.`);
        break;
      }
      console.warn(`[order-earnings] ${account.ebayUserId} order ${ebayOrderId}: ${err.message}`);
    }
  }
  if (!updates.length) return { updated: 0 };
  const updated = await setOrderEarningsBulk(updates);
  return { updated };
}

async function runOrderEarningsSync() {
  const accounts = await EbayAccount.find({ disconnectedAt: null });
  let totalUpdated = 0;
  for (const account of accounts) {
    try {
      const { updated } = await syncOneAccount(account);
      totalUpdated += updated;
    } catch (err) {
      console.error(`[order-earnings] Could not sync earnings for ${account.ebayUserId}: ${err.message}`);
    }
  }
  if (totalUpdated) console.log(`[order-earnings] Filled in eBay earnings for ${totalUpdated} order line(s).`);
}

/** Runs every 6 hours - eBay payouts settle over hours, not minutes, so there is no benefit to checking more often. */
function startOrderEarningsSync() {
  cron.schedule('30 */6 * * *', async () => {
    const gotLock = await acquireLock('order-earnings-sync', 10 * 60 * 1000).catch(() => false);
    if (!gotLock) return;
    runOrderEarningsSync().catch((err) => console.error('[order-earnings] Unexpected error:', err.message));
  });
  console.log('[order-earnings] Order earnings sync scheduled (every 6 hours).');
}

module.exports = { startOrderEarningsSync, runOrderEarningsSync, splitProportionally };
