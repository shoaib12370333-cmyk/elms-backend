// jobs/stockMonitor.js checkAliexpressListing: the AliExpress counterpart of the CJ stock + price monitor. Ends a listing whose sku is
// out of stock on AliExpress, keeps the eBay quantity at AliExpress's real stock, reprices when the AliExpress price moved - and never
// reads "AliExpress did not say" as "out of stock", never touches Canopy/CJ, never compares prices quoted in different currencies.
const assert = require('assert');
const Module = require('module');
const { ACTION_COSTS } = require('../config/actionCosts');

const calls = { canopy: 0, aliexpress: [], spend: [], refund: [], withdraw: [], price: [], qty: [], ended: [], updates: [], converted: [], notifications: [] };
let adapterBehaviour = async () => ({});
let hasCredits = true;
let withdrawShouldBlock = false;
let listings = [];

const BLOCKED = 'eBay has blocked this listing from being created or revised, usually because of a policy or trademark (VeRO) issue.';
const blockedErr = () => Object.assign(new Error(BLOCKED), { ebayErrors: [{ errorId: 25019, message: 'Cannot revise listing.', parameters: [{ name: '2', value: 'SSR_BlockListing_ListingRevokedStatus' }] }] });
const { isAccountBlockedError } = require('../services/ebayListingService');

const fakes = {
  '../services/canopyAmazonService': { checkAvailabilityByAsin: async () => { calls.canopy += 1; return { inStock: true }; }, detectCountryFromUrl: () => 'US' },
  '../services/cjAdapter': { getProductDetail: async () => { throw new Error('CJ must never be called for an AliExpress listing'); }, calcFreight: async () => null },
  '../services/cjImportService': { destCountryFor: () => 'US' },
  '../services/aliexpressAdapter': { getProductDetail: async (userId, args) => { calls.aliexpress.push({ userId, ...args }); return adapterBehaviour(userId, args); } },
  '../services/ebayListingService': {
    withdrawListing: async (token, offerId) => { if (withdrawShouldBlock) throw blockedErr(); calls.withdraw.push([token, offerId]); },
    updateOfferPrice: async (token, offerId, price) => { calls.price.push([token, offerId, price]); },
    updateOfferQuantity: async (token, offerId, qty) => { calls.qty.push([token, offerId, qty]); },
    isAccountBlockedError,
  },
  '../models/listingsModel': {
    listPublishedListings: async () => listings,
    markEnded: async (userId, id, reason) => { calls.ended.push([id, reason]); },
    updateListing: async (userId, id, patch) => { calls.updates.push([id, patch]); },
  },
  '../models/importsModel': { updateImportPrice: async () => {} },
  '../models/ebayAccountsModel': { getEbayAccountRefreshToken: async () => 'token' },
  '../services/jobLockService': { acquireLock: async () => true },
  '../services/currencyService': { convertAmount: async (amount, from, to) => { calls.converted.push([amount, from, to]); return { amount: Number((amount * 0.8).toFixed(2)) }; } },
  '../models/usersModel': {
    spendCredit: async (userId, cost) => { calls.spend.push(cost); return hasCredits; },
    refundCredit: async (userId, cost) => { calls.refund.push(cost); },
    listUsersDueForStockCheck: async () => [],
    markStockCheckRan: async () => {},
  },
  '../models/systemNotificationsModel': { createSystemNotification: async (userId, data) => { calls.notifications.push(data); } },
  'node-cron': { schedule: () => {} },
};
const origLoad = Module._load;
Module._load = function (request, parent) {
  if (fakes[request] && parent && /jobs.stockMonitor\.js$/.test(parent.filename)) return fakes[request];
  return origLoad.apply(this, arguments);
};
const { runStockCheckForUser, aliexpressSkuStock, aliexpressSkuPrice } = require('../jobs/stockMonitor');
Module._load = origLoad;

const reset = () => {
  calls.canopy = 0;
  ['aliexpress', 'spend', 'refund', 'withdraw', 'price', 'qty', 'ended', 'updates', 'converted', 'notifications'].forEach((k) => { calls[k].length = 0; });
  adapterBehaviour = async () => ({});
  hasCredits = true;
  withdrawShouldBlock = false;
  listings = [];
};
const user = { id: 'u1', email: 'u@x.com' };
const aeListing = (id, extra) => ({
  id, sku: 'AE-' + id, source_platform: 'aliexpress', aliexpress_product_id: 'P' + id, aliexpress_sku_id: 'S' + id, status: 'published',
  ebay_offer_id: 'o' + id, ebay_account_id: 'a1', quantity: 1, amazon_in_stock: true, sell_price: 30, amazon_price: 20, currency: 'USD',
  marketplace_id: 'EBAY_US', repricing_enabled: true, ...extra,
});
/** What aliexpress.ds.product.get returns for one listing's product: the field names the import reads (services/aliexpressImportService.js). */
const detailFor = (id, skuFields) => ({
  ae_item_base_info_dto: { product_id: 'P' + id, currency_code: 'USD' },
  ae_item_sku_info_dtos: [{ sku_id: 'S' + id, sku_available_stock: 10, offer_sale_price: '20.00', sku_price: '25.00', currency_code: 'USD', ...skuFields }, { sku_id: 'OTHER', sku_available_stock: 0, offer_sale_price: '1.00' }],
});
const check = async (...ls) => { listings = ls; await runStockCheckForUser(user); };

(async () => {
  // ---------- the helpers: unknown is never 0 ----------
  assert.strictEqual(aliexpressSkuStock({ sku_available_stock: 7 }), 7);
  assert.strictEqual(aliexpressSkuStock({ sku_available_stock: '12' }), 12);
  assert.strictEqual(aliexpressSkuStock({ sku_available_stock: 0 }), 0, 'a real zero is a zero');
  assert.strictEqual(aliexpressSkuStock({}), null, 'AliExpress gave no figure: unknown, NOT 0 (0 would end a good listing)');
  assert.strictEqual(aliexpressSkuStock({ sku_available_stock: null }), null);
  assert.strictEqual(aliexpressSkuStock({ sku_available_stock: '' }), null);
  assert.strictEqual(aliexpressSkuStock({ sku_available_stock: 'lots' }), null);
  assert.strictEqual(aliexpressSkuStock({ sku_available_stock: false }), null, 'Number(false) is 0 - a boolean is not a stock figure');
  assert.strictEqual(aliexpressSkuStock({ sku_available_stock: ' ' }), null, 'Number(" ") is 0 - blank is not a stock figure');
  assert.strictEqual(aliexpressSkuStock({ sku_available_stock: [] }), null, 'Number([]) is 0');
  assert.strictEqual(aliexpressSkuStock({ sku_available_stock: ' 8 ' }), 8);
  assert.strictEqual(aliexpressSkuStock({ sku_available_stock: NaN }), null);
  assert.strictEqual(aliexpressSkuPrice({ offer_sale_price: '19.99', sku_price: '25' }), 19.99, 'the sale price wins');
  assert.strictEqual(aliexpressSkuPrice({ sku_price: '25' }), 25, 'else the list price');
  assert.strictEqual(aliexpressSkuPrice({ offer_sale_price: '0', sku_price: '25' }), 25, 'a 0 sale price is not a price');
  assert.strictEqual(aliexpressSkuPrice({}), null);

  // ---------- it has its own credit key and calls only the AliExpress adapter (never Canopy / CJ), for the store's own country and the listing's currency ----------
  reset();
  adapterBehaviour = async () => detailFor('1', {});
  await check(aeListing('1', { marketplace_id: 'EBAY_GB', currency: 'GBP' }));
  assert.ok(Number.isFinite(ACTION_COSTS.ALIEXPRESS_STOCK_MONITORING), 'the credit key exists');
  assert.deepStrictEqual(calls.spend, [ACTION_COSTS.ALIEXPRESS_STOCK_MONITORING]);
  assert.strictEqual(calls.canopy, 0);
  assert.deepStrictEqual(calls.aliexpress, [{ userId: 'u1', productId: 'P1', shipToCountry: 'GB', targetCurrency: 'GBP' }]);

  // ---------- out of stock on AliExpress: the eBay offer is withdrawn and the listing is ended (and not price-checked) ----------
  reset();
  adapterBehaviour = async () => detailFor('1', { sku_available_stock: 0 });
  await check(aeListing('1'));
  assert.deepStrictEqual(calls.withdraw, [['token', 'o1']]);
  assert.deepStrictEqual(calls.ended, [['1', 'Ended: out of stock on AliExpress']]);
  assert.strictEqual(calls.price.length, 0, 'an ended listing is not repriced');
  assert.ok(calls.updates.some(([, p]) => p.amazonInStock === false));

  // ---------- only THIS listing's sku counts: another sku of the same product being at 0 changes nothing ----------
  reset();
  adapterBehaviour = async () => detailFor('1', { sku_available_stock: 4 });
  await check(aeListing('1'));
  assert.strictEqual(calls.withdraw.length, 0);

  // ---------- stock monitoring off for this product: not ended even at 0 (and the price is still followed) ----------
  reset();
  adapterBehaviour = async () => detailFor('1', { sku_available_stock: 0, offer_sale_price: '25.00' });
  await check(aeListing('1', { stock_monitoring: false }));
  assert.strictEqual(calls.withdraw.length, 0);
  assert.strictEqual(calls.ended.length, 0);
  assert.strictEqual(calls.qty.length, 0, 'the quantity is not synced either');
  assert.strictEqual(calls.price.length, 1, 'price monitoring is its own switch');

  // ---------- AliExpress gave NO stock figure: left alone, never ended ----------
  reset();
  adapterBehaviour = async () => { const d = detailFor('1', {}); delete d.ae_item_sku_info_dtos[0].sku_available_stock; return d; };
  await check(aeListing('1'));
  assert.strictEqual(calls.withdraw.length, 0);
  assert.strictEqual(calls.ended.length, 0);
  assert.strictEqual(calls.qty.length, 0);
  assert.strictEqual(calls.refund.length, 0, 'it still gave a price, so the check was worth its credit');

  // ---------- AliExpress no longer lists the sku: left alone, and not charged (nothing was learned) ----------
  reset();
  adapterBehaviour = async () => ({ ae_item_base_info_dto: {}, ae_item_sku_info_dtos: [{ sku_id: 'SOMETHING-ELSE', sku_available_stock: 5 }] });
  await check(aeListing('1'));
  assert.strictEqual(calls.withdraw.length, 0);
  assert.strictEqual(calls.ended.length, 0);
  assert.strictEqual(calls.price.length + calls.qty.length, 0);
  assert.strictEqual(calls.refund.length, 1, 'a check that learned nothing is not charged');

  // ---------- two skus read as the same id (large ids can collide): the first one's stock must not decide - left alone, not charged ----------
  reset();
  adapterBehaviour = async () => ({ ae_item_base_info_dto: {}, ae_item_sku_info_dtos: [{ sku_id: 'S1', sku_available_stock: 0, offer_sale_price: '20.00' }, { sku_id: 'S1', sku_available_stock: 9, offer_sale_price: '20.00' }] });
  await check(aeListing('1'));
  assert.strictEqual(calls.withdraw.length + calls.ended.length, 0, 'never ended on the strength of an ambiguous match');
  assert.strictEqual(calls.qty.length + calls.price.length, 0);
  assert.strictEqual(calls.refund.length, 1);

  // ---------- neither a stock figure nor a price (a wrong field name would look like this for EVERY listing): left alone, not charged ----------
  reset();
  adapterBehaviour = async () => ({ ae_item_base_info_dto: {}, ae_item_sku_info_dtos: [{ sku_id: 'S1' }] });
  await check(aeListing('1'));
  assert.strictEqual(calls.ended.length + calls.qty.length + calls.price.length, 0);
  assert.strictEqual(calls.refund.length, 1);

  // ---------- in stock: the eBay quantity follows AliExpress's real stock, capped at 999, and is not rewritten when already in sync ----------
  reset();
  adapterBehaviour = async () => detailFor('1', { sku_available_stock: 5 });
  await check(aeListing('1', { amazon_price: 20, sell_price: 30 }));
  assert.deepStrictEqual(calls.qty, [['token', 'o1', 5]]);
  assert.ok(calls.updates.some(([, p]) => p.quantity === 5 && p.amazonInStock === true));
  reset();
  adapterBehaviour = async () => detailFor('1', { sku_available_stock: 50000 });
  await check(aeListing('1'));
  assert.deepStrictEqual(calls.qty, [['token', 'o1', 999]], 'a warehouse count in the tens of thousands is never sent to eBay as it is');
  reset();
  adapterBehaviour = async () => detailFor('1', { sku_available_stock: 5 });
  await check(aeListing('1', { quantity: 5, amazon_in_stock: true }));
  assert.strictEqual(calls.qty.length, 0, 'already 5 on eBay: no needless revision');

  // ---------- the AliExpress price moved 20 -> 25: the seller's cash margin (30 - 20 = 10) is kept, so eBay goes 30 -> 35 ----------
  reset();
  adapterBehaviour = async () => detailFor('1', { offer_sale_price: '25.00', sku_available_stock: 10 });
  await check(aeListing('1', { quantity: 10 }));
  assert.deepStrictEqual(calls.price, [['token', 'o1', 35]]);
  const repriced = calls.updates.find(([, p]) => p.sellPrice !== undefined)[1];
  assert.strictEqual(repriced.sellPrice, 35);
  assert.strictEqual(repriced.amazonPrice, 25);
  assert.strictEqual(repriced.marginAmount, 10);
  assert.strictEqual(calls.converted.length, 0, 'USD listing on a USD store: nothing to convert');

  // ...from the list price when AliExpress has no sale price
  reset();
  adapterBehaviour = async () => detailFor('1', { offer_sale_price: undefined, sku_price: '22.00', sku_available_stock: 10 });
  await check(aeListing('1', { quantity: 10 }));
  assert.deepStrictEqual(calls.price, [['token', 'o1', 32]]);

  // ---------- a USD listing on a GBP store: the new eBay price is converted to the store's currency ----------
  reset();
  adapterBehaviour = async () => detailFor('1', { offer_sale_price: '25.00', sku_available_stock: 10 });
  await check(aeListing('1', { quantity: 10, marketplace_id: 'EBAY_GB' }));
  assert.deepStrictEqual(calls.converted, [[35, 'USD', 'GBP']]);
  assert.deepStrictEqual(calls.price, [['token', 'o1', 28]]);
  assert.strictEqual(calls.updates.find(([, p]) => p.sellPrice !== undefined)[1].sellPrice, 35, 'the listing keeps its own-currency price');

  // ---------- price unchanged: nothing is written to eBay ----------
  reset();
  adapterBehaviour = async () => detailFor('1', { offer_sale_price: '20.00', sku_available_stock: 10 });
  await check(aeListing('1', { quantity: 10 }));
  assert.strictEqual(calls.price.length, 0);

  // ---------- AliExpress quoted another currency than the listing's baseline: never compared, nothing changes ----------
  reset();
  adapterBehaviour = async () => detailFor('1', { offer_sale_price: '25.00', currency_code: 'EUR', sku_available_stock: 10 });
  await check(aeListing('1', { quantity: 10 }));
  assert.strictEqual(calls.price.length, 0, '25 EUR is not 25 USD');
  assert.ok(!calls.updates.some(([, p]) => p.amazonPrice !== undefined), 'and the baseline is not overwritten with it');

  // ---------- repricing switched off for this listing: the new source price is recorded, eBay is not touched ----------
  reset();
  adapterBehaviour = async () => detailFor('1', { offer_sale_price: '25.00', sku_available_stock: 10 });
  await check(aeListing('1', { quantity: 10, repricing_enabled: false }));
  assert.strictEqual(calls.price.length, 0);
  assert.ok(calls.updates.some(([, p]) => p.amazonPrice === 25));

  // ---------- no baseline yet: it is established (and the margin kept) rather than repricing blindly ----------
  reset();
  adapterBehaviour = async () => detailFor('1', { offer_sale_price: '25.00', sku_available_stock: 10 });
  await check(aeListing('1', { quantity: 10, amazon_price: null, margin_amount: null }));
  assert.strictEqual(calls.price.length, 0);
  assert.ok(calls.updates.some(([, p]) => p.amazonPrice === 25));

  // ---------- both switches off: skipped entirely, no credit spent, no AliExpress call ----------
  reset();
  await check(aeListing('1', { stock_monitoring: false, price_monitoring: false }));
  assert.strictEqual(calls.spend.length, 0);
  assert.strictEqual(calls.aliexpress.length, 0);

  // ---------- a listing without its AliExpress ids is skipped without charging ----------
  reset();
  await check(aeListing('1', { aliexpress_sku_id: null }));
  assert.strictEqual(calls.spend.length, 0);
  assert.strictEqual(calls.aliexpress.length, 0);

  // ---------- out of credits: stops this user's remaining listings ----------
  reset();
  hasCredits = false;
  await check(aeListing('1'), aeListing('2'));
  assert.strictEqual(calls.spend.length, 1, 'stopped after the first refusal');
  assert.strictEqual(calls.aliexpress.length, 0);

  // ---------- an AliExpress failure refunds the credit and leaves the listing alone; the run goes on to the next listing ----------
  reset();
  adapterBehaviour = async (userId, { productId }) => { if (productId === 'P1') throw new Error('AliExpress is not connected for this account.'); return detailFor('2', { sku_available_stock: 5 }); };
  await check(aeListing('1'), aeListing('2'));
  assert.deepStrictEqual(calls.refund, [ACTION_COSTS.ALIEXPRESS_STOCK_MONITORING], 'the failed check is not charged');
  assert.strictEqual(calls.ended.length, 0);
  assert.deepStrictEqual(calls.qty, [['token', 'o2', 5]], 'the second listing was still checked');

  // ---------- 3 failures in a row (a dead token, AliExpress down): the rest are left for the next run, not each charged and refunded ----------
  reset();
  adapterBehaviour = async () => { throw new Error('AliExpress said no.'); };
  await check(aeListing('1'), aeListing('2'), aeListing('3'), aeListing('4'), aeListing('5'));
  assert.strictEqual(calls.aliexpress.length, 3, 'AliExpress is asked 3 times, then given up on for this run');
  assert.strictEqual(calls.spend.length, 3);
  assert.strictEqual(calls.refund.length, 3);
  assert.deepStrictEqual(calls.notifications.map((x) => x.type), ['aliexpress_unavailable'], 'the seller is told monitoring paused - not left with silence');
  assert.strictEqual(calls.notifications[0].level, 'warning');

  // ...two failures are not enough to say anything
  reset();
  adapterBehaviour = async () => { throw new Error('AliExpress said no.'); };
  await check(aeListing('1'), aeListing('2'));
  assert.strictEqual(calls.notifications.length, 0);

  // ---------- products AliExpress no longer has: not an outage (no cap, every listing is still checked), not ended on a guess - the seller is told once ----------
  reset();
  adapterBehaviour = async () => { throw Object.assign(new Error('AliExpress does not have that product.'), { statusCode: 404, productMissing: true }); };
  await check(...['1', '2', '3', '4', '5', '6', '7'].map((i) => aeListing(i)));
  assert.strictEqual(calls.aliexpress.length, 7, 'missing products do not count toward giving up on AliExpress');
  assert.strictEqual(calls.refund.length, 7);
  assert.strictEqual(calls.ended.length + calls.withdraw.length, 0);
  assert.strictEqual(calls.notifications.length, 1);
  assert.strictEqual(calls.notifications[0].type, 'aliexpress_product_missing');
  assert.match(calls.notifications[0].message, /7 product/);
  assert.match(calls.notifications[0].message, /AE-1, AE-2, AE-3, AE-4, AE-5 and 2 more/);

  // ...and three of them in a row do not stop a healthy listing behind them
  reset();
  adapterBehaviour = async (userId, { productId }) => { if (['P1', 'P2', 'P3'].includes(productId)) throw Object.assign(new Error('AliExpress does not have that product.'), { productMissing: true }); return detailFor('4', { sku_available_stock: 5 }); };
  await check(aeListing('1'), aeListing('2'), aeListing('3'), aeListing('4'));
  assert.deepStrictEqual(calls.qty, [['token', 'o4', 5]]);

  // ...but a success in between resets the count (flaky is not dead)
  reset();
  let n = 0;
  adapterBehaviour = async (userId, { productId }) => { n += 1; if (n === 3) return detailFor('3', { sku_available_stock: 5 }); throw new Error('flaky'); };
  await check(aeListing('1'), aeListing('2'), aeListing('3'), aeListing('4'), aeListing('5'), aeListing('6'));
  assert.strictEqual(calls.aliexpress.length, 6, 'a good answer in the middle keeps the run going');

  // ---------- eBay refusing to withdraw (account blocked): the listing is NOT marked ended (eBay would still be selling it), and the seller is told once ----------
  reset();
  withdrawShouldBlock = true;
  adapterBehaviour = async (userId, { productId }) => detailFor(productId.slice(1), { sku_available_stock: 0 });
  await check(aeListing('1'), aeListing('2'));
  assert.strictEqual(calls.ended.length, 0);
  assert.strictEqual(calls.notifications.length, 1, 'one account-wide notice per run, not one per listing');
  assert.strictEqual(calls.notifications[0].type, 'ebay_account_blocked');

  // ---------- an ended-never-published listing (no eBay offer): marked ended here without an eBay call ----------
  reset();
  adapterBehaviour = async () => detailFor('1', { sku_available_stock: 0 });
  await check(aeListing('1', { ebay_offer_id: null }));
  assert.strictEqual(calls.withdraw.length, 0);
  assert.deepStrictEqual(calls.ended, [['1', 'Ended: out of stock on AliExpress']]);

  // ---------- a mixed run: Amazon / CJ / AliExpress listings each go through their own branch ----------
  reset();
  adapterBehaviour = async () => detailFor('1', { sku_available_stock: 5 });
  await check(aeListing('1'), { id: 'z', sku: 'NOASIN', status: 'published', source_platform: 'amazon' });
  assert.strictEqual(calls.aliexpress.length, 1, 'an Amazon listing is never sent to AliExpress');

  console.log('aliexpress stock monitor tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
