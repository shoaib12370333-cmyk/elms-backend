const mongoose = require('mongoose');

const planSchema = new mongoose.Schema(
  {
    name: { type: String, required: true }, // e.g. "Starter"
    priceUsd: { type: Number, required: true }, // e.g. 10
    credits: { type: Number, required: true }, // e.g. 300
    // Only needed to sell this plan through Paddle (optional now that CashTap is the default checkout).
    paddlePriceId: { type: String, default: null }, // e.g. "pri_01abc..."
    // How many eBay accounts the buyer may connect after buying this plan (null = leave their limit as it is).
    maxEbayAccounts: { type: Number, default: null },
    // Yearly price (12 months of credits at once). Empty = the plan has no yearly option; giving it a price switches the option on.
    yearlyPriceUsd: { type: Number, default: null },
    active: { type: Boolean, default: true }, // inactive plans are hidden from the Pricing page
  },
  { timestamps: true }
);

module.exports = mongoose.model('Plan', planSchema);
