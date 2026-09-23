/**
 * Gives a user what a plan contains, exactly once per payment:
 *  - the plan's credits,
 *  - the plan's eBay-account limit (never lowered: an admin may have given more),
 *  - the plan name shown under their name.
 * `transactionId` (the provider's payment id) makes it idempotent: the same payment reported twice
 * (a webhook retry, the return-page check racing the webhook) is credited once.
 */
async function fulfillPurchase({ userId, plan, provider, transactionId, priceUsd }) {
  const { recordPurchase } = require('../models/purchasesModel');
  const { addCredits, getUserById, setMaxEbayAccounts } = require('../models/usersModel');
  const User = require('../models/schemas/User');

  let purchase;
  try {
    purchase = await recordPurchase({ userId, planId: plan.id, provider, providerTransactionId: transactionId, priceUsd, creditsGranted: plan.credits });
  } catch (err) {
    if (err && err.code === 11000) return { granted: false, duplicate: true }; // the other request won the race
    throw err;
  }
  if (!purchase) return { granted: false, duplicate: true };

  await addCredits(userId, plan.credits);
  const buyer = await getUserById(userId);
  const limit = Number(plan.maxEbayAccounts) || 0;
  if (limit > 0 && buyer && (Number(buyer.maxEbayAccounts) || 0) < limit) await setMaxEbayAccounts(userId, limit);
  await User.updateOne({ _id: userId }, { $set: { planName: plan.name } }).catch(() => {});

  try {
    const { sendPurchaseReceiptEmail, sendAdminAlert } = require('./emailService');
    if (buyer && buyer.email) {
      sendPurchaseReceiptEmail({ to: buyer.email, credits: plan.credits, priceUsd, transactionId }).catch((e) => console.warn('receipt email failed:', e.message));
      sendAdminAlert({
        subject: 'New payment: $' + Number(priceUsd).toFixed(2),
        lines: ['User: ' + buyer.email, 'Plan: ' + plan.name, 'Credits: ' + plan.credits, 'Amount: $' + Number(priceUsd).toFixed(2), 'Provider: ' + provider, 'Payment: ' + transactionId],
      }).catch(() => {});
    }
  } catch (mailErr) {
    console.warn('purchase: email step failed:', mailErr.message);
  }
  return { granted: true, credits: plan.credits, ebayAccounts: limit || null, planName: plan.name };
}

module.exports = { fulfillPurchase };
