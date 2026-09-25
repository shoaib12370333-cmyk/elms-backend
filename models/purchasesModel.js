const Purchase = require('./schemas/Purchase');

/**
 * Records a completed purchase. Returns null (instead of creating a
 * duplicate) if this providerTransactionId has already been recorded -
 * this is what prevents a user from being credited twice if Paddle
 * re-sends the same webhook (which it does by design - "at least once"
 * delivery).
 */
async function recordPurchase({ userId, planId, provider, providerTransactionId, priceUsd, creditsGranted, listPriceUsd = null, discountPercent = 0, referralId = null, voucherId = null, planName = null, paymentMethod = null }) {
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
    voucherId,
    planName,
    paymentMethod,
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

/** One purchase by id (the caller checks whose it is). */
async function getPurchaseById(id) {
  if (!/^[a-f0-9]{24}$/i.test(String(id || ''))) return null;
  const doc = await Purchase.findById(id);
  return doc ? serialize(doc) : null;
}

/** The invoice number of a purchase: made the first time it is needed, then never changed. Numbers run on in order (ELMS-2026-000123). */
async function ensureInvoiceNumber(id) {
  const Counter = require('./schemas/Counter');
  const doc = await Purchase.findById(id);
  if (!doc) return null;
  if (doc.invoiceNo) return doc.invoiceNo;
  const year = new Date(doc.createdAt || Date.now()).getUTCFullYear();
  const counter = await Counter.findOneAndUpdate({ _id: 'invoice' }, { $inc: { seq: 1 } }, { new: true, upsert: true });
  const number = 'ELMS-' + year + '-' + String(counter.seq).padStart(6, '0');
  // another request may have numbered it in the meantime: the first number stays
  const done = await Purchase.findOneAndUpdate({ _id: id, invoiceNo: null }, { $set: { invoiceNo: number } }, { new: true });
  if (done) return number;
  const now = await Purchase.findById(id);
  return now && now.invoiceNo;
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
    planName: obj.planName || null,
    paymentMethod: obj.paymentMethod || null,
    invoiceNo: obj.invoiceNo || null,
    createdAt: obj.createdAt,
  };
}

module.exports = { recordPurchase, listPurchasesForUser, hasPurchases, getPurchaseById, ensureInvoiceNumber };
