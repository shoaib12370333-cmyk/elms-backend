const axios = require('axios');
const { getAccessToken } = require('./ebayAuthService');
const { EBAY_FINANCES_BASE_URL: EBAY_BASE_URL } = require('../config/ebayEnvironment');

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
 */

/** Unlike Fulfillment API calls (services/ebayOrdersService.js), Finances requires X-EBAY-C-MARKETPLACE-ID on every call. */
async function ebayFinancesGet(refreshToken, path, marketplaceId) {
  const accessToken = await getAccessToken(refreshToken);
  try {
    const response = await axios.get(`${EBAY_BASE_URL}${path}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-EBAY-C-MARKETPLACE-ID': marketplaceId || 'EBAY_US',
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

module.exports = { fetchSaleTransactionsForOrder, netEarningFromTransactions };
