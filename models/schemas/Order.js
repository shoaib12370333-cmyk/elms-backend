const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    listingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Listing', default: null },
    ebayOrderId: { type: String, default: null },
    sku: { type: String, default: null }, // which line item within the eBay order this row represents
    buyerUsername: { type: String, default: null },
    salePrice: { type: Number, default: null },
    quantity: { type: Number, default: 1 },
    fulfillmentStatus: {
      type: String,
      enum: ['pending', 'ordered_from_amazon', 'shipped', 'delivered'],
      default: 'pending',
    },
    amazonOrderId: { type: String, default: null },
  },
  { timestamps: true }
);

// One eBay order can contain multiple line items (SKUs) - each becomes its
// own row here, but the same (user, order, SKU) combination should never be
// synced twice. Sparse so rows without an ebayOrderId/sku (shouldn't happen
// via sync, but just in case) don't collide with each other.
orderSchema.index({ userId: 1, ebayOrderId: 1, sku: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('Order', orderSchema);
