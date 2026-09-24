const Purchase = require('./schemas/Purchase');

/**
 * Records a completed purchase. Returns null (instead of creating a
 * duplicate) if this providerTransactionId has already been recorded -
 * this is what prevents a user from being credited twice if Paddle
 * re-sends the same webhook (which it does by design - "at least once"
 * delivery).
 */
async function recordPurchase({ userId, planId, provider, providerTransactionId, priceUsd, creditsGranted, listPriceUsd = null, discountPercent = 0, referralId = null }) {
  const existing = await Purchase.findOne({ providerTransactionId });
  if (existing) return null; // already processed - caller should skip crediting again

  const doc = await Purchase.create({
    userId,
    planId,
    provider,
    providerTransactionId,
    priceUsd,
    creditsGranted,
    listPriceUsd,
    discountPercent,
    referralId,
  });
  return serialize(doc);
}

/** True once the user has completed at least one purchase (a referral code can only be added before the first one). */
async function hasPurchases(userId) {
  return !!(await Purchase.exists({ userId, status: 'completed' }));
}

/**
 * Returns a user's own purchase history.
 */
async function listPurchasesForUser(userId) {
  const docs = await Purchase.find({ userId }).sort({ createdAt: -1 });
  return docs.map(serialize);
}

function serialize(doc) {
  const obj = doc.toObject();
  return {
    id: obj._id.toString(),
    userId: obj.userId.toString(),
    planId: obj.planId ? obj.planId.toString() : null,
    provider: obj.provider,
    providerTransactionId: obj.providerTransactionId,
    priceUsd: obj.priceUsd,
    listPriceUsd: obj.listPriceUsd == null ? obj.priceUsd : obj.listPriceUsd,
    discountPercent: obj.discountPercent || 0,
    creditsGranted: obj.creditsGranted,
    status: obj.status,
    createdAt: obj.createdAt,
  };
}

module.exports = { recordPurchase, listPurchasesForUser, hasPurchases };
