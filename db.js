const mongoose = require('mongoose');

/**
 * Connects to MongoDB Atlas using the connection string in .env.
 * Call this once when the server starts, before any model is used.
 */
async function connectDB() {
  const uri = process.env.MONGODB_URI;

  if (!uri) {
    throw new Error('MONGODB_URI is not set in the .env file.');
  }

  await mongoose.connect(uri);
  console.log('Connected to MongoDB Atlas.');
  await migrateListingIndex();
  await migrateOrderIndex();
  await migrateProductCacheTtl();
  await migrateUserExtensionKeyIndex();
}

/**
 * users.extensionKeyHash used to be `default: null` + unique/sparse, so every user without an
 * extension key stored an explicit null and the second signup failed with
 * "E11000 duplicate key ... index: extensionKeyHash_1 dup key: { extensionKeyHash: null }".
 * Remove the stored nulls and swap the index for a partial one that only covers real hashes.
 */
async function migrateUserExtensionKeyIndex() {
  try {
    const User = require('./models/schemas/User');
    const indexes = await User.collection.indexes().catch(() => []);
    const old = indexes.find((i) => i.name === 'extensionKeyHash_1');
    if (old && !old.partialFilterExpression) {
      await User.collection.dropIndex('extensionKeyHash_1');
      console.log('Dropped old users index extensionKeyHash_1 (not partial).');
    }
    const cleared = await User.collection.updateMany({ extensionKeyHash: null }, { $unset: { extensionKeyHash: '' } });
    if (cleared.modifiedCount) console.log(`Cleared null extensionKeyHash on ${cleared.modifiedCount} user(s).`);
    await User.createIndexes();
  } catch (err) {
    console.warn('User extension key index migration skipped:', err.message);
  }
}

/**
 * Listings used to be unique per (user, sku), which stopped the same Amazon
 * product from being drafted in two different eBay stores. Swap that index for
 * (user, store, sku).
 */
async function migrateListingIndex() {
  try {
    const Listing = require('./models/schemas/Listing');
    const indexes = await Listing.collection.indexes().catch(() => []);
    if (indexes.some((i) => i.name === 'userId_1_sku_1')) {
      await Listing.collection.dropIndex('userId_1_sku_1');
      console.log('Dropped old listings index userId_1_sku_1.');
    }
    await Listing.syncIndexes();
  } catch (err) {
    console.warn('Listing index migration skipped:', err.message);
  }
}

/**
 * Orders used to be unique per ebayOrderId alone, from before an eBay order could have more
 * than one line item. That old single-field unique index is still sitting in the database
 * (models/schemas/Order.js has only ever declared the correct compound one, {userId,
 * ebayOrderId, sku}), so a second line item on the same order - or the same line item synced
 * twice at once by the periodic job and a webhook - hits a duplicate-key error on it and the
 * whole account's sync for that run fails (E11000 ... index: ebayOrderId_1).
 */
async function migrateOrderIndex() {
  try {
    const Order = require('./models/schemas/Order');
    const indexes = await Order.collection.indexes().catch(() => []);
    if (indexes.some((i) => i.name === 'ebayOrderId_1')) {
      await Order.collection.dropIndex('ebayOrderId_1');
      console.log('Dropped old orders index ebayOrderId_1.');
    }
    await Order.syncIndexes();
  } catch (err) {
    console.warn('Order index migration skipped:', err.message);
  }
}

/**
 * The ProductCache collection's TTL index (auto-cleanup, not the "is this still usable"
 * check - that's an admin setting checked in application code, see productCacheService.js)
 * moved from a fixed 7 days to a 90-day backstop. A TTL index's expireAfterSeconds is fixed
 * at index-creation time, so raising it needs the same drop-and-recreate as the other index
 * migrations above - otherwise rows already have the old 7-day auto-delete applied.
 */
async function migrateProductCacheTtl() {
  try {
    const ProductCache = require('./models/schemas/ProductCache');
    const indexes = await ProductCache.collection.indexes().catch(() => []);
    const ttlIndex = indexes.find((i) => i.name === 'fetchedAt_1');
    if (ttlIndex && ttlIndex.expireAfterSeconds !== 60 * 60 * 24 * 90) {
      await ProductCache.collection.dropIndex('fetchedAt_1');
      console.log('Dropped old productcaches TTL index fetchedAt_1 (was ' + ttlIndex.expireAfterSeconds + 's).');
    }
    await ProductCache.syncIndexes();
  } catch (err) {
    console.warn('Product cache TTL migration skipped:', err.message);
  }
}

module.exports = { connectDB };
