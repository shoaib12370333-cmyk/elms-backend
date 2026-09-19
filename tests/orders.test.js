const assert = require('assert');
const { normalizeOrderLineItems } = require('../services/ebayOrdersService');
const { deriveOrderStatus } = require('../models/ordersModel');

const raw = {
  orderId: '12-34567-89012',
  creationDate: '2026-09-10T08:00:00.000Z',
  lastModifiedDate: '2026-09-11T09:00:00.000Z',
  orderFulfillmentStatus: 'NOT_STARTED',
  orderPaymentStatus: 'PAID',
  cancelStatus: { cancelState: 'NONE_REQUESTED' },
  buyer: { username: 'buyer1' },
  buyerCheckoutNotes: 'Please hurry',
  salesRecordReference: '4321',
  pricingSummary: { total: { value: '61.90', currency: 'AUD' } },
  paymentSummary: { payments: [{ paymentDate: '2026-09-10T08:05:00.000Z' }] },
  fulfillmentStartInstructions: [{ shippingStep: { shippingServiceCode: 'AU_Regular', shipTo: { fullName: 'Jane Doe', email: 'j@x.com', primaryPhone: { phoneNumber: '0400' }, contactAddress: { addressLine1: '1 Main St', city: 'Sydney', stateOrProvince: 'NSW', postalCode: '2000', countryCode: 'AU' } } } }],
  lineItems: [
    { lineItemId: '100', legacyItemId: '147497200884', sku: 'B0CNGTW249', title: 'Dog Bed', quantity: 2, lineItemCost: { value: '25.00', currency: 'AUD' }, total: { value: '61.90' }, deliveryCost: { shippingCost: { value: '9.90' } }, lineItemFulfillmentStatus: 'NOT_STARTED', purchaseMarketplaceId: 'EBAY_AU', lineItemFulfillmentInstructions: { shipByDate: '2026-09-12T00:00:00.000Z', minEstimatedDeliveryDate: '2026-09-15T00:00:00.000Z' } },
    { lineItemId: '101', legacyItemId: '999', title: 'Not from ELMS', quantity: 1, lineItemCost: { value: '5.00', currency: 'AUD' } },
  ],
};

const rows = normalizeOrderLineItems(raw);
assert.strictEqual(rows.length, 2, 'every line item is kept');
assert.strictEqual(rows[0].sku, 'B0CNGTW249');
assert.strictEqual(rows[0].salePrice, 25);
assert.strictEqual(rows[0].deliveryCost, 9.9);
assert.strictEqual(rows[0].orderTotal, 61.9);
assert.strictEqual(rows[0].buyerEmail, 'j@x.com');
assert.strictEqual(rows[0].shippingService, 'AU_Regular');
assert.ok(rows[0].shipByDate instanceof Date && rows[0].paidAt instanceof Date);
assert.strictEqual(rows[1].sku, 'EBAY-999', 'lines without a SKU get a stable placeholder key');
assert.notStrictEqual(rows[0].sku, rows[1].sku);

const base = { ebayPaymentStatus: 'PAID', ebayCancelStatus: 'NONE_REQUESTED', fulfillmentStatus: 'pending', ebayOrderFulfillmentStatus: 'NOT_STARTED', lineItemStatus: 'NOT_STARTED' };
assert.strictEqual(deriveOrderStatus(base), 'awaiting_shipment');
assert.strictEqual(deriveOrderStatus({ ...base, ebayPaymentStatus: 'PENDING' }), 'awaiting_payment');
assert.strictEqual(deriveOrderStatus({ ...base, fulfillmentStatus: 'shipped' }), 'shipped');
assert.strictEqual(deriveOrderStatus({ ...base, lineItemStatus: 'FULFILLED' }), 'shipped');
assert.strictEqual(deriveOrderStatus({ ...base, fulfillmentStatus: 'delivered' }), 'delivered');
assert.strictEqual(deriveOrderStatus({ ...base, ebayCancelStatus: 'CANCELED' }), 'cancelled');
console.log('orders tests passed');
