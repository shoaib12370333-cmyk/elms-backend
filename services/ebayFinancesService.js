const axios = require('axios');
const { getAccessToken } = require('./ebayAuthService');
const { EBAY_FINANCES_BASE_URL: EBAY_BASE_URL } = require('../config/ebayEnvironment');
const { signedHeaders } = require('./ebayDigitalSignatureService');

/**
 * eBay's Sell Finances API (developer.ebay.com/develop/api/sell/finances_api) - what a sold order actually earns after
 * eBay's own fees, used to auto-fill Order.orderEarning instead of the seller typing it (routes/netProfit.js).
 *
 * Needs the sell.finances OAuth scope, added alongside the other scopes this app already requests (services/
 * ebayUserAuthService.js, services/ebayAuthService.js) - a seller connected before that scope existed must reconnect
 * ("Connect eBay" again) before a call here will succeed; see PRODUCTION-SETUP.md.
 *
 * Served from apiz (EBAY_FINANCES_BASE_URL), NOT api.ebay.com - confirmed 2026-09-29 against a real, correctly-scoped
 * seller account: every call against api.ebay.com came back a plain 404 regardless of the order, while apiz.ebay.com
 * is eBay's own documented host for this API (same apiz host the Commerce Identity API uses, config/ebayEnvironment.js).
 *
 * getOrderEarnings (the endpoint that would hand back a ready-made "net earning" figure directly) is NOT used here: per
 * the docs, it needs a separate eBay-approved "application growth check" and is limited to US/China/Hong Kong sellers
 * with a USD payout - not generally available. getTransactions (this file) needs no special access.
 *
 * ALSO needs a digital signature (services/ebayDigitalSignatureService.js) on every call, when made on behalf of an
 * EU/UK-domiciled seller - "All methods in the Finances API" are in scope (confirmed 2026-10-02: a real UK seller's
 * calls failed with eBay's error 215001 "Missing x-ebay-signature-key header" until this was added). eBay ignores the
 * signature for a seller it is not required for, so it is added to every call here, not just ones we can tell are
 * EU/UK - see that file for the one-time key setup this needs (scripts/createEbaySigningKey.js).
 */

/** Unlike Fulfillment API calls (services/ebayOrdersService.js), Finances requires X-EBAY-C-MARKETPLACE-ID on every call. */
async function ebayFinancesGet(refreshToken, path, marketplaceId) {
  const accessToken = await getAccessToken(refreshToken);
  const host = new URL(EBAY_BASE_URL).host;
  const barePath = path.split('?')[0]; // the signature covers @path only, never the query string
  try {
    const response = await axios.get(`${EBAY_BASE_URL}${path}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-EBAY-C-MARKETPLACE-ID': marketplaceId || 'EBAY_US',
        ...(await signedHeaders({ method: 'GET', path: barePath, host })),
      },
      timeout: 20000,
      validateStatus: (s) => s === 200 || s === 204,
    });
    return response.status === 204 ? null : response.data;
  } catch (err) {
    const ebayErrors = err.response?.data?.errors;
    const message = ebayErrors && ebayErrors.length ? ebayErrors.map((e) => e.message).join('; ') : err.message || 'The eBay Finances API request failed.';
    const wrapped = new Error(message);
    wrapped.statusCode = err.response?.status || 500;
    throw wrapped;
  }
}

/**
 * Every SALE-type monetary transaction eBay has recorded for one order (usually exactly one, but the filter can in
 * principle return more than one page - unlikely for a single order, so this reads only the first page of up to 50).
 * Returns [] when eBay has nothing yet (the sale hasn't settled, or the order id is wrong) - never throws for that.
 */
async function fetchSaleTransactionsForOrder(refreshToken, ebayOrderId, marketplaceId) {
  // Two SEPARATE filter= query params, per the docs' own combined-filter example
  // (filter=transactionId:{...}&filter=transactionType:{SALE}) - not one filter string with a comma.
  const qs = `filter=${encodeURIComponent(`orderId:{${ebayOrderId}}`)}&filter=${encodeURIComponent('transactionType:{SALE}')}&limit=50`;
  const data = await ebayFinancesGet(refreshToken, `/sell/finances/v1/transaction?${qs}`, marketplaceId);
  return data && Array.isArray(data.transactions) ? data.transactions : [];
}

const money = (v) => {
  const n = parseFloat(v?.value);
  return Number.isFinite(n) ? n : null;
};

/**
 * The net amount eBay actually paid out for one order's SALE transaction(s) - Transaction.amount is documented as "the
 * dollar value ... of the monetary transaction", already net of eBay's fees for a SALE. Sums more than one SALE
 * transaction for the same order on the rare chance eBay ever splits one (not expected in practice).
 * Returns null when there is nothing to compute from yet (order not settled/paid out on eBay's side).
 */
function netEarningFromTransactions(transactions) {
  const sales = (transactions || []).filter((t) => t.transactionType === 'SALE' && money(t.amount) !== null);
  if (!sales.length) return null;
  const total = sales.reduce((sum, t) => sum + money(t.amount), 0);
  const currency = sales[0].amount.currency || null;
  return { amount: Number(total.toFixed(2)), currency };
}

const toCents = (v) => Math.round(v * 100 + (v < 0 ? -1e-7 : 1e-7));

/**
 * The Promoted Listings ad fee eBay took off one order: every `feeType: AD_FEE` entry in the SALE transaction(s)' own
 * `orderLineItems[].marketplaceFees[]` (the same transaction netEarningFromTransactions already reads - no extra eBay
 * call). eBay's docs: AD_FEE is "a fee charged or a credit issued for an Ad on eBay ... only for sellers who sign up to
 * create Promoted Listings campaigns" - a negative entry is a credit and is summed in as it is. It is already inside
 * the SALE `amount` (eBay deducts fees before payout), so this is for showing the fee, never for taking it off again.
 *
 * Returns null when there is nothing to read: no SALE transaction yet (same as netEarningFromTransactions), or no line
 * item in them lists ANY fee (`orderLineItems` missing/empty, or no `marketplaceFees` anywhere - a real sale always
 * carries at least its final value fee) - then "no ad fee" cannot be told from "eBay did not say", and a made-up 0.00
 * would be wrong. Otherwise
 *   { total, currency, byLineItem }  - byLineItem maps each eBay lineItemId in the answer to ITS ad fee (0 when that
 * line had none), so a multi-line order is exact per line rather than split by price. Money in whole cents internally.
 * Only SALE transactions: a Promoted Listings Advanced / per-click charge is billed at account level (not per order)
 * and never appears here.
 */
function adFeesFromTransactions(transactions) {
  const sales = (transactions || []).filter((t) => t && t.transactionType === 'SALE' && Array.isArray(t.orderLineItems));
  const listsAnyFee = sales.some((t) => t.orderLineItems.some((item) => item && Array.isArray(item.marketplaceFees) && item.marketplaceFees.length > 0));
  if (!listsAnyFee) return null;
  const perLine = new Map();
  let totalCents = 0;
  let currency = null;
  for (const sale of sales) {
    for (const item of sale.orderLineItems) {
      const id = item && item.lineItemId ? String(item.lineItemId) : null;
      if (id && !perLine.has(id)) perLine.set(id, 0);
      for (const fee of Array.isArray(item && item.marketplaceFees) ? item.marketplaceFees : []) {
        if (!fee || fee.feeType !== 'AD_FEE') continue;
        const v = money(fee.amount);
        if (v === null) continue;
        const c = toCents(v);
        totalCents += c;
        if (id) perLine.set(id, perLine.get(id) + c);
        currency = currency || (fee.amount && fee.amount.currency) || null;
      }
    }
  }
  const byLineItem = {};
  for (const [id, c] of perLine) byLineItem[id] = c / 100;
  return { total: totalCents / 100, currency: currency || (sales[0].amount && sales[0].amount.currency) || null, byLineItem };
}

module.exports = { fetchSaleTransactionsForOrder, netEarningFromTransactions, adFeesFromTransactions };
