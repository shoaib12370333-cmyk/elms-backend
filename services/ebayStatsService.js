const axios = require('axios');
const { getAccessToken } = require('./ebayAuthService');
const { EBAY_API_BASE_URL } = require('../config/ebayEnvironment');

// eBay Trading API site IDs per marketplace.
const SITE_IDS = Object.freeze({
  EBAY_US: 0, EBAY_CA: 2, EBAY_GB: 3, EBAY_AU: 15, EBAY_AT: 16, EBAY_FR: 71, EBAY_DE: 77,
  EBAY_IT: 101, EBAY_NL: 146, EBAY_ES: 186, EBAY_CH: 193, EBAY_HK: 201, EBAY_IE: 205,
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
 *
 * @returns {Promise<{ views: number|null, watchers: number|null }>}
 */
async function fetchItemTraffic(refreshToken, itemId, marketplaceId) {
  const accessToken = await getAccessToken(refreshToken);
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
  if (/<Ack>\s*(Failure)\s*<\/Ack>/i.test(xml)) {
    const msg = (xml.match(/<LongMessage>([\s\S]*?)<\/LongMessage>/) || xml.match(/<ShortMessage>([\s\S]*?)<\/ShortMessage>/) || [])[1];
    const wrapped = new Error(msg ? msg.trim() : 'eBay rejected the traffic request.');
    wrapped.statusCode = 502;
    throw wrapped;
  }
  return { watchers: pickNumber(xml, 'WatchCount') ?? 0, views: pickNumber(xml, 'HitCount') };
}

module.exports = { fetchItemTraffic, pickNumber };
