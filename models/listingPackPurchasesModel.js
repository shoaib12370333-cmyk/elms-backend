const ListingPackPurchase = require('./schemas/ListingPackPurchase');

/**
 * Records a completed listing-pack purchase. Returns null (instead of creating a duplicate) if this providerTransactionId
 * was already recorded - the caller should treat that as "already fulfilled" and not push the listings again.
 */
async function recordPurchase({ userId, tierId, tierName, provider, providerTransactionId, priceUsd, listingCount, pushed }) {
  const existing = await ListingPackPurchase.findOne({ providerTransactionId });
  if (existing) return null;
  const doc = await ListingPackPurchase.create({ userId, tierId, tierName, provider, providerTransactionId, priceUsd, listingCount, pushed });
  return serialize(doc);
}

async function purchaseExists(providerTransactionId) {
  return !!(await ListingPackPurchase.exists({ providerTransactionId: String(providerTransactionId) }));
}

async function listPurchasesForUser(userId) {
  const docs = await ListingPackPurchase.find({ userId }).sort({ createdAt: -1 });
  return docs.map(serialize);
}

function serialize(doc) {
  const obj = doc.toObject();
  return {
    id: obj._id.toString(),
    userId: obj.userId.toString(),
    tierId: obj.tierId ? obj.tierId.toString() : null,
    tierName: obj.tierName || null,
    provider: obj.provider,
    providerTransactionId: obj.providerTransactionId,
    priceUsd: obj.priceUsd,
    listingCount: obj.listingCount,
    pushed: obj.pushed || 0,
    createdAt: obj.createdAt,
  };
}

module.exports = { recordPurchase, purchaseExists, listPurchasesForUser };
