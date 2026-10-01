const cron = require('node-cron');
const EbayAccount = require('../models/schemas/EbayAccount');
const { getEbayAccountRefreshToken } = require('../models/ebayAccountsModel');
const { listOrdersNeedingEarnings, setOrderEarningsBulk } = require('../models/ordersModel');
const { fetchSaleTransactionsForOrder, netEarningFromTransactions } = require('../services/ebayFinancesService');
const { acquireLock } = require('../services/jobLockService');
const { isUnrecoverableEbayAuthError } = require('../services/ebayAuthErrorService');

// Tried from the moment an order is PAID - no fixed wait. eBay does not always have a settled Finances
// transaction for a brand-new sale yet; when it doesn't, netEarningFromTransactions returns null and the order is
// simply left for the next run (see syncOneAccount below), so trying early costs nothing and picks it up the moment
// eBay does have it.
const MIN_AGE_MS = 0;

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

// A seller who hasn't reconnected eBay since sell.finances was added, or whose refresh token has gone dead/been
// revoked, fails every call the same way - stop after the first such failure for this account instead of repeating
// the same warning once per pending order (a real production account was seen hitting eBay's token endpoint once
// per pending order, every 5 minutes, indefinitely, because this used to only match the "invalid scope" wording -
// confirmed 2026-09-30; now shared with jobs/orderSync.js via services/ebayAuthErrorService.js).
const looksLikeMissingScope = isUnrecoverableEbayAuthError;

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
  let errorCount = 0;
  let lastError = null;
  for (const [ebayOrderId, lines] of byOrder) {
    try {
      const transactions = await fetchSaleTransactionsForOrder(refreshToken, ebayOrderId, account.marketplaceId);
      const earning = netEarningFromTransactions(transactions);
      if (!earning) continue; // not settled on eBay's side yet - try again next run
      updates.push(...splitProportionally(earning.amount, lines));
    } catch (err) {
      errorCount += 1;
      lastError = err.message;
      if (looksLikeMissingScope(err)) {
        console.warn(`[order-earnings] ${account.ebayUserId}: ${err.message} - likely needs to reconnect eBay for the new Finances permission. Skipping this account for now.`);
        break;
      }
      console.warn(`[order-earnings] ${account.ebayUserId} order ${ebayOrderId}: ${err.message}`);
    }
  }
  // Surfaced in Settings (ebayAccountsModel.js serialize) so a permanently-stuck account is visible, not just logged.
  // Not just the missing-scope case (above): ANY error that stops every single order this run from getting an
  // earning - a wrong/stale marketplaceId on the account, a malformed request, whatever eBay actually says - would
  // otherwise retry silently forever with nothing to see but a server log line. A run where at least one order came
  // back fine (even if another failed) is left alone: that is normal, partial, and not worth a scary warning.
  const allFailed = errorCount > 0 && !updates.length;
  if (allFailed) {
    if (account.financesSyncError !== lastError) await EbayAccount.updateOne({ _id: account._id }, { $set: { financesSyncError: lastError } }).catch(() => {});
  } else if (errorCount === 0 && account.financesSyncError) {
    await EbayAccount.updateOne({ _id: account._id }, { $set: { financesSyncError: null } }).catch(() => {});
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

/** Runs every 5 minutes, same as the order sync (jobs/orderSync.js) - so a fresh order's earning fills in within
 * minutes of eBay settling it rather than waiting for a slower cron. A run only ever calls eBay for orders that are
 * still missing their earning (listOrdersNeedingEarnings), so an account with nothing pending costs nothing. */
function startOrderEarningsSync() {
  cron.schedule('*/5 * * * *', async () => {
    const gotLock = await acquireLock('order-earnings-sync', 4 * 60 * 1000).catch(() => false);
    if (!gotLock) return;
    runOrderEarningsSync().catch((err) => console.error('[order-earnings] Unexpected error:', err.message));
  });
  console.log('[order-earnings] Order earnings sync scheduled (every 5 minutes).');
}

module.exports = { startOrderEarningsSync, runOrderEarningsSync, splitProportionally };
