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
}

module.exports = { connectDB };
