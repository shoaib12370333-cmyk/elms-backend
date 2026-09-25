const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/requireAuth');
const { listActivePlans, getPlanById } = require('../models/plansModel');
const { listPurchasesForUser, getPurchaseById } = require('../models/purchasesModel');
const invoices = require('../services/invoiceService');
const referrals = require('../services/referralService');
const vouchers = require('../services/voucherService');
const { getUserById } = require('../models/usersModel');
const { createTransaction } = require('../services/paddleService');
const cashtapPayments = require('../services/cashtapPaymentService');

/**
 * GET /api/payments/public-plans
 * No sign-in: the plans as the public website (elmstool.com) shows them. Only what a visitor needs to see - name, price,
 * credits and how many eBay accounts - taken live from the plans the admin manages. Cached for 5 minutes.
 */
router.get('/public-plans', async (req, res) => {
  try {
    const provider = cashtapPayments.activeProvider();
    const plans = (await listActivePlans())
      .filter((p) => provider === 'cashtap' || p.paddlePriceId)
      .map((p) => ({ name: p.name, priceUsd: p.priceUsd, credits: p.credits, maxEbayAccounts: p.maxEbayAccounts || null }));
    res.set('Cache-Control', 'public, max-age=300');
    res.json({ success: true, plans });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Could not load the plans.' });
  }
});

/**
 * GET /api/payments/plans
 * Requires a valid session token.
 * Returns the active plans for the Pricing page, and which checkout provider will be used (CashTap by default,
 * Paddle when PAYMENT_PROVIDER=paddle). With Paddle only plans that have a Paddle price id can be sold.
 */
router.get('/plans', requireAuth, async (req, res) => {
  const provider = cashtapPayments.activeProvider();
  const plans = (await listActivePlans()).filter((p) => provider === 'cashtap' || p.paddlePriceId);
  // A voucher the buyer picked on the page: the plans show the price with it (CashTap checkout only).
  if (req.query.voucherId && provider === 'cashtap') {
    try {
      const v = await vouchers.usableForPurchase(req.userId, String(req.query.voucherId), null);
      return res.json({
        success: true,
        provider,
        plans: plans.map((p) => (vouchers.appliesToPlan(v, p) ? { ...p, discountedPriceUsd: vouchers.priceWith(p.priceUsd, v) } : { ...p, voucherNotValid: true })),
        referralDiscount: null,
        voucher: { id: v.id, description: vouchers.describe(v, (plans.find((p) => p.id === v.planId) || {}).name), expiresAt: v.expiresAt },
      });
    } catch (err) {
      return res.status(err.userFacing ? err.statusCode : 500).json({ success: false, error: err.userFacing ? err.message : 'Could not use that voucher.' });
    }
  }
  // A friend who signed up with a referral code gets a discount on the plans (CashTap checkout; Paddle prices are fixed in Paddle).
  let discount = null;
  if (provider === 'cashtap') {
    try { discount = await referrals.discountFor(req.userId); } catch (err) { console.error('referral discount lookup failed:', err.message); }
  }
  res.json({
    success: true,
    provider,
    plans: plans.map((p) => (discount ? { ...p, discountedPriceUsd: referrals.priceAfterDiscount(p.priceUsd, discount.percent) } : p)),
    referralDiscount: discount ? { percent: discount.percent, usesLeft: discount.usesLeft, expiresAt: discount.expiresAt } : null,
  });
});

/**
 * GET /api/payments/history
 * Requires a valid session token.
 * Returns the current user's own purchase history.
 */
router.get('/history', requireAuth, async (req, res) => {
  const purchases = await listPurchasesForUser(req.userId);
  res.json({ success: true, purchases });
});

/**
 * GET /api/payments/invoice/:id
 * The invoice (PDF) for one of the signed-in user's own purchases. It is numbered the first time it is asked for.
 * ?format=json returns the same invoice as data.
 */
router.get('/invoice/:id', requireAuth, async (req, res) => {
  const purchase = await getPurchaseById(req.params.id);
  if (!purchase || purchase.userId !== String(req.userId)) return res.status(404).json({ success: false, error: 'Purchase not found.' });
  const invoice = await invoices.invoiceForPurchase(purchase);
  if (!invoice) return res.status(404).json({ success: false, error: 'This purchase has no invoice (it was a free plan from a voucher).' });
  if (req.query.format === 'json') return res.json({ success: true, invoice });
  const pdf = await invoices.invoicePdf(invoice);
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="' + invoice.number + '.pdf"', 'Access-Control-Expose-Headers': 'Content-Disposition', 'Cache-Control': 'private, no-store' });
  res.send(pdf);
});

/**
 * POST /api/payments/checkout
 * Requires a valid session token.
 * Body: { planId: string }
 *
 * CashTap: creates a hosted checkout session for the plan and returns { provider: 'cashtap', sessionId, url } - the
 * site sends the buyer to `url`. The plan is given when CashTap confirms the payment (webhook, or the return-page check).
 * Paddle: creates a transaction and returns its id for Paddle.js's checkout overlay.
 */
router.post('/checkout', requireAuth, async (req, res) => {
  const { planId } = req.body;

  if (!planId) {
    return res.status(400).json({ success: false, error: 'A planId is required.' });
  }

  const plan = await getPlanById(planId);
  if (!plan || !plan.active) {
    return res.status(404).json({ success: false, error: 'This plan is not available.' });
  }

  const user = await getUserById(req.userId);
  if (!user) {
    return res.status(404).json({ success: false, error: 'User not found.' });
  }

  const provider = cashtapPayments.activeProvider();
  try {
    if (provider === 'cashtap') {
      // A voucher the buyer chose is used instead of the referral discount.
      const voucher = req.body.voucherId ? await vouchers.usableForPurchase(req.userId, String(req.body.voucherId), plan) : null;
      const discount = voucher ? null : await referrals.discountFor(req.userId).catch((err) => { console.error('referral discount lookup failed:', err.message); return null; });
      const { sessionId, url } = await cashtapPayments.startCheckout({ user, plan, discount, voucher });
      return res.json({ success: true, provider, sessionId, url, discountPercent: discount ? discount.percent : 0, voucherApplied: !!voucher });
    }
    if (!plan.paddlePriceId) return res.status(404).json({ success: false, error: 'This plan is not available.' });
    const { transactionId } = await createTransaction({
      paddlePriceId: plan.paddlePriceId,
      userId: req.userId,
      userEmail: user.email,
    });

    res.json({ success: true, provider, transactionId });
  } catch (err) {
    if (err.userFacing) return res.status(err.statusCode).json({ success: false, error: err.message }); // a voucher that cannot be used
    console.error(provider + ' checkout creation error:', err.message, err.requestId || '');
    res.status(500).json({ success: false, error: 'Could not start checkout. Please try again.' });
  }
});

/**
 * POST /api/payments/cashtap/confirm
 * Body: { sessionId: string }
 *
 * The buyer is back from CashTap: ask CashTap whether the session is paid and give the plan if so (safe to call
 * again and again; the webhook may already have done it). Returns { status, granted, credits, ebayAccounts, planName }.
 */
router.post('/cashtap/confirm', requireAuth, async (req, res) => {
  const sessionId = String(req.body?.sessionId || '').trim();
  if (!/^cs_[A-Za-z0-9_]{6,80}$/.test(sessionId)) return res.status(400).json({ success: false, error: 'A valid sessionId is required.' });
  try {
    const result = await cashtapPayments.confirmSession(sessionId, req.userId);
    if (result.reason === 'not_yours') return res.status(404).json({ success: false, error: 'Payment not found.' });
    res.json({ success: true, ...result });
  } catch (err) {
    if (err.statusCode === 404) return res.status(404).json({ success: false, error: 'Payment not found.' });
    console.error('cashtap confirm error:', err.message, err.requestId || '');
    res.status(502).json({ success: false, error: 'Could not check the payment right now. Your plan is added automatically once it is confirmed.' });
  }
});

module.exports = router;
