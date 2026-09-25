/**
 * Gives a user what a plan contains, exactly once per payment:
 *  - the plan's credits,
 *  - the plan's eBay-account limit (never lowered: an admin may have given more),
 *  - the plan name shown under their name, and the term of a monthly / yearly plan.
 * `transactionId` (the provider's payment id) makes it idempotent: the same payment reported twice
 * (a webhook retry, the return-page check racing the webhook) is credited once.
 *
 * The ORDER matters, because a payment can be reported more than once and the process can stop at any step:
 *   1. the credits and the plan are given in one atomic update that also notes the payment id on the user
 *      (services/planGrantService.js), so it is safe to repeat;
 *   2. only then the purchase row is written. The row is what "this payment is finished" means for every other report of it.
 * The row used to be written first: an error or a restart between the two steps left a purchase with no credits, and every retry
 * was answered "already done", so the buyer paid and never got the credits (and nobody was told).
 */
async function alertAdmin(subject, lines) {
  try { await require('./emailService').sendAdminAlert({ subject, lines }); } catch (err) { console.warn('payment: admin alert failed:', err.message); }
}

/** A payment that is reported again: makes sure its affiliate commission exists (in case the process stopped right after the row). */
async function healCommission(transactionId) {
  try {
    const existing = await require('../models/purchasesModel').getByTransactionId(transactionId);
    if (existing) await require('./affiliateService').recordCommission(existing); // one commission per purchase: a repeat changes nothing
  } catch (err) {
    console.warn('commission check for a repeated payment failed:', err.message);
  }
}

async function fulfillPurchase({ userId, plan, provider, transactionId, priceUsd, listPriceUsd = null, discountPercent = 0, referralId = null, voucherId = null, silent = false, paymentMethod = null }) {
  const { recordPurchase, purchaseExists } = require('../models/purchasesModel');
  const { getUserById } = require('../models/usersModel');
  const { grantOnce } = require('./planGrantService');
  const limit = Number(plan.maxEbayAccounts) || 0;

  // Finished before: the row is written last, after the credits (see above).
  if (await purchaseExists(transactionId)) {
    if (!silent) await healCommission(transactionId);
    return { granted: false, duplicate: true };
  }

  // An earlier plan that has run out is closed first (its credits end), so the new credits start clean.
  await require('./planExpiryService').expireIfDue(userId).catch((err) => console.warn('plan expiry check failed:', err.message));

  const grant = await grantOnce({ userId, plan, transactionId });
  if (grant.status === 'missing') {
    await alertAdmin('A payment arrived for an account that does not exist', ['User id: ' + userId, 'Plan: ' + plan.name, 'Payment: ' + transactionId, 'Amount: $' + Number(priceUsd).toFixed(2), 'Nobody was credited. Please check it by hand.']);
    return { granted: false, reason: 'user_missing' };
  }

  let purchase;
  try {
    purchase = await recordPurchase({ userId, planId: /^[a-f0-9]{24}$/i.test(String(plan.id)) ? plan.id : null, billing: plan.billing || null, termMonths: plan.termMonths || 0, provider, providerTransactionId: transactionId, priceUsd, creditsGranted: plan.credits, planName: plan.name, paymentMethod, listPriceUsd, discountPercent, referralId, voucherId });
  } catch (err) {
    if (err && err.code === 11000) return { granted: false, duplicate: true }; // the other report of this payment wrote the row
    // The buyer HAS the credits; only the record is missing. The payment is reported again by the provider (or the return page) and that run writes it.
    await alertAdmin('A payment was credited but its record could not be saved', ['User id: ' + userId, 'Plan: ' + plan.name, 'Payment: ' + transactionId, 'Error: ' + (err && err.message), 'The buyer has the credits. The record is written when the payment is reported again.']);
    throw err;
  }
  if (!purchase) return { granted: false, duplicate: true };

  // Referral programme: count a used discount, and reward the person who brought this buyer (once, for their first purchase).
  // afterPurchase never throws - the buyer already has their credits.
  // A voucher used to pay counts as used now (a payment that came in after the voucher was used elsewhere still stands: it was paid).
  if (voucherId) {
    const used = await require('./voucherService').markUsedForPurchase(voucherId, userId, transactionId);
    if (!used) {
      await alertAdmin('A voucher was used twice', ['User: ' + userId, 'Voucher: ' + voucherId, 'Payment: ' + transactionId, 'The voucher was already used (or revoked) when this payment arrived. The payment was accepted at the discounted price; nothing to do unless you want to look into it.']);
    }
  }
  // The affiliate who brought this buyer earns their percentage of the payment (never throws).
  if (!silent) await require('./affiliateService').recordCommission(purchase);

  // A plan given free by a voucher is not a purchase: no referral reward, no receipt.
  if (!silent) await require('./referralService').afterPurchase({ userId, priceUsd, referralId });

  try {
    const { sendPurchaseReceiptEmail, sendAdminAlert } = require('./emailService');
    const buyer = silent ? null : await getUserById(userId);
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
