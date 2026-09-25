const axios = require('axios');
const { getAccessToken } = require('./ebayAuthService');
const { EBAY_API_BASE_URL } = require('../config/ebayEnvironment');
const { record, markExhausted, isLimitFailure } = require('./ebayCallBudget');

// eBay Trading API site IDs per marketplace.
const SITE_IDS = Object.freeze({
  EBAY_US: 0, EBAY_CA: 2, EBAY_GB: 3, EBAY_AU: 15, EBAY_AT: 16, EBAY_FR: 71, EBAY_DE: 77,
  EBAY_BE: 23, EBAY_IT: 101, EBAY_NL: 146, EBAY_ES: 186, EBAY_CH: 193, EBAY_HK: 201, EBAY_IE: 205,
  EBAY_MY: 207, EBAY_PH: 211, EBAY_PL: 212, EBAY_SG: 216,
});

function pickNumber(xml, tag) {
  // String.raw keeps the backslashes; a plain template literal would turn \s and \d into "s" and "d".
  const m = String(xml).match(new RegExp(String.raw`<${tag}>\s*(\d+)\s*</${tag}>`));
  return m ? Number(m[1]) : null;
}

/**
 * Reads a live listing's traffic from eBay: watchers (WatchCount) and page
 * views (HitCount) via the Trading API GetItem call, using the seller's own
 * OAuth token. HitCount is null when eBay does not return it for the item.
 * This is one eBay call per listing: for many listings use fetchActiveListingStats (200 listings per call).
 * `counted` says the caller already took this call from the daily budget; a one-off read (the button on one listing) is just counted here.
 *
 * @returns {Promise<{ views: number|null, watchers: number|null }>}
 */
async function fetchItemTraffic(refreshToken, itemId, marketplaceId, { counted = false } = {}) {
  const accessToken = await getAccessToken(refreshToken);
  if (!counted) record('core');
  const body = `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ItemID>${String(itemId).replace(/[^0-9]/g, '')}</ItemID>
  <IncludeWatchCount>true</IncludeWatchCount>
  <OutputSelector>WatchCount</OutputSelector>
  <OutputSelector>HitCount</OutputSelector>
  <OutputSelector>ListingStatus</OutputSelector>
</GetItemRequest>`;

  let response;
  try {
    response = await axios.post(`${EBAY_API_BASE_URL}/ws/api.dll`, body, {
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
  } catch (err) {
    const wrapped = new Error('Could not reach eBay to read listing traffic.');
    wrapped.statusCode = 502;
    throw wrapped;
  }

  const xml = String(response.data || '');
  throwIfFailure(xml, 'eBay rejected the traffic request.');
  return { watchers: pickNumber(xml, 'WatchCount') ?? 0, views: pickNumber(xml, 'HitCount') };
}

/** Throws when eBay answered "Failure"; an answer that says the daily call limit is used up also stops today's stats reads. */
function throwIfFailure(xml, fallbackMessage) {
  if (!/<Ack>\s*Failure\s*<\/Ack>/i.test(xml)) return;
  const msg = (xml.match(/<LongMessage>([\s\S]*?)<\/LongMessage>/) || xml.match(/<ShortMessage>([\s\S]*?)<\/ShortMessage>/) || [])[1];
  const code = (xml.match(/<ErrorCode>\s*(\d+)\s*<\/ErrorCode>/) || [])[1];
  const limitReached = isLimitFailure(code, msg);
  if (limitReached) markExhausted();
  const wrapped = new Error(msg ? msg.trim() : fallbackMessage);
  wrapped.statusCode = 502;
  wrapped.limitReached = limitReached;
  throw wrapped;
}

/**
 * Reads what a GetMyeBaySelling ActiveList answer says about each live listing: watchers (WatchCount, missing = 0) and, when
 * eBay includes it, page views (HitCount, otherwise null). Also how many pages of 200 the seller has in total.
 * @returns {{ items: Array<{ itemId: string, watchers: number, views: number|null }>, totalPages: number }}
 */
function parseActiveListStats(xml) {
  const items = [];
  const re = /<Item>([\s\S]*?)<\/Item>/g;
  let m;
  while ((m = re.exec(String(xml || '')))) {
    const block = m[1];
    const id = (block.match(/<ItemID>\s*(\d+)\s*<\/ItemID>/) || [])[1];
    if (!id) continue;
    items.push({ itemId: id, watchers: pickNumber(block, 'WatchCount') ?? 0, views: pickNumber(block, 'HitCount') });
  }
  return { items, totalPages: pickNumber(xml, 'TotalNumberOfPages') || 1 };
}

/**
 * One eBay call for up to 200 of a seller's live listings (Trading API GetMyeBaySelling, ActiveList): the way to read watchers
 * for a whole store. Reading them one listing at a time (GetItem) would spend eBay's daily allowance 200 times faster.
 * The caller takes the call from the daily budget first (services/ebayCallBudget.js).
 *
 * @returns {Promise<{ items: Array<{ itemId: string, watchers: number, views: number|null }>, totalPages: number }>}
 */
async function fetchActiveListingStats(refreshToken, marketplaceId, page = 1) {
  const accessToken = await getAccessToken(refreshToken);
  const body = `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ActiveList>
    <Include>true</Include>
    <Pagination><EntriesPerPage>200</EntriesPerPage><PageNumber>${Math.max(1, Math.trunc(Number(page)) || 1)}</PageNumber></Pagination>
  </ActiveList>
  <OutputSelector>ActiveList.ItemArray.Item.ItemID</OutputSelector>
  <OutputSelector>ActiveList.ItemArray.Item.WatchCount</OutputSelector>
  <OutputSelector>ActiveList.ItemArray.Item.HitCount</OutputSelector>
  <OutputSelector>ActiveList.PaginationResult</OutputSelector>
</GetMyeBaySellingRequest>`;

  let response;
  try {
    response = await axios.post(`${EBAY_API_BASE_URL}/ws/api.dll`, body, {
      headers: {
        'Content-Type': 'text/xml',
        'X-EBAY-API-CALL-NAME': 'GetMyeBaySelling',
        'X-EBAY-API-COMPATIBILITY-LEVEL': '1193',
        'X-EBAY-API-SITEID': String(SITE_IDS[marketplaceId] ?? 0),
        'X-EBAY-API-IAF-TOKEN': accessToken,
      },
      timeout: 30000,
      responseType: 'text',
      transformResponse: (r) => r,
    });
  } catch (err) {
    const wrapped = new Error('Could not reach eBay to read listing traffic.');
    wrapped.statusCode = 502;
    throw wrapped;
  }
  const xml = String(response.data || '');
  throwIfFailure(xml, 'eBay rejected the listing traffic request.');
  return parseActiveListStats(xml);
}

module.exports = { fetchItemTraffic, fetchActiveListingStats, parseActiveListStats, pickNumber, SITE_IDS };
