const mongoose = require('mongoose');

/**
 * A "Buy Listings" tier the admin sets on the Plans screen (e.g. "$10 = 1000 listings"). Bought only through CashTap - like the
 * custom plan and yearly plans, this is never sold through Paddle (Paddle's prices are fixed inside Paddle itself).
 */
const listingPackTierSchema = new mongoose.Schema(
  {
    name: { type: String, required: true }, // e.g. "1,000 listings"
    priceUsd: { type: Number, required: true },
    listingCount: { type: Number, required: true }, // how many random ready-to-list drafts a purchase gives
    active: { type: Boolean, default: true }, // inactive tiers are hidden from Buy Credits > Buy Listings
  },
  { timestamps: true }
);

module.exports = mongoose.model('ListingPackTier', listingPackTierSchema);
