const axios = require('axios');
const { getAccessToken } = require('./ebayAuthService');
const { EBAY_API_BASE_URL } = require('../config/ebayEnvironment');
const { SITE_IDS } = require('./ebayStatsService');
const Order = require('../models/schemas/Order');
const { listEbayAccounts, getEbayAccountRefreshToken } = require('../models/ebayAccountsModel');

// eBay's order API (Fulfillment) does not include the item's picture, so it is read from the item itself.
const RECHECK_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // an item without a picture (ended, removed) is not asked about every sync
const ITEMS_PER_RUN = 25;
const BACKFILL_EVERY_MS = 10 * 60 * 1000;

/** The first picture in a Trading API GetItem answer, as an https address, or null. */
function parseItemImage(xml) {
  const m = String(xml || '').match(/<PictureURL>\s*([^<\s]+)\s*<\/PictureURL>/);
  if (!m) return null;
  const url = m[1].replace(/&amp;/g, '&');
  return /^https?:\/\//i.test(url) ? url.replace(/^http:\/\//i, 'https://') : null;
}

/** Reads one item's first picture with the seller's own token. Returns null when eBay has none for it (never throws). */
async function fetchItemImage(refreshToken, legacyItemId, marketplaceId) {
  try {
    const accessToken = await getAccessToken(refreshToken);
    const body = `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ItemID>${String(legacyItemId).replace(/[^0-9]/g, '')}</ItemID>
  <OutputSelector>PictureDetails</OutputSelector>
</GetItemRequest>`;
    const response = await axios.post(`${EBAY_API_BASE_URL}/ws/api.dll`, body, {
      headers: {
        'Content-Type': 'text/xml',
        'X-EBAY-API-CALL-NAME': 'GetItem',
        'X-EBAY-API-COMPATIBILITY-LEVEL': '1193',
        'X-EBAY-API-SITEID': String(SITE_IDS[marketplaceId] ?? 0),
        'X-EBAY-API-IAF-TOKEN': accessToken,
      },
      timeout: 15000,
      responseType: 'text',
      transformResponse: (r) => r,
    });
    return parseItemImage(response.data);
  } catch (err) {
    return null;
  }
}

/**
 * Gives orders that have no picture the item's picture from eBay. At most ITEMS_PER_RUN different items per call
 * (older orders fill in over the next runs), and an item eBay has no picture for is not asked again for a week.
 * `legacyItemIds` limits it to those items and `force` asks again even if eBay was asked recently (used when a single order is refreshed).
 * @returns {Promise<number>} how many items got a picture
 */
async function fillMissingOrderImages(userId, accountId, refreshToken, { legacyItemIds = null, limit = ITEMS_PER_RUN, force = false } = {}) {
  const filter = { userId, ebayAccountId: accountId, itemImage: null, legacyItemId: { $ne: null } };
  if (!force) filter.$or = [{ itemImageCheckedAt: null }, { itemImageCheckedAt: { $lt: new Date(Date.now() - RECHECK_AFTER_MS) } }];
  if (legacyItemIds) filter.legacyItemId = { $in: legacyItemIds };
  const rows = await Order.find(filter).select('legacyItemId marketplaceId').limit(500).lean();
  const items = new Map();
  for (const r of rows) if (!items.has(r.legacyItemId)) items.set(r.legacyItemId, r.marketplaceId);

  let filled = 0;
  for (const [legacyItemId, marketplaceId] of [...items].slice(0, limit)) {
    const image = await fetchItemImage(refreshToken, legacyItemId, marketplaceId);
    const set = { itemImageCheckedAt: new Date() };
    if (image) { set.itemImage = image; filled += 1; }
    await Order.updateMany({ userId, ebayAccountId: accountId, legacyItemId, itemImage: null }, { $set: set });
  }
  return filled;
}

const lastBackfill = new Map(); // userId -> when it last ran
/** For every connected store of the user, in the background and at most every 10 minutes: fills in missing order pictures. */
function backfillOrderImagesForUser(userId) {
  const key = String(userId);
  if (Date.now() - (lastBackfill.get(key) || 0) < BACKFILL_EVERY_MS) return;
  lastBackfill.set(key, Date.now());
  (async () => {
    const accounts = await listEbayAccounts(userId);
    for (const account of accounts) {
      const accountId = account.id || account._id;
      const refreshToken = await getEbayAccountRefreshToken(userId, accountId);
      if (refreshToken) await fillMissingOrderImages(userId, accountId, refreshToken, { limit: 100 });
    }
  })().catch((err) => console.warn('[order-images] ' + err.message));
}

module.exports = { parseItemImage, fetchItemImage, fillMissingOrderImages, backfillOrderImagesForUser };
