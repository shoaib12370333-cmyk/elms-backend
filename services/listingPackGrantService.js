/**
 * Gives a buyer what a "Buy Listings" payment bought: `tier.listingCount` random, ready-to-list drafts (services/listingCloneService.js),
 * cloned straight from other sellers' already-categorized listings - no Easyparser/Canopy call, no credit charge.
 *
 * Idempotent the same way a plan purchase is (services/planGrantService.js): the purchase row is keyed by the provider's
 * transaction id, so the same CashTap session reported twice (a webhook retry racing the return-page check) pushes the
 * listings only once. Unlike a plan, there is nothing to "give twice" atomically in one Mongo update - the guard here is
 * the purchase row itself, written only after the clone finishes.
 */
async function grantOnce({ userId, tier, transactionId }) {
  const { purchaseExists, recordPurchase } = require('../models/listingPackPurchasesModel');
  const { pushRandomListings } = require('./listingCloneService');
  const { getUserById } = require('../models/usersModel');

  const tx = String(transactionId);
  if (await purchaseExists(tx)) return { status: 'already' };

  const user = await getUserById(userId);
  if (!user) return { status: 'missing' };

  const { pushed, poolSize } = await pushRandomListings({ targetUserId: userId, count: tier.listingCount });

  let purchase;
  try {
    purchase = await recordPurchase({
      userId,
      tierId: /^[a-f0-9]{24}$/i.test(String(tier.id)) ? tier.id : null,
      tierName: tier.name,
      provider: 'cashtap',
      providerTransactionId: tx,
      priceUsd: Number(tier.priceUsd),
      listingCount: tier.listingCount,
      pushed,
    });
  } catch (err) {
    if (err && err.code === 11000) return { status: 'already' }; // another report of this payment wrote the row first
    throw err;
  }
  // recordPurchase returns null (instead of throwing) when another report of this payment already wrote the row - the
  // clone above still ran for this call, but only the winner's result is reported back as "applied".
  if (!purchase) return { status: 'already' };

  try {
    if (user.email) {
      await require('./emailService').sendAdminAlert({
        subject: 'New Buy Listings payment: $' + Number(tier.priceUsd).toFixed(2),
        lines: ['User: ' + user.email, 'Tier: ' + tier.name, 'Requested: ' + tier.listingCount + ', pushed: ' + pushed + ' (pool had ' + poolSize + ')', 'Payment: ' + tx],
      });
    }
  } catch (err) {
    console.warn('listing pack admin alert failed:', err.message);
  }

  return { status: 'applied', pushed, requested: tier.listingCount };
}

module.exports = { grantOnce };
