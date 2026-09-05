const mongoose = require('mongoose');

const planSchema = new mongoose.Schema(
  {
    name: { type: String, required: true }, // e.g. "Starter"
    priceUsd: { type: Number, required: true }, // e.g. 10
    credits: { type: Number, required: true }, // e.g. 300
    paddlePriceId: { type: String, required: true }, // e.g. "pri_01abc..."
    active: { type: Boolean, default: true }, // inactive plans are hidden from the Pricing page
  },
  { timestamps: true }
);

module.exports = mongoose.model('Plan', planSchema);
