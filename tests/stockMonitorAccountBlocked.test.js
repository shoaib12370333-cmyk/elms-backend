// jobs/stockMonitor.js: when eBay has blocked the WHOLE account (SSR_BlockListing_ListingRevokedStatus) from any
// listing create/revise, every published listing's price/stock write fails the same way - this must notify the
// seller once per run (services/ebayListingService.js isAccountBlockedError), not just log it where only the
// server ever sees it (compare services/publishQueueService.js's own publish_failed notice for a manual publish).
const assert = require('assert');
const Module = require('module');
const { isAccountBlockedError } = require('../services/ebayListingService');

const notifications = [];
let withdrawShouldBlock = false;
let priceShouldBlock = false;
let qtyShouldThrowOther = false;
let stockResponse = { inStock: true, availabilityText: 'In Stock', price: 25, currency: 'USD' };

const BLOCKED_MESSAGE = 'eBay has blocked this listing from being created or revised, usually because of a policy or trademark (VeRO) issue. Check your eBay Messages for the exact reason, then try again.';
const blockedErr = () => Object.assign(new Error(BLOCKED_MESSAGE), {
  ebayErrors: [{ errorId: 25019, message: 'Cannot revise listing.', parameters: [{ name: '2', value: 'SSR_BlockListing_ListingRevokedStatus' }] }],
});

let listings = [];
let cjDetail = null;

const fakes = {
  '../services/canopyAmazonService': {
    checkAvailabilityByAsin: async () => stockResponse,
    detectCountryFromUrl: () => 'US',
  },
  '../services/ebayListingService': {
    withdrawListing: async () => { if (withdrawShouldBlock) throw blockedErr(); },
    updateOfferPrice: async () => { if (priceShouldBlock) throw blockedErr(); },
    updateOfferQuantity: async () => { if (qtyShouldThrowOther) throw new Error('Network timeout'); },
    isAccountBlockedError,
  },
  '../models/listingsModel': {
    listPublishedListings: async () => listings,
    markEnded: async () => {},
    updateListing: async () => {},
  },
  '../models/importsModel': { updateImportPrice: async () => {} },
  '../models/ebayAccountsModel': { getEbayAccountRefreshToken: async () => 'token' },
  '../services/jobLockService': { acquireLock: async () => true },
  '../services/currencyService': { convertAmount: async (amount, from, to) => ({ amount, from, to }) },
  '../models/usersModel': { spendCredit: async () => true, refundCredit: async () => {}, listUsersDueForStockCheck: async () => [], markStockCheckRan: async () => {} },
  '../models/systemNotificationsModel': { createSystemNotification: async (userId, data) => { notifications.push({ userId, ...data }); } },
  '../services/cjAdapter': {
    getProductDetail: async () => cjDetail,
    calcFreight: async () => ({ cost: 0 }),
  },
  '../services/cjImportService': { destCountryFor: () => 'US' },
  'node-cron': { schedule: () => {} },
};
const origLoad = Module._load;
Module._load = function (request, parent) {
  if (fakes[request] && parent && /jobs.stockMonitor\.js$/.test(parent.filename)) return fakes[request];
  return origLoad.apply(this, arguments);
};
const { runStockCheckForUser } = require('../jobs/stockMonitor');
Module._load = origLoad;

const listing = (id, extra) => ({
  id, sku: 'SKU-' + id, asin: 'B0TEST000' + id, status: 'published', ebay_offer_id: 'o' + id, ebay_account_id: 'a1',
  quantity: 1, amazon_in_stock: true, sell_price: 30, amazon_price: 20, currency: 'USD', marketplace_id: 'EBAY_US',
  repricing_enabled: true, ...extra,
});
const cjListing = (id, extra) => ({
  id, sku: 'CJ-' + id, source_platform: 'cj', cj_product_id: 'p1', cj_variant_id: 'v1', status: 'published',
  ebay_offer_id: 'o' + id, ebay_account_id: 'a1', quantity: 1, marketplace_id: 'EBAY_US', ...extra,
});

(async () => {
  // Two listings both fail the SAME account-wide block during price sync: only one notice for the whole run.
  notifications.length = 0;
  priceShouldBlock = true;
  listings = [listing('1'), listing('2')];
  await runStockCheckForUser({ id: 'u1', email: 'u@x.com' });
  assert.strictEqual(notifications.length, 1, 'one account-wide notice per run, not one per listing');
  assert.strictEqual(notifications[0].userId, 'u1');
  assert.strictEqual(notifications[0].type, 'ebay_account_blocked');
  assert.strictEqual(notifications[0].level, 'error');
  assert.match(notifications[0].message, /VeRO/);
  priceShouldBlock = false;

  // An ordinary (non-account-wide) failure is never escalated to this notice.
  notifications.length = 0;
  qtyShouldThrowOther = true;
  listings = [listing('3')];
  await runStockCheckForUser({ id: 'u1', email: 'u@x.com' });
  assert.strictEqual(notifications.length, 0, 'a routine per-listing failure stays a server log, not a seller-facing notice');
  qtyShouldThrowOther = false;

  // The withdraw path (ending a listing whose Amazon product went out of stock) recognizes it too.
  notifications.length = 0;
  withdrawShouldBlock = true;
  stockResponse = { inStock: false, availabilityText: 'Currently unavailable' };
  listings = [listing('4')];
  await runStockCheckForUser({ id: 'u1', email: 'u@x.com' });
  assert.strictEqual(notifications.length, 1, 'a blocked withdraw is reported too');
  withdrawShouldBlock = false;
  stockResponse = { inStock: true, availabilityText: 'In Stock', price: 25, currency: 'USD' };

  // The CJ-sourced path shares the exact same notifier and per-run state.
  notifications.length = 0;
  withdrawShouldBlock = true;
  cjDetail = { variants: [{ vid: 'v1', inventories: [] }] }; // no inventory anywhere -> CJ is out of stock -> withdraw is attempted
  listings = [cjListing('5')];
  await runStockCheckForUser({ id: 'u1', email: 'u@x.com' });
  assert.strictEqual(notifications.length, 1, 'the CJ-sourced path notifies through the same mechanism');
  withdrawShouldBlock = false;

  console.log('stock monitor account-blocked tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
