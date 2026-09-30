const ListingPackTier = require('./schemas/ListingPackTier');

/** Admin-only: creates a new "Buy Listings" pricing tier. */
async function createTier({ name, priceUsd, listingCount }) {
  const doc = await ListingPackTier.create({ name, priceUsd: Number(priceUsd), listingCount: Number(listingCount) });
  return serialize(doc);
}

/** Admin-only: updates an existing tier. Only provided (non-undefined) fields are changed. */
async function updateTier(id, { name, priceUsd, listingCount, active }) {
  const update = {};
  if (name !== undefined) update.name = name;
  if (priceUsd !== undefined) update.priceUsd = Number(priceUsd);
  if (listingCount !== undefined) update.listingCount = Number(listingCount);
  if (active !== undefined) update.active = active;

  const doc = await ListingPackTier.findByIdAndUpdate(id, update, { new: true });
  return doc ? serialize(doc) : null;
}

/** Admin-only: permanently removes a tier. Does not affect buyers who already bought it. */
async function deleteTier(id) {
  const doc = await ListingPackTier.findByIdAndDelete(id);
  return !!doc;
}

/** Admin-only: every tier (active and inactive), for the Admin Panel's Plans tab. */
async function listAllTiers() {
  const docs = await ListingPackTier.find().sort({ priceUsd: 1 });
  return docs.map(serialize);
}

/** Only active tiers, for the Buy Credits > Buy Listings tab. */
async function listActiveTiers() {
  const docs = await ListingPackTier.find({ active: true }).sort({ priceUsd: 1 });
  return docs.map(serialize);
}

async function getTierById(id) {
  if (!/^[a-f0-9]{24}$/i.test(String(id || ''))) return null;
  const doc = await ListingPackTier.findById(id);
  return doc ? serialize(doc) : null;
}

function serialize(doc) {
  const obj = doc.toObject();
  return {
    id: obj._id.toString(),
    name: obj.name,
    priceUsd: obj.priceUsd,
    listingCount: obj.listingCount,
    active: obj.active,
  };
}

module.exports = { createTier, updateTier, deleteTier, listAllTiers, listActiveTiers, getTierById };
