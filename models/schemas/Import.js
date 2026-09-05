const mongoose = require('mongoose');

const importSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    asin: { type: String, default: null },
    title: { type: String, default: null },
    amazonUrl: { type: String, default: null },
    amazonPrice: { type: Number, default: null },
    currency: { type: String, default: 'USD' },
    mainImage: { type: String, default: null },
    product: { type: mongoose.Schema.Types.Mixed, required: true }, // full normalized product object
    suggestedPrice: { type: Number, default: null },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: false } }
);

module.exports = mongoose.model('Import', importSchema);
