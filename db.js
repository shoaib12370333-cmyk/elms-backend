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

module.exports = { connectDB };
