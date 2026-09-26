const axios = require('axios');
const { getAppAccessToken } = require('./ebayAuthService');
const { EBAY_API_BASE_URL: EBAY_BASE_URL } = require('../config/ebayEnvironment');
const { getMarketplaceConfig, assertSupportedMarketplace } = require('../config/ebayMarketplaces');

// Category tree IDs rarely (if ever) change for a given marketplace, so we
// cache them in memory once fetched instead of calling getDefaultCategoryTreeId
// before every single suggestion request.
const categoryAspectsCache = {};

// ---------- fewer calls to eBay ----------
// eBay counts every Taxonomy call against the application's daily limit (5,000 by default, all sellers together). What comes back hardly
// ever changes, so every answer is kept: in memory, and in MongoDB (a restart or a deploy no longer means asking for everything again).
// Callers that ask for the same thing at the same moment (a big publish of one category) share ONE call. The category suggested for a title
// is kept by the search words, so a second product with the same words costs nothing.
const mongoose = require('mongoose');
const TaxonomyCache = require('../models/schemas/TaxonomyCache');
const ApiUsage = require('../models/schemas/ApiUsage');
const { dayKey } = require('./ebayCallBudget');

const DAY_MS = 24 * 60 * 60 * 1000;
const TTL = { tree: 30 * DAY_MS, aspects: 7 * DAY_MS, info: 7 * DAY_MS, suggest: 14 * DAY_MS };
const MEMORY_MS = 6 * 60 * 60 * 1000;
const MAX_ROW_CHARS = 3000000;
const memory = new Map();
const inflight = new Map();
const dbReady = () => !!(mongoose.connection && mongoose.connection.readyState === 1);

async function remember(key, ttlMs, load, { encode = (v) => v, decode = (v) => v } = {}) {
  const hit = memory.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  if (inflight.has(key)) return inflight.get(key);
  const work = (async () => {
    if (dbReady()) {
      try {
        const row = await TaxonomyCache.findOne({ key, expireAt: { $gt: new Date() } }).lean();
        if (row) {
          const value = decode(row.data);
          memory.set(key, { value, expires: Date.now() + Math.min(ttlMs, MEMORY_MS) });
          return value;
        }
      } catch (_) { /* the database is only a help: ask eBay */ }
    }
    const value = await load();
    memory.set(key, { value, expires: Date.now() + Math.min(ttlMs, MEMORY_MS) });
    if (dbReady()) {
      try {
        const data = encode(value);
        if (JSON.stringify(data).length <= MAX_ROW_CHARS) {
          await TaxonomyCache.updateOne({ key }, { $set: { data, expireAt: new Date(Date.now() + ttlMs) } }, { upsert: true });
        }
      } catch (_) { /* not saved: asked again next time */ }
    }
    return value;
  })().finally(() => inflight.delete(key));
  inflight.set(key, work);
  return work;
}

// ---------- counting the calls, and a clear answer when eBay says the day's limit is reached ----------
const COOL_DOWN_MS = 10 * 60 * 1000;
let coolDownUntil = 0;
const limitMessage = "eBay's daily limit for category lookups is used up. It starts again at midnight Pacific time (about 12 noon in Pakistan). Try again then.";
const isLimitSignal = (status, message) => Number(status) === 429 || /call\s+limit|limit\s+(has\s+been\s+)?(reached|exceeded)|too many requests|rate limit/i.test(String(message || ''));
function limitError() {
  const err = new Error(limitMessage);
  err.statusCode = 429;
  err.limitReached = true;
  return err;
}
function countCall() {
  if (!dbReady()) return;
  const key = dayKey().replace(/^trading:/, 'taxonomy:');
  ApiUsage.updateOne({ key }, { $inc: { total: 1 }, $setOnInsert: { expireAt: new Date(Date.now() + 3 * DAY_MS), stats: 0 } }, { upsert: true }).catch(() => {});
}

async function ebayGet(refreshToken, path, marketplaceId = 'EBAY_US') {
  // eBay said the limit is reached a moment ago: no more calls for a few minutes (each one would only be refused, and still counts as a try).
  if (Date.now() < coolDownUntil) throw limitError();
  const accessToken = await getAppAccessToken();
  const normalizedMarketplaceId = assertSupportedMarketplace(marketplaceId);
  const marketplace = getMarketplaceConfig(normalizedMarketplaceId);

  const request = async (requestPath) => {
    countCall();
    try {
      const response = await axios.get(`${EBAY_BASE_URL}${requestPath}`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Accept-Language': marketplace.locale,
          'Content-Language': marketplace.locale,
          'X-EBAY-C-MARKETPLACE-ID': normalizedMarketplaceId,
        },
        timeout: 15000,
      });
      return response.data;
    } catch (err) {
      const ebayErrors = err.response?.data?.errors;
      const message = ebayErrors && ebayErrors.length
        ? ebayErrors.map((e) => e.message).join('; ')
        : err.message || 'The eBay Taxonomy API request failed.';
      if (isLimitSignal(err.response?.status, message)) {
        coolDownUntil = Date.now() + COOL_DOWN_MS;
        throw limitError();
      }
      const wrapped = new Error(message);
      wrapped.statusCode = err.response?.status || 500;
      throw wrapped;
    }
  };

  try {
    // eBay's current Taxonomy documentation uses /v1. Some Sandbox/keysets
    // still expose the older /v1_beta route, so keep a 404-only fallback.
    return await request(path);
  } catch (err) {
    if (err.statusCode !== 404 || !path.includes('/commerce/taxonomy/v1/')) throw err;
    return request(path.replace('/commerce/taxonomy/v1/', '/commerce/taxonomy/v1_beta/'));
  }
}

/**
 * Gets (and caches) the category tree ID for a marketplace - required
 * before calling getCategorySuggestions for that marketplace.
 */
async function getCategoryTreeId(refreshToken, marketplaceId = 'EBAY_US') {
  return remember('tree:' + marketplaceId, TTL.tree, async () => {
    const data = await ebayGet(
      refreshToken,
      `/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=${encodeURIComponent(assertSupportedMarketplace(marketplaceId))}`,
      marketplaceId
    );
    return data.categoryTreeId;
  });
}

/**
 * eBay's category-suggestion matching works best on a short, buyer-style search
 * phrase (similar to what someone types into eBay search) - not a full Amazon
 * listing title, which is typically 100-200 characters of brand + model + size/
 * color/pack-count variants + marketing copy. Feeding the whole raw title in
 * consistently drowns out the actual product keywords and returns an irrelevant,
 * overly generic top category. Stripping bracketed/parenthetical noise (pack
 * counts, color/size call-outs, compatibility notes) and keeping only the first
 * handful of words gets much closer to what the Taxonomy API is tuned for.
 */
function buildCategoryQuery(title) {
  const cleaned = String(title || '')
    .replace(/[([][^)\]]*[)\]]/g, ' ')
    .replace(/[|/,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.split(' ').filter(Boolean).slice(0, 10).join(' ') || cleaned;
}

/**
 * Suggests eBay categories for a product based on its title (or other
 * descriptive text). Returns the top suggestion's category ID/name plus
 * the full list, so the caller can auto-fill the top pick while still
 * allowing the user to override it manually.
 *
 * @param {string} refreshToken - the user's eBay refresh token
 * @param {string} query - product title or keywords to match against
 * @param {string} marketplaceId - e.g. "EBAY_US" (categories are marketplace-specific)
 */
async function fetchSuggestions(refreshToken, query, marketplaceId = 'EBAY_US') {
  if (!query || !query.trim()) {
    throw new Error('A product title or keywords are required to suggest a category.');
  }

  const treeId = await getCategoryTreeId(refreshToken, marketplaceId);

  const data = await ebayGet(
    refreshToken,
    `/commerce/taxonomy/v1/category_tree/${encodeURIComponent(treeId)}/get_category_suggestions?q=${encodeURIComponent(buildCategoryQuery(query))}`,
    marketplaceId
  );

  const suggestions = Array.isArray(data.categorySuggestions)
    ? data.categorySuggestions.map((s) => ({
        categoryId: s.category?.categoryId,
        categoryName: s.category?.categoryName,
        // Ancestor names give useful context, e.g. "Electronics > Cell Phones > Cases".
        fullPath: Array.isArray(s.categoryTreeNodeAncestors)
          ? [...s.categoryTreeNodeAncestors.map((a) => a.categoryName).reverse(), s.category?.categoryName].join(' > ')
          : s.category?.categoryName,
      }))
    : [];

  return {
    topSuggestion: suggestions[0] || null,
    suggestions,
  };
}

/**
 * Returns the required/recommended/optional item aspects for a leaf category.
 * eBay's Taxonomy API is the source of truth for the category's item specifics.
 */
async function fetchItemAspects(refreshToken, categoryId, marketplaceId = 'EBAY_US') {
  if (!categoryId) throw new Error('A categoryId is required.');
  const treeId = await getCategoryTreeId(refreshToken, marketplaceId);
  const cacheKey = `${marketplaceId}:${treeId}:${categoryId}`;
  if (categoryAspectsCache[cacheKey]) return categoryAspectsCache[cacheKey];

  const data = await ebayGet(refreshToken,
    `/commerce/taxonomy/v1/category_tree/${encodeURIComponent(treeId)}/get_item_aspects_for_category?category_id=${encodeURIComponent(categoryId)}`,
    marketplaceId
  );

  const aspects = Array.isArray(data.aspects) ? data.aspects.map((a) => {
    const c = a.aspectConstraint || {};
    const all = Array.isArray(a.aspectValues) ? a.aspectValues.map(v => v.localizedValue).filter(Boolean) : [];
    const def = {
      name: a.localizedAspectName,
      required: !!c.aspectRequired,
      usage: c.aspectUsage || (c.aspectRequired ? 'REQUIRED' : 'OPTIONAL'),
      cardinality: c.itemToAspectCardinality || 'SINGLE',
      mode: c.aspectMode || 'FREE_TEXT',
      dataType: c.aspectDataType || 'STRING',
      // The editor only gets the first 100 choices (keeps the response small) ...
      values: all.slice(0, 100),
    };
    // ... but the publish check must know EVERY allowed value, or a valid one past #100 would be dropped.
    // Not enumerable, so it never goes out in the JSON response.
    Object.defineProperty(def, 'allValues', { value: all, enumerable: false });
    return def;
  }).filter(a => a.name) : [];

  const result = { categoryId: String(categoryId), categoryTreeId: String(treeId), aspects };
  categoryAspectsCache[cacheKey] = result;
  return result;
}

const categoryInfoCache = {};

/**
 * Name and leaf-status of one category on a marketplace's tree. eBay only accepts listings in a LEAF
 * category (the most specific level); a parent category such as "Cell Phones & Accessories" fails
 * the publish. Throws with statusCode 400/404 when eBay does not know the id on this marketplace.
 * @returns {Promise<{ categoryId: string, name: string, isLeaf: boolean, childNames: string[] }>}
 */
async function fetchCategoryInfo(refreshToken, categoryId, marketplaceId = 'EBAY_US') {
  if (!categoryId) throw new Error('A categoryId is required.');
  const treeId = await getCategoryTreeId(refreshToken, marketplaceId);
  const cacheKey = `${marketplaceId}:${treeId}:${categoryId}`;
  if (categoryInfoCache[cacheKey]) return categoryInfoCache[cacheKey];

  const data = await ebayGet(refreshToken,
    `/commerce/taxonomy/v1/category_tree/${encodeURIComponent(treeId)}/get_category_subtree?category_id=${encodeURIComponent(categoryId)}`,
    marketplaceId
  );
  const node = data?.categorySubtreeNode || {};
  const children = Array.isArray(node.childCategoryTreeNodes) ? node.childCategoryTreeNodes : [];
  const info = {
    categoryId: String(categoryId),
    name: node.category?.categoryName || '',
    isLeaf: node.leafCategoryTreeNode === true || children.length === 0,
    childNames: children.map((c) => c.category?.categoryName).filter(Boolean).slice(0, 6),
  };
  categoryInfoCache[cacheKey] = info;
  return info;
}

/** The category eBay suggests for a product title. The same search words are asked of eBay once (kept for 14 days). */
async function suggestCategories(refreshToken, query, marketplaceId = 'EBAY_US') {
  if (!query || !query.trim()) return fetchSuggestions(refreshToken, query, marketplaceId); // the same error as before
  const words = String(buildCategoryQuery(query) || '').toLowerCase().trim();
  if (!words) return fetchSuggestions(refreshToken, query, marketplaceId);
  return remember('suggest:' + marketplaceId + ':' + words, TTL.suggest, () => fetchSuggestions(refreshToken, query, marketplaceId));
}

/** The item specifics of a category (kept for 7 days). The full list of allowed values is not part of the JSON answer, so it is saved by name. */
async function getItemAspectsForCategory(refreshToken, categoryId, marketplaceId = 'EBAY_US') {
  if (!categoryId) return fetchItemAspects(refreshToken, categoryId, marketplaceId); // the same error as before
  const treeId = await getCategoryTreeId(refreshToken, marketplaceId);
  return remember('aspects:' + marketplaceId + ':' + treeId + ':' + categoryId, TTL.aspects, () => fetchItemAspects(refreshToken, categoryId, marketplaceId), {
    encode: (v) => ({ ...v, aspects: v.aspects.map((a) => ({ ...a, allValues: a.allValues })) }),
    decode: (d) => ({ ...d, aspects: (d.aspects || []).map(({ allValues, ...def }) => { Object.defineProperty(def, 'allValues', { value: allValues || def.values || [], enumerable: false }); return def; }) }),
  });
}

/** Name and leaf status of a category (kept for 7 days). */
async function getCategoryInfo(refreshToken, categoryId, marketplaceId = 'EBAY_US') {
  if (!categoryId) return fetchCategoryInfo(refreshToken, categoryId, marketplaceId); // the same error as before
  const treeId = await getCategoryTreeId(refreshToken, marketplaceId);
  return remember('info:' + marketplaceId + ':' + treeId + ':' + categoryId, TTL.info, () => fetchCategoryInfo(refreshToken, categoryId, marketplaceId));
}

module.exports = { suggestCategories, getItemAspectsForCategory, getCategoryInfo, buildCategoryQuery, _memory: memory, _resetCoolDown: () => { coolDownUntil = 0; } };
