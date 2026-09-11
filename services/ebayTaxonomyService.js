const axios = require('axios');
const { getAppAccessToken } = require('./ebayAuthService');
const { EBAY_API_BASE_URL: EBAY_BASE_URL } = require('../config/ebayEnvironment');

// Category tree IDs rarely (if ever) change for a given marketplace, so we
// cache them in memory once fetched instead of calling getDefaultCategoryTreeId
// before every single suggestion request.
const categoryTreeIdCache = {};
const categoryAspectsCache = {};

async function ebayGet(refreshToken, path) {
  const accessToken = await getAppAccessToken();

  const request = async (requestPath) => {
    try {
      const response = await axios.get(`${EBAY_BASE_URL}${requestPath}`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      });
      return response.data;
    } catch (err) {
      const ebayErrors = err.response?.data?.errors;
      const message = ebayErrors && ebayErrors.length
        ? ebayErrors.map((e) => e.message).join('; ')
        : err.message || 'The eBay Taxonomy API request failed.';
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
  if (categoryTreeIdCache[marketplaceId]) return categoryTreeIdCache[marketplaceId];

  const data = await ebayGet(
    refreshToken,
    `/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=${encodeURIComponent(marketplaceId)}`
  );

  categoryTreeIdCache[marketplaceId] = data.categoryTreeId;
  return data.categoryTreeId;
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
async function suggestCategories(refreshToken, query, marketplaceId = 'EBAY_US') {
  if (!query || !query.trim()) {
    throw new Error('A product title or keywords are required to suggest a category.');
  }

  const treeId = await getCategoryTreeId(refreshToken, marketplaceId);

  const data = await ebayGet(
    refreshToken,
    `/commerce/taxonomy/v1/category_tree/${encodeURIComponent(treeId)}/get_category_suggestions?q=${encodeURIComponent(query.trim())}`
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
async function getItemAspectsForCategory(refreshToken, categoryId, marketplaceId = 'EBAY_US') {
  if (!categoryId) throw new Error('A categoryId is required.');
  const treeId = await getCategoryTreeId(refreshToken, marketplaceId);
  const cacheKey = `${marketplaceId}:${treeId}:${categoryId}`;
  if (categoryAspectsCache[cacheKey]) return categoryAspectsCache[cacheKey];

  const data = await ebayGet(refreshToken,
    `/commerce/taxonomy/v1/category_tree/${encodeURIComponent(treeId)}/get_item_aspects_for_category?category_id=${encodeURIComponent(categoryId)}`
  );

  const aspects = Array.isArray(data.aspects) ? data.aspects.map((a) => {
    const c = a.aspectConstraint || {};
    return {
      name: a.localizedAspectName,
      required: !!c.aspectRequired,
      usage: c.aspectUsage || (c.aspectRequired ? 'REQUIRED' : 'OPTIONAL'),
      cardinality: c.itemToAspectCardinality || 'SINGLE',
      dataType: c.aspectDataType || 'STRING',
      values: Array.isArray(a.aspectValues) ? a.aspectValues.map(v => v.localizedValue).filter(Boolean).slice(0, 100) : [],
    };
  }).filter(a => a.name) : [];

  const result = { categoryId: String(categoryId), categoryTreeId: String(treeId), aspects };
  categoryAspectsCache[cacheKey] = result;
  return result;
}

module.exports = { suggestCategories, getItemAspectsForCategory };
