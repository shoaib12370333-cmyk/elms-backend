const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/requireAuth');
const { listActivePlans, getPlanById } = require('../models/plansModel');
const { listPurchasesForUser, getPurchaseById } = require('../models/purchasesModel');
const invoices = require('../services/invoiceService');
const planPricing = require('../services/planPricing');
const { getCustomPlanSettings } = require('../models/settingsModel');
const referrals = require('../services/referralService');
const vouchers = require('../services/voucherService');
const { getUserById } = require('../models/usersModel');
const { createTransaction } = require('../services/paddleService');
const cashtapPayments = require('../services/cashtapPaymentService');

/**
 * Card and other payment methods go through Paddle. It is offered NEXT TO CashTap (Cash App) when both Paddle secrets are set and
 * a plan has its Paddle price id. Prices are fixed inside Paddle, so referral discounts, vouchers, yearly and custom plans stay Cash App only.
 */
const paddleConfigured = () => !!(process.env.PADDLE_API_KEY && process.env.PADDLE_WEBHOOK_SECRET);

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
    const card = provider === 'paddle' || (paddleConfigured() && (await listActivePlans()).some((p) => p.paddlePriceId));
    res.json({ success: true, plans, card });
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
  // The custom plan is CashTap-only (its yearly discount has no meaning for Paddle). A plan's yearly term is sellable
  // through Paddle only when the admin gave it its own paddleYearlyPriceId - otherwise it is hidden when Paddle is the
  // only provider (nothing could sell it), same as before.
  const plans = (await listActivePlans()).filter((p) => provider === 'cashtap' || p.paddlePriceId).map((p) => (provider === 'cashtap' || p.paddleYearlyPriceId ? p : { ...p, yearlyPriceUsd: null }))
    .map((p) => ({ ...p, paddleAvailable: provider === 'cashtap' && paddleConfigured() && !!p.paddlePriceId, paddleYearlyAvailable: provider === 'cashtap' && paddleConfigured() && !!p.paddleYearlyPriceId }));
  const custom = provider === 'cashtap' ? await getCustomPlanSettings() : null;
  const me = await getUserById(req.userId).catch(() => null);
  const extra = {
    custom: custom && custom.enabled ? custom : null,
    myPlan: me && me.planExpiresAt ? { planName: me.planName, term: me.planTerm, expiresAt: me.planExpiresAt } : null,
  };
  // A voucher the buyer picked on the page: the plans show the price with it (CashTap checkout only).
  if (req.query.voucherId && provider === 'cashtap') {
    try {
      const v = await vouchers.usableForPurchase(req.userId, String(req.query.voucherId), null);
      return res.json({
        success: true,
        provider,
        ...extra,
        plans: plans.map((p) => (vouchers.appliesToPlan(v, p) ? { ...p, discountedPriceUsd: vouchers.priceWith(p.priceUsd, v), ...(p.yearlyPriceUsd ? { discountedYearlyPriceUsd: vouchers.priceWith(p.yearlyPriceUsd, v) } : {}) } : { ...p, voucherNotValid: true })),
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
    ...extra,
    plans: plans.map((p) => (discount ? { ...p, discountedPriceUsd: referrals.priceAfterDiscount(p.priceUsd, discount.percent), ...(p.yearlyPriceUsd ? { discountedYearlyPriceUsd: referrals.priceAfterDiscount(p.yearlyPriceUsd, discount.percent) } : {}) } : p)),
    referralDiscount: discount ? { percent: discount.percent, usesLeft: discount.usesLeft, expiresAt: discount.expiresAt } : null,
  });
});

/**
 * GET /api/payments/custom-quote?amountUsd=120&billing=monthly|yearly&extraStores=0
 * What the custom plan costs and gives for these choices (the same numbers the checkout will use).
 */
router.get('/custom-quote', requireAuth, async (req, res) => {
  if (cashtapPayments.activeProvider() !== 'cashtap') return res.status(404).json({ success: false, error: 'The custom plan is not available.' });
  try {
    const offer = planPricing.customOffer(await getCustomPlanSettings(), { amountUsd: Number(req.query.amountUsd), billing: req.query.billing, extraStores: req.query.extraStores });
    let discount = null;
    try { discount = await referrals.discountFor(req.userId); } catch (_) { /* no discount */ }
    res.json({ success: true, offer, discountedPriceUsd: discount ? referrals.priceAfterDiscount(offer.priceUsd, discount.percent) : null, referralPercent: discount ? discount.percent : 0 });
  } catch (err) {
    res.status(err.userFacing ? err.statusCode : 500).json({ success: false, error: err.userFacing ? err.message : 'Could not work out that plan.' });
  }
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
  const wantsCustom = !!req.body.custom;

  if (!planId && !wantsCustom) {
    return res.status(400).json({ success: false, error: 'A planId is required.' });
  }

  const plan = wantsCustom ? null : await getPlanById(planId);
  if (!wantsCustom && (!plan || !plan.active)) {
    return res.status(404).json({ success: false, error: 'This plan is not available.' });
  }

  const user = await getUserById(req.userId);
  if (!user) {
    return res.status(404).json({ success: false, error: 'User not found.' });
  }

  // The buyer can pick card / other methods (Paddle) even while Cash App (CashTap) is the main checkout.
  const wantsPaddle = String(req.body.provider || '').toLowerCase() === 'paddle';
  if (wantsPaddle && !paddleConfigured()) return res.status(400).json({ success: false, error: 'Card payments are not available right now.' });
  const provider = wantsPaddle ? 'paddle' : cashtapPayments.activeProvider();
  if (provider === 'paddle' && req.body.voucherId) {
    return res.status(400).json({ success: false, error: 'A voucher can only be used when paying with Cash App.' });
  }
  // The custom plan's yearly discount is worked out for CashTap only; a standard plan's yearly term can go through
  // Paddle too, but only once the admin gave it its own paddleYearlyPriceId (checked below, with the monthly one).
  if (wantsCustom && provider !== 'cashtap') {
    return res.status(400).json({ success: false, error: 'This option is not available right now.' });
  }
  try {
    if (provider === 'cashtap') {
      // The plan for the chosen term (or the custom plan the buyer built): price, credits and term are worked out here, never taken from the browser.
      let offer;
      if (wantsCustom) {
        if (req.body.voucherId) return res.status(400).json({ success: false, error: 'A voucher cannot be used on the custom plan.' });
        offer = planPricing.customOffer(await getCustomPlanSettings(), { ...req.body.custom, billing: req.body.billing || req.body.custom.billing });
      } else {
        offer = planPricing.planOffer(plan, req.body.billing);
      }
      // A voucher the buyer chose is used instead of the referral discount.
      const voucher = req.body.voucherId ? await vouchers.usableForPurchase(req.userId, String(req.body.voucherId), plan) : null;
      const discount = voucher ? null : await referrals.discountFor(req.userId).catch((err) => { console.error('referral discount lookup failed:', err.message); return null; });
      const { sessionId, url } = await cashtapPayments.startCheckout({ user, plan: offer, discount, voucher });
      return res.json({ success: true, provider, sessionId, url, discountPercent: discount ? discount.percent : 0, voucherApplied: !!voucher });
    }
    const billing = String(req.body.billing || '').toLowerCase() === 'yearly' ? 'yearly' : 'monthly';
    const paddlePriceId = billing === 'yearly' ? plan.paddleYearlyPriceId : plan.paddlePriceId;
    if (!paddlePriceId) return res.status(404).json({ success: false, error: 'This plan is not available.' });
    const { transactionId } = await createTransaction({
      paddlePriceId,
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
