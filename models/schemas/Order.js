const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    // Which of the user's (possibly several) connected eBay accounts this
    // order came from - lets the combined Orders view show/filter by account.
    ebayAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'EbayAccount', default: null },
    listingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Listing', default: null },
    ebayOrderId: { type: String, default: null },
    ebayLineItemId: { type: String, default: null }, // eBay's own line item ID, needed to attach a tracking fulfillment later
    sku: { type: String, default: null }, // which line item within the eBay order this row represents
    buyerUsername: { type: String, default: null },
    salePrice: { type: Number, default: null },
    quantity: { type: Number, default: 1 },

    // Product variant this specific order line is for (e.g. "Color: Blue,
    // Size: Large"), if the listing has variations.
    variantDetails: { type: String, default: null },

    // Buyer's shipping address, needed to place the matching order on Amazon.
    shippingAddress: {
      fullName: { type: String, default: null },
      addressLine1: { type: String, default: null },
      addressLine2: { type: String, default: null },
      city: { type: String, default: null },
      stateOrProvince: { type: String, default: null },
      postalCode: { type: String, default: null },
      country: { type: String, default: null },
    },

    // Tracking info, once the seller ships the item from Amazon.
    trackingNumber: { type: String, default: null },
    shippingCarrier: { type: String, default: null },

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
