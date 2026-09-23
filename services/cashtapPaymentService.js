const cashtap = require('./cashtapService');
const { fulfillPurchase } = require('./purchaseFulfillmentService');

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

async function startCheckout({ user, plan }) {
  const session = await cashtap.createSession({
    amount: plan.priceUsd,
    lineItems: [{
      name: plan.name,
      description: plan.credits.toLocaleString('en-US') + ' credits' + (plan.maxEbayAccounts ? ' + ' + plan.maxEbayAccounts + ' eBay account' + (plan.maxEbayAccounts === 1 ? '' : 's') : ''),
      quantity: 1,
      unit_amount: plan.priceUsd,
    }],
    customerEmail: user.email || undefined,
    successUrl: frontendUrl() + '/?payment=cashtap',
    cancelUrl: frontendUrl() + '/?payment=cancelled',
    metadata: { elms_user_id: String(user.id), elms_plan_id: String(plan.id) },
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

  // The amount is set by our server from the plan; a session whose amount differs was not created by us.
  if (Math.abs(Number(session.amount) - Number(plan.priceUsd)) > 0.01) {
    await alertAdmin('CashTap payment with an unexpected amount', ['Session: ' + session.id, 'Plan: ' + plan.name + ' ($' + plan.priceUsd + ')', 'Session amount: $' + session.amount, 'Nobody was credited. Please check it by hand.']);
    return { status: 'completed', granted: false, reason: 'amount_mismatch' };
  }
  const received = session.amount_received == null ? Number(session.amount) : Number(session.amount_received);
  if (received < Number(session.amount) * (1 - UNDERPAY_TOLERANCE)) {
    await alertAdmin('CashTap payment came in short', ['Session: ' + session.id, 'User id: ' + userId, 'Plan: ' + plan.name + ' ($' + plan.priceUsd + ')', 'Received: $' + received + ' of $' + session.amount, 'More than ' + UNDERPAY_TOLERANCE * 100 + '% short, so the plan was NOT given. Decide with the customer / CashTap support and add the credits by hand if it is fine.']);
    return { status: 'completed', granted: false, reason: 'underpaid' };
  }

  const done = await fulfillPurchase({ userId, plan, provider: 'cashtap', transactionId: session.id, priceUsd: Number(session.amount) });
  return { status: 'completed', ...done };
}

/** Return-page check: fetch the session from CashTap, and give the plan if it is paid (idempotent). */
async function confirmSession(sessionId, userId) {
  const session = await cashtap.getSession(sessionId);
  return grantForSession(session, { expectUserId: userId });
}

module.exports = { activeProvider, startCheckout, grantForSession, confirmSession, UNDERPAY_TOLERANCE };
