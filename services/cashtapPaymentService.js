const cashtap = require('./cashtapService');
const { fulfillPurchase } = require('./purchaseFulfillmentService');
const referrals = require('./referralService');
const vouchers = require('./voucherService');

/**
 * Buying a plan with CashTap.
 *   startCheckout   -> a hosted checkout session for the plan (the price comes from the plan, never from the browser)
 *   grantForSession -> gives the plan to the buyer once CashTap says the session is paid (called by the webhook and
 *                      by the return-page check; whichever comes first wins, the other finds it already done)
 */

// Bridge / on-ramp fees can make the buyer's payment arrive slightly short; CashTap says this is normally within 5%.
const UNDERPAY_TOLERANCE = 0.05;

/** Which provider the Pricing page uses. PAYMENT_PROVIDER=paddle keeps the old Paddle checkout; CashTap is the default once it has a key. */
function activeProvider() {
  const chosen = String(process.env.PAYMENT_PROVIDER || '').trim().toLowerCase();
  if (chosen === 'paddle' || chosen === 'cashtap') return chosen;
  return cashtap.isConfigured() ? 'cashtap' : 'paddle';
}

const frontendUrl = () => String(process.env.FRONTEND_URL || 'https://elmstool.com').replace(/\/+$/, '');

/** Only ever send the buyer to CashTap's own hosted page. */
function assertCashtapUrl(url) {
  let host = '';
  try { host = new URL(url).hostname; } catch (_) { /* invalid */ }
  if (!/(^|\.)cashtap\.cash$/i.test(host)) throw Object.assign(new Error('CashTap returned an unexpected checkout address.'), { statusCode: 502 });
}

/**
 * @param {{ user: object, plan: object, discount?: { referralId: string, percent: number } | null, voucher?: object | null }} p
 * discount: a referral discount the server already decided (services/referralService.js discountFor). The amount asked of the
 * buyer is the plan's price minus that percent; the percent travels in the session's metadata so the payment can be checked.
 * voucher: a voucher of this user that the server already checked (services/voucherService.js usableForPurchase); it is used
 * INSTEAD of the referral discount, and its id travels in the metadata.
 */
async function startCheckout({ user, plan, discount = null, voucher = null }) {
  if (voucher) discount = null;
  const percent = discount ? referrals.clampPercent(discount.percent) : 0;
  const amount = voucher ? vouchers.priceWith(plan.priceUsd, voucher) : percent > 0 ? referrals.priceAfterDiscount(plan.priceUsd, percent) : plan.priceUsd;
  const session = await cashtap.createSession({
    amount,
    lineItems: [{
      name: plan.name + (voucher ? ' (voucher)' : percent > 0 ? ' (' + percent + '% referral discount)' : ''),
      description: plan.credits.toLocaleString('en-US') + ' credits' + (plan.maxEbayAccounts ? ' + ' + plan.maxEbayAccounts + ' eBay account' + (plan.maxEbayAccounts === 1 ? '' : 's') : ''),
      quantity: 1,
      unit_amount: amount,
    }],
    customerEmail: user.email || undefined,
    successUrl: frontendUrl() + '/?payment=cashtap',
    cancelUrl: frontendUrl() + '/?payment=cancelled',
    metadata: {
      elms_user_id: String(user.id),
      elms_plan_id: String(plan.id),
      ...(percent > 0 ? { elms_discount_percent: String(percent), elms_referral_id: String(discount.referralId) } : {}),
      ...(voucher ? { elms_voucher_id: String(voucher.id) } : {}),
    },
  });
  assertCashtapUrl(session.url);
  return { sessionId: session.id, url: session.url };
}

async function alertAdmin(subject, lines) {
  try { await require('./emailService').sendAdminAlert({ subject, lines }); } catch (err) { console.warn('cashtap: admin alert failed:', err.message); }
}

/**
 * @param {object} session the session as returned by CashTap's API (never trust a webhook body for this)
 * @param {{ expectUserId?: string }} [opts] the return-page check passes the signed-in user, who must be the buyer
 * @returns {Promise<{ status: string, granted: boolean, duplicate?: boolean, reason?: string, credits?: number, ebayAccounts?: number|null, planName?: string }>}
 */
async function grantForSession(session, { expectUserId } = {}) {
  const { getPlanById } = require('../models/plansModel');
  if (!session || session.status !== 'completed') return { status: session ? session.status : 'unknown', granted: false };

  const meta = session.metadata || {};
  const userId = meta.elms_user_id;
  const planId = meta.elms_plan_id;
  if (!userId || !planId) {
    await alertAdmin('CashTap payment without an ELMS user', ['Session: ' + session.id, 'Amount: $' + session.amount, 'The payment has no elms_user_id / elms_plan_id, so nobody was credited. Please check it by hand.']);
    return { status: 'completed', granted: false, reason: 'no_user' };
  }
  if (expectUserId && String(expectUserId) !== String(userId)) return { status: 'completed', granted: false, reason: 'not_yours' };

  const plan = await getPlanById(planId);
  if (!plan) {
    await alertAdmin('CashTap payment for a deleted plan', ['Session: ' + session.id, 'User id: ' + userId, 'Plan id: ' + planId, 'Amount: $' + session.amount, 'The plan no longer exists, so nobody was credited.']);
    return { status: 'completed', granted: false, reason: 'no_plan' };
  }

  // The amount is set by our server from the plan (less the referral discount it decided when the session was made); a session
  // whose amount differs was not created by us.
  const discountPercent = referrals.clampPercent(meta.elms_discount_percent);
  const referralId = discountPercent > 0 && /^[a-f0-9]{24}$/i.test(String(meta.elms_referral_id || '')) ? String(meta.elms_referral_id) : null;
  // A voucher: it must be this buyer's, a purchase discount, and valid for this plan; the price it gives is what was asked.
  let voucher = null;
  if (/^[a-f0-9]{24}$/i.test(String(meta.elms_voucher_id || ''))) {
    const found = await require('../models/vouchersModel').getById(String(meta.elms_voucher_id));
    if (found && found.userId === String(userId) && vouchers.appliesToPlan(found, plan)) voucher = found;
  }
  const expected = voucher ? vouchers.priceWith(plan.priceUsd, voucher) : referralId ? referrals.priceAfterDiscount(plan.priceUsd, discountPercent) : Number(plan.priceUsd);
  if (Math.abs(Number(session.amount) - expected) > 0.01) {
    await alertAdmin('CashTap payment with an unexpected amount', ['Session: ' + session.id, 'Plan: ' + plan.name + ' ($' + plan.priceUsd + ')' + (referralId ? ' with ' + discountPercent + '% referral discount = $' + expected : '') + (voucher ? ' with voucher ' + voucher.id + ' = $' + expected : ''), 'Session amount: $' + session.amount, 'Nobody was credited. Please check it by hand.']);
    return { status: 'completed', granted: false, reason: 'amount_mismatch' };
  }
  const received = session.amount_received == null ? Number(session.amount) : Number(session.amount_received);
  if (received < Number(session.amount) * (1 - UNDERPAY_TOLERANCE)) {
    await alertAdmin('CashTap payment came in short', ['Session: ' + session.id, 'User id: ' + userId, 'Plan: ' + plan.name + ' ($' + plan.priceUsd + ')', 'Received: $' + received + ' of $' + session.amount, 'More than ' + UNDERPAY_TOLERANCE * 100 + '% short, so the plan was NOT given. Decide with the customer / CashTap support and add the credits by hand if it is fine.']);
    return { status: 'completed', granted: false, reason: 'underpaid' };
  }

  const done = await fulfillPurchase({
    userId, plan, provider: 'cashtap', transactionId: session.id, priceUsd: Number(session.amount),
    listPriceUsd: Number(plan.priceUsd),
    discountPercent: voucher ? Math.round((1 - Number(session.amount) / Number(plan.priceUsd)) * 10000) / 100 : referralId ? discountPercent : 0,
    referralId: voucher ? null : referralId,
    voucherId: voucher ? voucher.id : null,
  });
  return { status: 'completed', ...done };
}

/** Return-page check: fetch the session from CashTap, and give the plan if it is paid (idempotent). */
async function confirmSession(sessionId, userId) {
  const session = await cashtap.getSession(sessionId);
  return grantForSession(session, { expectUserId: userId });
}

module.exports = { activeProvider, startCheckout, grantForSession, confirmSession, UNDERPAY_TOLERANCE };
