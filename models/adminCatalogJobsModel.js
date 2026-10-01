const AdminCatalogJob = require('./schemas/AdminCatalogJob');

async function createAdminCatalogJob(createdBy, { marketplaceId, items }) {
  const doc = await AdminCatalogJob.create({ createdBy, marketplaceId, items, total: items.length });
  return serialize(doc);
}

async function getAdminCatalogJob(id) {
  const doc = await AdminCatalogJob.findById(id);
  return doc ? serialize(doc) : null;
}

/** Newest 20 jobs, items omitted (they can be large) - the Admin Panel's "recent fetches" list. */
async function listAdminCatalogJobs() {
  const docs = await AdminCatalogJob.find({}).select('-items').sort({ createdAt: -1 }).limit(20).lean();
  return docs.map(serializeSummary);
}

async function cancelAdminCatalogJob(id) {
  const doc = await AdminCatalogJob.findOneAndUpdate(
    { _id: id, status: { $in: ['queued', 'polling'] } },
    { status: 'cancelled', finishedAt: new Date() },
    { new: true }
  );
  return doc ? serialize(doc) : null;
}

function serializeItem(item) {
  return {
    amazonUrl: item.amazonUrl,
    asin: item.asin,
    country: item.country,
    status: item.status,
    catalogItemId: item.catalogItemId ? String(item.catalogItemId) : null,
    error: item.error || null,
  };
}

function serialize(doc) {
  const obj = doc.toObject ? doc.toObject() : doc;
  return {
    id: String(obj._id),
    marketplaceId: obj.marketplaceId,
    status: obj.status,
    total: obj.total,
    done: obj.done,
    failed: obj.failed,
    pending: obj.total - obj.done - obj.failed,
    lastError: obj.lastError || null,
    items: (obj.items || []).map(serializeItem),
    createdAt: obj.createdAt,
    finishedAt: obj.finishedAt,
  };
}

function serializeSummary(obj) {
  return {
    id: String(obj._id),
    marketplaceId: obj.marketplaceId,
    status: obj.status,
    total: obj.total,
    done: obj.done,
    failed: obj.failed,
    pending: obj.total - obj.done - obj.failed,
    createdAt: obj.createdAt,
    finishedAt: obj.finishedAt,
  };
}

module.exports = { createAdminCatalogJob, getAdminCatalogJob, listAdminCatalogJobs, cancelAdminCatalogJob };
