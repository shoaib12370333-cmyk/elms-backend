const cron = require('node-cron');
const EbayAccount = require('../models/schemas/EbayAccount');
const { getEbayAccountRefreshToken } = require('../models/ebayAccountsModel');
const { listOrdersNeedingEarnings, setOrderEarningsBulk, listOrdersNeedingAdFee, setOrderAdFeesBulk, markAdFeeChecked } = require('../models/ordersModel');
const { fetchSaleTransactionsForOrder, netEarningFromTransactions, adFeesFromTransactions } = require('../services/ebayFinancesService');
const { acquireLock } = require('../services/jobLockService');
const { isUnrecoverableEbayAuthError } = require('../services/ebayAuthErrorService');

// Tried from the moment an order is PAID - no fixed wait. eBay does not always have a settled Finances
// transaction for a brand-new sale yet; when it doesn't, netEarningFromTransactions returns null and the order is
// simply left for the next run (see syncOneAccount below), so trying early costs nothing and picks it up the moment
// eBay does have it.
const MIN_AGE_MS = 0;

// How many order lines that ALREADY have an earning (everything synced before the Ad fee column existed) get their ad
// fee read per account per run - one Finances call per distinct order, so the old backlog is worked through a little at
// a time instead of in one burst. New orders are not limited by this: their ad fee comes with their earning, same call.
const AD_FEE_BACKFILL_PER_RUN = 10;
// ...and only orders paid at least this long ago: eBay has certainly settled those, so "no transaction" / "no fee list"
// really means there is nothing to read, and stamping the line as checked cannot lock out a sale that was merely too new
// (a seller's own typed earning can exist before eBay has the transaction).
const AD_FEE_BACKFILL_MIN_AGE_MS = 3 * 24 * 60 * 60 * 1000;

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

/**
 * The ad fee for each of an order's ELMS lines. eBay reports it per line item (adFeesFromTransactions().byLineItem), so
 * when every line is found in that answer each gets exactly ITS OWN fee. If a line cannot be matched (should not happen -
 * ELMS stores eBay's own lineItemId - but very old rows may lack it) the only safe case is an order eBay says has ONE
 * line, with one ELMS line: that line's fee is the answer. With more lines than that there is no telling which fee
 * belongs to which line, and splitting by price would double-count when the lines are handled in different runs - so
 * nothing is returned (the lines stay empty, never a guess).
 */
function adFeeShares(adFees, lines) {
  const ids = Object.keys(adFees.byLineItem);
  const matched = lines.every((l) => l.ebayLineItemId && Object.prototype.hasOwnProperty.call(adFees.byLineItem, String(l.ebayLineItemId)));
  if (matched) return lines.map((l) => ({ id: String(l._id), adFee: adFees.byLineItem[String(l.ebayLineItemId)] }));
  if (ids.length === 1 && lines.length === 1) return [{ id: String(lines[0]._id), adFee: adFees.byLineItem[ids[0]] }];
  return [];
}

function groupByOrder(lines) {
  const byOrder = new Map();
  for (const line of lines) {
    if (!byOrder.has(line.ebayOrderId)) byOrder.set(line.ebayOrderId, []);
    byOrder.get(line.ebayOrderId).push(line);
  }
  return byOrder;
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
  const backfill = await listOrdersNeedingAdFee(account.userId, account._id, AD_FEE_BACKFILL_PER_RUN, AD_FEE_BACKFILL_MIN_AGE_MS);
  if (!pending.length && !backfill.length) return { updated: 0 };

  // One Finances call per distinct eBay order covers both jobs below: lines still without an earning (new orders) and
  // lines that have one but never had their ad fee read (the backlog from before the Ad fee column).
  const earningByOrder = groupByOrder(pending);
  const backfillByOrder = groupByOrder(backfill);
  const orderIds = [...new Set([...earningByOrder.keys(), ...backfillByOrder.keys()])];

  const updates = [];
  const adFeeUpdates = [];
  const nothingOnEbay = []; // backfill lines there is nothing to read for - stamped so they are not asked about again
  const failedBackfill = []; // backfill-only orders whose Finances call threw (and not for an account-wide auth reason)
  let okCount = 0; // Finances calls that came back at all, even with nothing in them yet
  let earningErrorCount = 0; // errors on orders still waiting for their EARNING: the only ones that say the account's earnings are stuck
  let lastEarningError = null;
  for (const ebayOrderId of orderIds) {
    const lines = earningByOrder.get(ebayOrderId) || [];
    const backfillLines = backfillByOrder.get(ebayOrderId) || [];
    const backfillIds = backfillLines.map((l) => String(l._id));
    try {
      const transactions = await fetchSaleTransactionsForOrder(refreshToken, ebayOrderId, account.marketplaceId);
      okCount += 1;
      const earning = netEarningFromTransactions(transactions);
      if (!earning) {
        // Not settled on eBay's side yet - try again next run. Unless this order already HAD an earning and was paid
        // days ago (listOrdersNeedingAdFee): eBay has settled it long since and still has no transaction, so there is
        // nothing to read, ever - stop asking.
        if (!lines.length) nothingOnEbay.push(...backfillIds);
        continue;
      }
      if (lines.length) updates.push(...splitProportionally(earning.amount, lines));
      const adFees = adFeesFromTransactions(transactions);
      const shares = adFees ? adFeeShares(adFees, [...lines, ...backfillLines]) : [];
      adFeeUpdates.push(...shares);
      // A backfill line that got no figure (no fee list in the answer, or no telling which fee is whose) is final: stamp
      // it. A line that is still waiting for its EARNING is not - it just got one, and the backfill looks at it again
      // after AD_FEE_BACKFILL_MIN_AGE_MS, by which time eBay has finished with it.
      const got = new Set(shares.map((x) => x.id));
      nothingOnEbay.push(...backfillIds.filter((id) => !got.has(id)));
    } catch (err) {
      const authProblem = looksLikeMissingScope(err);
      if (lines.length) { earningErrorCount += 1; lastEarningError = err.message; }
      else if (!authProblem) failedBackfill.push({ ids: backfillIds, status: Number(err.statusCode) });
      if (authProblem) {
        console.warn(`[order-earnings] ${account.ebayUserId}: ${err.message} - likely needs to reconnect eBay for the new Finances permission. Skipping this account for now.`);
        break;
      }
      console.warn(`[order-earnings] ${account.ebayUserId} order ${ebayOrderId}: ${err.message}`);
    }
  }
  // A backfill order eBay keeps refusing for ITS OWN reason (a 4xx other than "slow down": the transaction filter or the
  // order id is rejected) would otherwise stay among the newest few lines and be asked about every 5 minutes forever,
  // starving the older backlog behind it. Only when other orders of this account DID come back fine this run (so it is
  // this order, not the account) - an account-wide problem must not stamp anything, it is fixed by reconnecting. A 5xx,
  // a timeout or a 429 is transient and stays pending.
  if (okCount > 0) {
    for (const f of failedBackfill) if (f.status >= 400 && f.status < 500 && f.status !== 429) nothingOnEbay.push(...f.ids);
  }
  // Surfaced in Settings (ebayAccountsModel.js serialize) so a permanently-stuck account is visible, not just logged.
  // Not just the missing-scope case (above): ANY error that stops every single order this run from getting an
  // earning - a wrong/stale marketplaceId on the account, a malformed request, whatever eBay actually says - would
  // otherwise retry silently forever with nothing to see but a server log line. A run where at least one order came
  // back fine (even if another failed) is left alone: that is normal, partial, and not worth a scary warning.
  // Only orders waiting for their EARNING count here: an old order failing its ad-fee backfill says nothing about
  // whether this account's earnings work, so it neither raises the warning nor keeps a stale one from clearing.
  const allFailed = earningErrorCount > 0 && !updates.length;
  if (allFailed) {
    if (account.financesSyncError !== lastEarningError) await EbayAccount.updateOne({ _id: account._id }, { $set: { financesSyncError: lastEarningError } }).catch(() => {});
  } else if (earningErrorCount === 0 && okCount > 0 && account.financesSyncError) {
    await EbayAccount.updateOne({ _id: account._id }, { $set: { financesSyncError: null } }).catch(() => {});
  }
  // The ad fee is saved on its own: a problem saving it must never stop the earnings from being saved (that column
  // existed first and is the one the net profit is worked out from), and vice versa.
  if (adFeeUpdates.length) await setOrderAdFeesBulk(adFeeUpdates).catch((err) => console.warn(`[order-earnings] ${account.ebayUserId}: could not save ad fees: ${err.message}`));
  if (nothingOnEbay.length) await markAdFeeChecked(nothingOnEbay).catch(() => {});
  const updated = updates.length ? await setOrderEarningsBulk(updates) : 0;
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
 * still missing their earning (listOrdersNeedingEarnings), plus a few old ones per run that never had their ad fee read
 * (listOrdersNeedingAdFee, AD_FEE_BACKFILL_PER_RUN) - so an account with nothing pending and no such backlog costs nothing. */
function startOrderEarningsSync() {
  cron.schedule('*/5 * * * *', async () => {
    const gotLock = await acquireLock('order-earnings-sync', 4 * 60 * 1000).catch(() => false);
    if (!gotLock) return;
    runOrderEarningsSync().catch((err) => console.error('[order-earnings] Unexpected error:', err.message));
  });
  console.log('[order-earnings] Order earnings sync scheduled (every 5 minutes).');
}

module.exports = { startOrderEarningsSync, runOrderEarningsSync, splitProportionally, adFeeShares, AD_FEE_BACKFILL_PER_RUN, AD_FEE_BACKFILL_MIN_AGE_MS };
