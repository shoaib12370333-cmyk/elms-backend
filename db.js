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

module.exports = { connectDB };
