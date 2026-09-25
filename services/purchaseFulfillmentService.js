/**
 * Gives a user what a plan contains, exactly once per payment:
 *  - the plan's credits,
 *  - the plan's eBay-account limit (never lowered: an admin may have given more),
 *  - the plan name shown under their name.
 * `transactionId` (the provider's payment id) makes it idempotent: the same payment reported twice
 * (a webhook retry, the return-page check racing the webhook) is credited once.
 */
async function fulfillPurchase({ userId, plan, provider, transactionId, priceUsd, listPriceUsd = null, discountPercent = 0, referralId = null, voucherId = null, silent = false, paymentMethod = null }) {
  const { recordPurchase } = require('../models/purchasesModel');
  const { addCredits, getUserById, setMaxEbayAccounts } = require('../models/usersModel');
  const User = require('../models/schemas/User');

  let purchase;
  try {
    purchase = await recordPurchase({ userId, planId: /^[a-f0-9]{24}$/i.test(String(plan.id)) ? plan.id : null, billing: plan.billing || null, termMonths: plan.termMonths || 0, provider, providerTransactionId: transactionId, priceUsd, creditsGranted: plan.credits, planName: plan.name, paymentMethod, listPriceUsd, discountPercent, referralId, voucherId });
  } catch (err) {
    if (err && err.code === 11000) return { granted: false, duplicate: true }; // the other request won the race
    throw err;
  }
  if (!purchase) return { granted: false, duplicate: true };

  // An earlier plan that has run out is closed first (its credits end), so the new credits start clean.
  await require('./planExpiryService').expireIfDue(userId).catch((err) => console.warn('plan expiry check failed:', err.message));
  await addCredits(userId, plan.credits);
  const buyer = await getUserById(userId);
  const limit = Number(plan.maxEbayAccounts) || 0;
  if (limit > 0 && buyer && (Number(buyer.maxEbayAccounts) || 0) < limit) await setMaxEbayAccounts(userId, limit);
  await User.updateOne({ _id: userId }, { $set: { planName: plan.name } }).catch(() => {});
  // A monthly / yearly plan: it runs one term from now, or one term on from where the running plan ends (buying early adds up).
  if (plan.termMonths > 0 && buyer) {
    const now = new Date();
    const running = buyer.planExpiresAt && new Date(buyer.planExpiresAt) > now;
    const set = { planExpiresAt: require('./planPricing').addMonths(running ? new Date(buyer.planExpiresAt) : now, plan.termMonths), planTerm: plan.billing === 'yearly' ? 'yearly' : 'monthly' };
    if (!running) set.planPrevMaxEbayAccounts = Math.max(1, Number(buyer.maxEbayAccounts) || 1);
    await User.updateOne({ _id: userId }, { $set: set }).catch(() => {});
  }

  // Referral programme: count a used discount, and reward the person who brought this buyer (once, for their first purchase).
  // afterPurchase never throws - the buyer already has their credits.
  // A voucher used to pay counts as used now (a payment that came in after the voucher was used elsewhere still stands: it was paid).
  if (voucherId) {
    const used = await require('./voucherService').markUsedForPurchase(voucherId, userId, transactionId);
    if (!used) {
      try { await require('./emailService').sendAdminAlert({ subject: 'A voucher was used twice', lines: ['User: ' + userId, 'Voucher: ' + voucherId, 'Payment: ' + transactionId, 'The voucher was already used (or revoked) when this payment arrived. The payment was accepted at the discounted price; nothing to do unless you want to look into it.'] }); } catch (_) { /* best effort */ }
    }
  }
  // A plan given free by a voucher is not a purchase: no referral reward, no receipt.
  if (!silent) await require('./referralService').afterPurchase({ userId, priceUsd, referralId });

  try {
    const { sendPurchaseReceiptEmail, sendAdminAlert } = require('./emailService');
    if (!silent && buyer && buyer.email) {
      sendPurchaseReceiptEmail({ to: buyer.email, credits: plan.credits, priceUsd, transactionId, purchase }).catch((e) => console.warn('receipt email failed:', e.message));
      sendAdminAlert({
        subject: 'New payment: $' + Number(priceUsd).toFixed(2),
        lines: ['User: ' + buyer.email, 'Plan: ' + plan.name, 'Credits: ' + plan.credits, 'Amount: $' + Number(priceUsd).toFixed(2) + (discountPercent > 0 && listPriceUsd ? ' (list price $' + Number(listPriceUsd).toFixed(2) + ', ' + discountPercent + '% referral discount)' : ''), 'Provider: ' + provider, 'Payment: ' + transactionId],
      }).catch(() => {});
    }
  } catch (mailErr) {
    console.warn('purchase: email step failed:', mailErr.message);
  }
  return { granted: true, credits: plan.credits, ebayAccounts: limit || null, planName: plan.name };
}

module.exports = { fulfillPurchase };
