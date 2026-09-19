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
    ebayOrderFulfillmentStatus: { type: String, default: null },
    ebayPaymentStatus: { type: String, default: null },
    ebayCancelStatus: { type: String, default: null },

    // ---- Full eBay order detail (so ELMS shows the same information as Seller Hub) ----
    itemTitle: { type: String, default: null },      // eBay's own title, used when the item is not an ELMS listing
    legacyItemId: { type: String, default: null },   // the item number buyers see on eBay
    currency: { type: String, default: null },
    deliveryCost: { type: Number, default: null },   // shipping the buyer paid for this line
    tax: { type: Number, default: null },
    lineTotal: { type: Number, default: null },      // item + shipping + tax for this line
    orderTotal: { type: Number, default: null },     // whole eBay order total (all lines)
    buyerEmail: { type: String, default: null },
    buyerPhone: { type: String, default: null },
    buyerNote: { type: String, default: null },      // checkout note left by the buyer
    salesRecord: { type: String, default: null },
    marketplaceId: { type: String, default: null },
    shippingService: { type: String, default: null },
    lineItemStatus: { type: String, default: null }, // NOT_STARTED | IN_PROGRESS | FULFILLED
    ebayCreatedAt: { type: Date, default: null },    // when the buyer placed the order on eBay
    ebayModifiedAt: { type: Date, default: null },
    paidAt: { type: Date, default: null },
    shipByDate: { type: Date, default: null },
    estDeliveryMin: { type: Date, default: null },
    estDeliveryMax: { type: Date, default: null },
    sellerNote: { type: String, default: '' },       // private note, only stored in ELMS
  },
  { timestamps: true }
);

// One eBay order can contain multiple line items (SKUs) - each becomes its
// own row here, but the same (user, order, SKU) combination should never be
// synced twice. Sparse so rows without an ebayOrderId/sku (shouldn't happen
// via sync, but just in case) don't collide with each other.
orderSchema.index({ userId: 1, ebayOrderId: 1, sku: 1 }, { unique: true, sparse: true });
orderSchema.index({ userId: 1, ebayAccountId: 1, createdAt: -1 });
orderSchema.index({ userId: 1, ebayCreatedAt: -1 });

module.exports = mongoose.model('Order', orderSchema);
