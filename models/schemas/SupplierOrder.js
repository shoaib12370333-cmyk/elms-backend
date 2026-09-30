const mongoose = require('mongoose');

/**
 * One eBay order line that Auto Order is buying (or tried to buy) from the supplier on the seller's behalf. Created only for
 * an Amazon listing (sourcePlatform: 'amazon') once its eBay order line is paid, and only when the seller has Auto Order
 * switched to 'full_auto' (models/schemas/User.js autoOrderMode) - never for a CJdropshipping or AliExpress listing, since
 * those have their own supplier APIs instead of a buyer-account browser extension.
 *
 * The seller decides which paid orders enter Auto Order at all - there is no automatic-on-payment creation. The Orders
 * page's own "Send to Auto Order" bulk action creates one of these per selected order (services/autoOrderService.js
 * queueSupplierOrder), always starting 'pending' (queued, not yet eligible for the extension - see
 * models/supplierOrdersModel.js claimNextReadyOrder, which only ever claims 'ready'). Nothing happens to a queued order
 * until the seller presses "Start Auto Order" (startPendingSupplierOrders), a one-shot promotion of every 'pending' order
 * to 'ready' at that moment - anything queued afterward needs its own Start.
 *
 * Status flow (services/autoOrderService.js / models/supplierOrdersModel.js hold every transition):
 *   pending (queued, waiting for Start) -> ready (eligible for the extension's poll) -> checking (the extension claimed
 *   it and is opening the Amazon page) -> placing (all of its own checks passed, about to click "Place your order") ->
 *   placed (done) | needs_attention (a known, human-fixable block: captcha, sign-in, price rose, out of stock, over a
 *   spending limit - the extension never retries these on its own) | failed (an unexpected error). 'cancelled' exists
 *   for completeness (the eBay order itself being cancelled before an Amazon order was placed) but nothing sets it yet.
 */
const supplierOrderSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    ebayAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'EbayAccount', default: null },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
    listingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Listing', default: null },

    ebayOrderId: { type: String, default: null },
    // The eBay listing's classic item ID (models/schemas/Order.js legacyItemId) - needed to find the order's line among
    // GetMyeBaySelling's results when writing the "Amazon order <id>" note (services/ebayOrderNoteService.js).
    legacyItemId: { type: String, default: null },
    // eBay's own line item ID. The unique index means one eBay line item can create at most one supplier order, even if
    // order sync (the poll job) and the eBay order notification (the webhook) both see the same paid order at once.
    ebayLineItemId: { type: String, required: true, unique: true },

    // Always 'amazon' today (models/schemas/Listing.js sourcePlatform) - kept as its own field, not inferred from the
    // listing, so a supplier order still says where it came from even if the listing is edited or removed later.
    sourcePlatform: { type: String, enum: ['amazon'], default: 'amazon' },
    asin: { type: String, default: null },
    // The exact product page the listing was imported from (models/schemas/Import.js amazonUrl) - the extension opens
    // this rather than guessing a "/dp/<asin>" URL, so it lands on the right Amazon site (amazon.com, .co.uk, .de, ...)
    // and the exact listing (a variant's own URL, a different seller) the price/import was actually taken from.
    amazonUrl: { type: String, default: null },
    variantDetails: { type: String, default: null },
    quantity: { type: Number, default: 1 },

    // The buyer's address, copied from the eBay order at creation time so the extension can fill Amazon's checkout
    // without a second lookup. Cleared (set to null) once the order reaches a state where it is no longer needed
    // (placed, failed, cancelled) - kept only for needs_attention, since that can still be retried.
    shippingAddress: {
      fullName: { type: String, default: null },
      addressLine1: { type: String, default: null },
      addressLine2: { type: String, default: null },
      city: { type: String, default: null },
      stateOrProvince: { type: String, default: null },
      postalCode: { type: String, default: null },
      country: { type: String, default: null },
      // Amazon requires a phone number to save a new address; eBay's buyer phone (Order.buyerPhone) is copied in
      // here alongside the rest of the address so the extension can add it on Amazon without a second lookup.
      phone: { type: String, default: null },
    },

    // The most this order may cost on Amazon: the listing's saved Amazon price plus the seller's allowed increase %
    // (models/schemas/User.js autoOrderMaxPriceIncreasePercent), capped by their flat autoOrderMaxCost when they set one.
    // null only when the listing had no saved Amazon price and the seller set no flat cap either (extremely unlikely;
    // the extension treats a null cap as "cannot verify the price is safe" and reports needs_attention).
    maxAllowedCost: { type: Number, default: null },

    status: {
      type: String,
      enum: ['pending', 'checking', 'ready', 'placing', 'placed', 'failed', 'needs_attention', 'cancelled'],
      default: 'pending',
      index: true,
    },

    amazonOrderId: { type: String, default: null },
    amazonTotal: { type: Number, default: null },
    // 'extension' (a real browser automating the seller's own logged-in Amazon session) is the only one built today.
    // 'amazon_business_api' is reserved for a future, officially-supported integration - never set by anything yet.
    fulfillmentMethod: { type: String, enum: ['extension', 'amazon_business_api'], default: 'extension' },

    error: { type: String, default: null },
    placedAt: { type: Date, default: null },
    creditCharged: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model('SupplierOrder', supplierOrderSchema);
