const axios = require('axios');
const { getAccessToken } = require('./ebayAuthService');
const { EBAY_API_BASE_URL, EBAY_IDENTITY_BASE_URL } = require('../config/ebayEnvironment');
const { SITE_IDS } = require('./ebayStatsService');
const { record } = require('./ebayCallBudget');

/**
 * Who is behind a connected eBay account, so ELMS can show a real name instead of an id:
 *  - the eBay username (Commerce Identity API, and the Trading API's GetUser as a second source),
 *  - the eBay Store name (Trading API GetStore) - only sellers with an eBay Store subscription have one.
 * Every lookup is non-fatal: when one fails the caller falls back to what it has.
 */

const decodeXml = (s) => String(s || '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'")
  .replace(/&#x27;/gi, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&').trim();

function pick(xml, tag) {
  const m = String(xml || '').match(new RegExp(String.raw`<${tag}>\s*([^<]*?)\s*</${tag}>`));
  return m ? decodeXml(m[1]) : null;
}

/** The Trading API answer of GetStore -> { name, url } ('' name = the seller has no eBay Store). */
function parseStore(xml) {
  const block = (String(xml || '').match(/<Store>([\s\S]*?)<\/Store>/) || [])[1];
  if (!block) return { name: null, url: null };
  const head = block.split('<CustomCategories>')[0]; // the store's own Name comes before its category names
  return { name: pick(head, 'Name') || null, url: pick(head, 'URL') || null };
}

/** The Trading API answer of GetUser (no UserID = the account of the token) -> { username, hasStore, storeUrl }. */
function parseTradingUser(xml) {
  const owner = pick(xml, 'StoreOwner');
  return { username: pick(xml, 'UserID') || null, hasStore: owner === null ? null : owner.toLowerCase() === 'true', storeUrl: pick(xml, 'StoreURL') || null };
}

function failureOf(xml) {
  if (!/<Ack>\s*Failure\s*<\/Ack>/i.test(xml)) return null;
  return { code: pick(xml, 'ErrorCode'), message: pick(xml, 'ShortMessage') || 'eBay rejected the request.' };
}

async function tradingCall(refreshToken, callName, marketplaceId, innerXml) {
  const accessToken = await getAccessToken(refreshToken);
  record('core'); // counted against eBay's daily Trading allowance, never refused (the connect step needs it)
  const body = `<?xml version="1.0" encoding="utf-8"?>\n<${callName}Request xmlns="urn:ebay:apis:eBLBaseComponents">${innerXml}</${callName}Request>`;
  const response = await axios.post(`${EBAY_API_BASE_URL}/ws/api.dll`, body, {
    headers: {
      'Content-Type': 'text/xml',
      'X-EBAY-API-CALL-NAME': callName,
      'X-EBAY-API-COMPATIBILITY-LEVEL': '1193',
      'X-EBAY-API-SITEID': String(SITE_IDS[marketplaceId] ?? 0),
      'X-EBAY-API-IAF-TOKEN': accessToken,
    },
    timeout: 12000,
    responseType: 'text',
    transformResponse: (r) => r,
  });
  return String(response.data || '');
}

/**
 * The Commerce Identity API. It lives on apiz.ebay.com (not api.ebay.com - asking the wrong host is why every account ended
 * up named "eBay Account <number>"). eBay has started to answer some accounts with only an immutable userId and no username;
 * that id means nothing to a person, so it is returned as `userId` and never used as a name.
 */
async function fetchIdentityUser(refreshToken) {
  const accessToken = await getAccessToken(refreshToken);
  const response = await axios.get(`${EBAY_IDENTITY_BASE_URL}/commerce/identity/v1/user/`, {
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    timeout: 10000,
  });
  const d = response.data || {};
  return {
    username: d.username ? String(d.username).trim() : null,
    userId: d.userId ? String(d.userId).trim() : null,
    accountType: d.accountType || null,
    businessName: d.businessAccount && d.businessAccount.name ? String(d.businessAccount.name).trim() : null,
  };
}

/** Just the eBay username (kept for callers that only need it). */
async function fetchEbayUsername(refreshToken) {
  try {
    return (await fetchIdentityUser(refreshToken)).username;
  } catch (err) {
    console.warn('Could not fetch eBay username:', err.response?.data || err.message);
    return null;
  }
}

/** The eBay Store name of the account ('' when the seller has no eBay Store). null = could not be looked up. */
async function fetchStoreName(refreshToken, marketplaceId) {
  try {
    const xml = await tradingCall(refreshToken, 'GetStore', marketplaceId, '<CategoryStructureOnly>true</CategoryStructureOnly>');
    const failed = failureOf(xml);
    if (failed) {
      // "You do not have a Store" is an answer, not a failure: it means there is no store name to show.
      if (/no\s+store|not\s+have\s+a\s+store|store\s+not\s+found|does not have an? (ebay )?store/i.test(failed.message) || failed.code === '13003') return { name: '', url: null };
      console.warn('[ebay-identity] GetStore: ' + (failed.code ? failed.code + ' ' : '') + failed.message);
      return null;
    }
    const store = parseStore(xml);
    return { name: store.name || '', url: store.url };
  } catch (err) {
    console.warn('[ebay-identity] GetStore failed:', err.response?.data ? String(err.response.data).slice(0, 200) : err.message);
    return null;
  }
}

/** The Trading API's GetUser for the account of the token: username, and whether it owns an eBay Store. */
async function fetchTradingUser(refreshToken, marketplaceId) {
  try {
    const xml = await tradingCall(refreshToken, 'GetUser', marketplaceId, '<DetailLevel>ReturnAll</DetailLevel>');
    const failed = failureOf(xml);
    if (failed) { console.warn('[ebay-identity] GetUser: ' + failed.message); return null; }
    return parseTradingUser(xml);
  } catch (err) {
    console.warn('[ebay-identity] GetUser failed:', err.message);
    return null;
  }
}

/**
 * Everything ELMS shows to name a connected account:
 * { username, storeName, storeUrl, hasStore, accountType, checked }
 *  - username: the eBay username when eBay gives one (Identity API first, GetUser second), else null;
 *  - storeName: the eBay Store name, '' when the seller has no store, null when it could not be looked up;
 *  - checked: true when at least one lookup answered (so a wrong day for eBay does not mark the account as "looked at").
 */
async function fetchSellerIdentity(refreshToken, marketplaceId) {
  const [identity, store] = await Promise.all([
    fetchIdentityUser(refreshToken).catch((err) => { console.warn('[ebay-identity] Identity API:', err.response?.data ? JSON.stringify(err.response.data).slice(0, 200) : err.message); return null; }),
    fetchStoreName(refreshToken, marketplaceId),
  ]);
  let username = identity?.username || null;
  let hasStore = store ? Boolean(store.name) : null;
  let storeUrl = store?.url || null;
  if (!username || hasStore === null) {
    const trading = await fetchTradingUser(refreshToken, marketplaceId);
    if (trading) {
      username = username || trading.username;
      if (hasStore === null) hasStore = trading.hasStore;
      storeUrl = storeUrl || trading.storeUrl;
    }
  }
  return {
    username,
    storeName: store ? store.name : null,
    storeUrl,
    hasStore,
    accountType: identity?.accountType || null,
    businessName: identity?.businessName || null,
    checked: !!(identity || store),
  };
}

module.exports = { fetchEbayUsername, fetchIdentityUser, fetchStoreName, fetchTradingUser, fetchSellerIdentity, parseStore, parseTradingUser };
