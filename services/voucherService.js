const model = require('../models/vouchersModel');
const referrals = require('./referralService');

/**
 * Vouchers: something an admin gives to one user (Admin -> Vouchers).
 *
 *   purchase_discount  used on Buy credits: a percent or an amount off a plan (any plan, or one plan). The server works the price
 *                      out when the checkout starts and checks the payment against it when it arrives - the voucher is marked
 *                      used by that payment.
 *   credits            "Redeem" adds the credits.
 *   free_plan          "Redeem" gives the plan: its credits, its eBay-account limit and its name, with no payment.
 *   ebay_accounts      "Redeem" raises the number of eBay accounts the user may connect.
 *
 * A voucher works once. Only its owner can use it; only an admin creates or revokes one.
 */

const KINDS = ['purchase_discount', 'credits', 'free_plan', 'ebay_accounts'];
const MIN_CHARGE_CENTS = 50; // CashTap's smallest checkout is $0.50
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const fail = (status, message) => Object.assign(new Error(message), { statusCode: status, userFacing: true }); // the message is safe to show

/** active / used / revoked, or expired for an active one past its date. */
function stateOf(v, now = Date.now()) {
  if (v.status !== 'active') return v.status;
  return v.expiresAt && new Date(v.expiresAt).getTime() <= now ? 'expired' : 'active';
}
const isUsable = (v, now) => stateOf(v, now) === 'active';

/** What the voucher is worth, in words. `planName` is the plan it is tied to, when it has one. */
function describe(v, planName) {
  switch (v.kind) {
    case 'purchase_discount': {
      const off = v.percent != null ? `${Number(v.percent)}% off` : `$${Number(v.amountUsd).toFixed(2)} off`;
      return `${off} ${v.planId ? (planName ? `the ${planName} plan` : 'one credit plan') : 'any credit plan'}`;
    }
    case 'credits': return `${Number(v.credits).toLocaleString('en-US')} free credits`;
    case 'free_plan': return `The ${planName || 'chosen'} plan, free`;
    case 'ebay_accounts': return `${v.ebayAccounts} more eBay account${v.ebayAccounts === 1 ? '' : 's'}`;
    default: return 'Voucher';
  }
}

/** The price after the voucher, never below $0.50 and never above the list price. */
function priceWith(priceUsd, v) {
  const cents = Math.round(Number(priceUsd) * 100);
  if (!(cents > 0)) return round2(priceUsd);
  if (v.percent != null) return referrals.priceAfterDiscount(priceUsd, v.percent);
  const off = Math.round(Number(v.amountUsd) * 100);
  return Math.min(cents, Math.max(MIN_CHARGE_CENTS, cents - off)) / 100;
}

const appliesToPlan = (v, plan) => v.kind === 'purchase_discount' && (!v.planId || String(v.planId) === String(plan.id));

/** Checks what an admin typed and returns the fields to store. Throws a 400 with a plain message. */
async function normalizeInput(input, getPlanById) {
  const kind = String(input.kind || '');
  if (!KINDS.includes(kind)) throw fail(400, 'Choose what the voucher is for.');
  const out = { kind, percent: null, amountUsd: null, planId: null, credits: null, ebayAccounts: null };
  const num = (v) => (v === '' || v === null || v === undefined ? NaN : Number(v));

  if (kind === 'purchase_discount') {
    const hasPercent = input.percent !== undefined && input.percent !== null && input.percent !== '';
    const hasAmount = input.amountUsd !== undefined && input.amountUsd !== null && input.amountUsd !== '';
    if (hasPercent === hasAmount) throw fail(400, 'Give either a percent off or an amount off.');
    if (hasPercent) {
      const p = num(input.percent);
      if (!Number.isFinite(p) || p < 1 || p > referrals.MAX_DISCOUNT_PERCENT) throw fail(400, 'The percent off must be between 1 and ' + referrals.MAX_DISCOUNT_PERCENT + '.');
      out.percent = round2(p);
    } else {
      const a = num(input.amountUsd);
      if (!Number.isFinite(a) || a < 0.5 || a > 10000) throw fail(400, 'The amount off must be between $0.50 and $10,000.');
      out.amountUsd = round2(a);
    }
  } else if (kind === 'credits') {
    const c = num(input.credits);
    if (!Number.isFinite(c) || c < 1 || c > 1000000) throw fail(400, 'The credits must be a number from 1 to 1,000,000.');
    out.credits = Math.floor(c);
  } else if (kind === 'ebay_accounts') {
    const n = num(input.ebayAccounts);
    if (!Number.isFinite(n) || n < 1 || n > 50) throw fail(400, 'The number of eBay accounts must be from 1 to 50.');
    out.ebayAccounts = Math.floor(n);
  }

  if (kind === 'free_plan' || (kind === 'purchase_discount' && input.planId)) {
    if (!input.planId) throw fail(400, 'Choose the plan.');
    const plan = await getPlanById(String(input.planId));
    if (!plan) throw fail(400, 'That plan does not exist.');
    out.planId = plan.id;
  }

  const days = input.expiresInDays === undefined || input.expiresInDays === null || input.expiresInDays === '' ? null : Number(input.expiresInDays);
  if (days !== null && (!Number.isFinite(days) || days < 1 || days > 3650)) throw fail(400, 'Days until it expires must be from 1 to 3650 (or empty for no expiry).');
  out.expiresAt = days === null ? null : new Date(Date.now() + Math.floor(days) * 86400000);
  out.note = String(input.note || '').trim().slice(0, 140);
  return out;
}

/** An admin gives a voucher to a user. The user is told by email (best effort). */
async function giveVoucher({ adminId, user, input }) {
  const { getPlanById } = require('../models/plansModel');
  const fields = await normalizeInput(input, getPlanById);
  const planName = fields.planId ? ((await getPlanById(fields.planId)) || {}).name : null;
  const voucher = await model.create({ ...fields, userId: user.id, createdBy: adminId || null });
  try {
    if (user.email) {
      require('./emailService').sendVoucherEmail({
        to: user.email,
        what: describe(voucher, planName),
        note: voucher.note,
        expiresAt: voucher.expiresAt,
        redeem: voucher.kind !== 'purchase_discount',
      }).catch((err) => console.warn('voucher email failed:', err.message));
    }
  } catch (err) {
    console.warn('voucher email failed:', err.message);
  }
  return voucher;
}

/** The user's vouchers with a state, a description and the plan name, newest first. */
async function listMine(userId) {
  const { getPlanById } = require('../models/plansModel');
  const rows = await model.listForUser(userId);
  const names = new Map();
  for (const id of new Set(rows.map((r) => r.planId).filter(Boolean))) names.set(id, ((await getPlanById(id)) || {}).name || null);
  const now = Date.now();
  return rows.map((v) => ({
    id: v.id, kind: v.kind, description: describe(v, names.get(v.planId)), note: v.note, state: stateOf(v, now),
    planId: v.planId, planName: names.get(v.planId) || null, expiresAt: v.expiresAt, usedAt: v.usedAt, createdAt: v.createdAt,
    redeemable: v.kind !== 'purchase_discount',
  }));
}

/** A voucher the user may use to pay for `plan` now, or a 400/404 with the reason. */
async function usableForPurchase(userId, voucherId, plan) {
  const v = await model.getById(voucherId);
  if (!v || v.userId !== String(userId)) throw fail(404, 'That voucher was not found.');
  if (v.kind !== 'purchase_discount') throw fail(400, 'That voucher is redeemed on the Vouchers page, not at checkout.');
  const state = stateOf(v);
  if (state !== 'active') throw fail(400, state === 'used' ? 'That voucher was already used.' : state === 'expired' ? 'That voucher has expired.' : 'That voucher is no longer valid.');
  if (plan && !appliesToPlan(v, plan)) throw fail(400, 'That voucher is not valid for the ' + plan.name + ' plan.');
  return v;
}

/** Marks the voucher used by a payment. Returns true when this call used it (false: it was already used / revoked). Never throws. */
async function markUsedForPurchase(voucherId, userId, paymentId) {
  try {
    return !!(await model.claim(voucherId, userId, paymentId));
  } catch (err) {
    console.error('[voucher] could not mark ' + voucherId + ' used: ' + err.message);
    return false;
  }
}

/** The user redeems a credits / free_plan / ebay_accounts voucher. Returns { message, credits?, planName?, ebayAccounts? }. */
async function redeem(userId, voucherId) {
  const { getPlanById } = require('../models/plansModel');
  const v = await model.getById(voucherId);
  if (!v || v.userId !== String(userId)) throw fail(404, 'That voucher was not found.');
  if (v.kind === 'purchase_discount') throw fail(400, 'This voucher takes money off a plan: pick it on the Buy credits page.');
  const state = stateOf(v);
  if (state !== 'active') throw fail(400, state === 'used' ? 'That voucher was already used.' : state === 'expired' ? 'That voucher has expired.' : 'That voucher is no longer valid.');

  let plan = null;
  if (v.kind === 'free_plan') {
    plan = await getPlanById(v.planId);
    if (!plan) throw fail(409, 'The plan of this voucher no longer exists. Please contact support.');
  }
  const claimed = await model.claim(v.id, userId, 'redeemed');
  if (!claimed) throw fail(409, 'That voucher was already used.');

  try {
    const users = require('../models/usersModel');
    if (v.kind === 'credits') {
      await users.addCredits(userId, v.credits);
      return { message: `${v.credits.toLocaleString('en-US')} credits were added to your balance.`, credits: v.credits };
    }
    if (v.kind === 'ebay_accounts') {
      await users.addEbayAccountSlots(userId, v.ebayAccounts);
      return { message: `You can now connect ${v.ebayAccounts} more eBay account${v.ebayAccounts === 1 ? '' : 's'}.`, ebayAccounts: v.ebayAccounts };
    }
    const { fulfillPurchase } = require('./purchaseFulfillmentService');
    const done = await fulfillPurchase({ userId, plan, provider: 'voucher', transactionId: 'voucher_' + v.id, priceUsd: 0, silent: true });
    if (!done.granted) throw new Error('The plan could not be given.');
    return { message: `The ${plan.name} plan is yours: ${plan.credits.toLocaleString('en-US')} credits were added.`, credits: plan.credits, planName: plan.name };
  } catch (err) {
    await model.release(v.id).catch((e) => console.error('[voucher] COULD NOT GIVE BACK ' + v.id + ': ' + e.message));
    throw err;
  }
}

module.exports = { KINDS, stateOf, isUsable, describe, priceWith, appliesToPlan, normalizeInput, giveVoucher, listMine, usableForPurchase, markUsedForPurchase, redeem };
