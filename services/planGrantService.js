/**
 * Gives a buyer what a payment bought - the credits, the eBay-account limit, the plan name and the term of a monthly / yearly
 * plan - in ONE atomic update that also writes the payment id into the buyer's own list of processed payments
 * (User.processedPayments).
 *
 * Why one update: a payment is reported more than once (webhook retries, the return-page check racing the webhook) and the process
 * can stop at any moment. Because the credits and the payment id are written together, a payment is never credited twice and never
 * "recorded but not credited": if the process dies right after this update, the next report of the same payment finds its id in
 * the list, gives nothing again and simply carries on with the rest (the purchase row, the receipt).
 */
const { addMonths } = require('./planPricing');

const KEEP = 200; // payment ids remembered per person; a webhook is retried within hours, not after 200 more purchases
const TRIES = 6;

/**
 * @param {{ userId: string, plan: { credits: number, name: string, maxEbayAccounts?: number|null, termMonths?: number, billing?: string|null }, transactionId: string }} p
 * @returns {Promise<{ status: 'applied' | 'already' | 'missing' }>}
 *   applied: given now; already: an earlier report of this payment gave it (nothing more is given); missing: there is no such user.
 */
async function grantOnce({ userId, plan, transactionId }) {
  const User = require('../models/schemas/User');
  const tx = String(transactionId);
  const credits = Number(plan.credits) || 0;
  const limit = Number(plan.maxEbayAccounts) || 0;

  for (let attempt = 0; attempt < TRIES; attempt += 1) {
    const buyer = await User.findOne({ _id: userId }, { maxEbayAccounts: 1, planExpiresAt: 1 }).lean();
    if (!buyer) return { status: 'missing' };

    const now = new Date();
    const currentLimit = buyer.maxEbayAccounts == null ? 1 : Number(buyer.maxEbayAccounts) || 0;
    const set = { planName: plan.name };
    if (limit > 0 && currentLimit < limit) set.maxEbayAccounts = limit; // raised, never lowered: an admin may have given more
    if (plan.termMonths > 0) {
      // a monthly / yearly plan runs one term from now, or one term on from where the running plan ends (buying early adds up)
      const running = buyer.planExpiresAt && new Date(buyer.planExpiresAt) > now;
      set.planExpiresAt = addMonths(running ? new Date(buyer.planExpiresAt) : now, plan.termMonths);
      set.planTerm = plan.billing === 'yearly' ? 'yearly' : 'monthly';
      if (!running) set.planPrevMaxEbayAccounts = Math.max(1, currentLimit || 1); // the limit before the plan raised it
    }

    const res = await User.updateOne(
      // The expiry and the limit must still be what was read: if another purchase or an admin changed them in between, read again.
      { _id: userId, processedPayments: { $ne: tx }, planExpiresAt: buyer.planExpiresAt || null, maxEbayAccounts: buyer.maxEbayAccounts == null ? null : buyer.maxEbayAccounts },
      { $inc: { creditBalance: credits }, $set: set, $push: { processedPayments: { $each: [tx], $slice: -KEEP } } }
    );
    if (res && (res.modifiedCount === 1 || res.nModified === 1)) return { status: 'applied' };
    if (await User.exists({ _id: userId, processedPayments: tx })) return { status: 'already' };
    // nothing matched and the payment is not on the list: the account changed between the read and the write, so read again
  }
  throw new Error('The payment ' + tx + ' could not be given because the account kept changing. It is tried again when the payment is reported next.');
}

module.exports = { grantOnce, KEEP };
