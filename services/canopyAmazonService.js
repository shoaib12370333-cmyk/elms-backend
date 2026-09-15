const axios = require('axios');
const { retryWithBackoff } = require('./retryService');

const REST_BASE_URL = 'https://rest.canopyapi.co';

/**
 * Maps our internal country codes (used elsewhere in the app, e.g. from
 * detectCountryFromUrl) to Canopy's marketplace domain codes. Canopy
 * supports 12+ marketplaces; anything not in this map falls back to US.
 */
const COUNTRY_TO_CANOPY_DOMAIN = {
  US: 'US', GB: 'UK', CA: 'CA', DE: 'DE', FR: 'FR', IT: 'IT',
  ES: 'ES', AU: 'AU', IN: 'IN', MX: 'MX', BR: 'BR', JP: 'JP',
};

function toCanopyDomain(countryCode) {
  return COUNTRY_TO_CANOPY_DOMAIN[countryCode] || 'US';
}

/**
 * Sends an authenticated GET request to a Canopy REST endpoint. Retries
 * automatically on transient failures (network issues, timeouts, 5xx/429)
 * via retryWithBackoff, since these are safe read-only requests.
 */
async function canopyGet(path, params) {
  const apiKey = process.env.CANOPY_API_KEY;
  if (!apiKey) {
    throw new Error('CANOPY_API_KEY is not set in the .env file.');
  }

  try {
    const response = await retryWithBackoff(() =>
      axios.get(`${REST_BASE_URL}${path}`, {
        params,
        headers: {
          'API-KEY': apiKey,
          'Content-Type': 'application/json',
        },
        timeout: 20000,
      })
    );
    return response.data;
  } catch (err) {
    const message = err.response?.data?.message || err.response?.data?.error || err.message || 'The Canopy API request failed.';
    const wrapped = new Error(message);
    wrapped.statusCode = err.response?.status || 500;
    throw wrapped;
  }
}

/**
 * Extracts an Amazon ASIN from a product URL. Handles the common URL
 * shapes: /dp/ASIN, /gp/product/ASIN, and a bare ASIN with query params.
 * (Shared normalization logic, kept here so this
 * service is self-contained.)
 */
function extractAsinFromUrl(url) {
  const match = url.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
  if (match) return match[1].toUpperCase();

  const fallbackMatch = url.match(/\/([A-Z0-9]{10})(?:[/?]|$)/i);
  if (fallbackMatch) return fallbackMatch[1].toUpperCase();

  return null;
}

const AMAZON_DOMAIN_TO_COUNTRY = {
  'amazon.com': 'US', 'amazon.co.uk': 'GB', 'amazon.ca': 'CA', 'amazon.de': 'DE',
  'amazon.fr': 'FR', 'amazon.it': 'IT', 'amazon.es': 'ES', 'amazon.in': 'IN',
  'amazon.com.au': 'AU', 'amazon.com.br': 'BR', 'amazon.com.mx': 'MX', 'amazon.nl': 'NL',
  'amazon.se': 'SE', 'amazon.sg': 'SG', 'amazon.ae': 'AE', 'amazon.sa': 'SA',
  'amazon.co.jp': 'JP', 'amazon.cn': 'CN', 'amazon.com.tr': 'TR',
};

function detectCountryFromUrl(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return AMAZON_DOMAIN_TO_COUNTRY[hostname] || 'US';
  } catch {
    return 'US';
  }
}

/**
 * Normalizes a Canopy product response into the same shape the rest of
 * the app already expects (matching the normalized product shape),
 * so routes/fetchProduct.js and the frontend don't need to change.
 *
 * IMPORTANT: Canopy's actual response wraps everything in
 * { data: { amazonProduct: { ... } } } - confirmed by live testing
 * (not the flatter shape shown in some third-party blog examples). The
 * real field names are also different from what public docs suggested:
 * mainImageUrl/imageUrls (not images), featureBullets, technicalSpecifications
 * (an array of {name, value} pairs, not an object), ratingsTotal, and
 * price as { value, currency, display }.
 */
function normalizeProduct(rawResponse, sourceUrl) {
  const data = unwrapCanopyData(rawResponse, ['amazonProduct']);

  const images = Array.isArray(data.imageUrls) ? data.imageUrls.filter(Boolean) : [];
  const mainImage = data.mainImageUrl || null;
  let allImages = images;
  if (mainImage) {
    allImages = [mainImage, ...images.filter((url) => url !== mainImage)];
  }

  const price = data.price?.value != null ? Number(data.price.value) : null;
  const currency = data.price?.currency || 'USD';

  const bulletPoints = Array.isArray(data.featureBullets) ? data.featureBullets : [];

  const description = data.description || (bulletPoints.length ? bulletPoints.join('\n') : '');

  // technicalSpecifications is an array of { name, value } pairs already
  // in the shape our app expects, not a plain object like RapidAPI gave us.
  const specifications = Array.isArray(data.technicalSpecifications)
    ? data.technicalSpecifications
        .map((spec) => ({ name: spec.name, value: String(spec.value) }))
        .filter((spec) => spec.name && spec.value)
    : [];

  const categories = Array.isArray(data.categories)
    ? data.categories.map((c) => (typeof c === 'string' ? c : c.name)).filter(Boolean)
    : [];

  const variants = Array.isArray(data.variants)
    ? data.variants.map((v) => ({
        asin: v.asin,
        title: v.title || null,
        image: v.image || v.thumbnailUrl || null,
        isCurrentProduct: v.asin === data.asin,
        dimensions: v.attributes
          ? Object.entries(v.attributes).map(([name, value]) => ({ name, value }))
          : [],
      }))
    : [];

  return {
    asin: data.asin || null,
    title: data.title || '',
    description,
    bulletPoints,
    images: allImages,
    price,
    currency,
    availability: data.isInStock === false ? 'Out of Stock' : data.isInStock === true ? 'In Stock' : null,
    rating: data.rating != null ? Number(data.rating) : null,
    ratingsTotal: data.ratingsTotal || null,
    brand: data.brand || null,
    sourceUrl: sourceUrl || data.url || null,
    categories,
    specifications,
    variants,
  };
}

/**
 * Fetches full product data from an Amazon product URL.
 */
async function fetchProductByUrl(amazonUrl) {
  if (!amazonUrl || typeof amazonUrl !== 'string') {
    throw new Error('An Amazon URL is required.');
  }

  const asin = extractAsinFromUrl(amazonUrl);
  if (!asin) {
    const err = new Error('Could not find a valid Amazon ASIN in that URL.');
    err.statusCode = 400;
    throw err;
  }

  const country = detectCountryFromUrl(amazonUrl);
  const data = await canopyGet('/api/amazon/product', { asin, domain: toCanopyDomain(country) });
  return normalizeProduct(data, amazonUrl);
}

/**
 * Fetches full product data by ASIN directly (used when a variant is
 * selected, since a variant only has an ASIN, not a full URL).
 */
async function fetchProductByAsin(asin, country) {
  const data = await canopyGet('/api/amazon/product', { asin, domain: toCanopyDomain(country) });
  return normalizeProduct(data, data.link || null);
}

/**
 * Fetches a product's current availability (and price) from Amazon - used
 * by the stock monitor for a lightweight "is this still in stock, and at
 * what price" check. Stock and price are both read from the same Canopy
 * /api/amazon/product response, so checking both here costs exactly the
 * same single Canopy call as checking stock alone did before - this is why
 * ACTION_COSTS.PRICE_MONITORING is 0 (free): it doesn't spend a second
 * Canopy call or a second ELMS credit, it's piggybacked on the stock check.
 */
async function checkAvailabilityByAsin(asin, country = 'US') {
  const rawResponse = await canopyGet('/api/amazon/product', { asin, domain: toCanopyDomain(country) });
  const data = unwrapCanopyData(rawResponse, ['amazonProduct']);
  const inStock = data.isInStock === true;
  const price = data.price?.value != null ? Number(data.price.value) : null;
  const currency = data.price?.currency || null;
  return {
    inStock,
    availabilityText: data.isInStock === false ? 'Out of Stock' : data.isInStock === true ? 'In Stock' : 'Unknown',
    price: Number.isFinite(price) ? price : null,
    currency,
  };
}

/**
 * Fetches a product's customer reviews - used by the Review Analyzer tool
 * to show ratings breakdown, sentiment split, and sample reviews.
 */
/**
 * Canopy wraps its responses in a nested shape - confirmed by live testing
 * to be { data: { amazonProduct: {...} } } for the product endpoint. This
 * helper unwraps that (or falls back gracefully if a given endpoint ever
 * returns something flatter), so every function below reads from the
 * actual product/review/search data regardless of the wrapper key name.
 */
function unwrapCanopyData(rawResponse, possibleKeys) {
  const inner = rawResponse?.data || rawResponse || {};
  for (const key of possibleKeys) {
    if (inner[key]) return inner[key];
  }
  // Nothing matched a known wrapper key - assume the response is already flat.
  return inner;
}

async function fetchProductReviews(asin, country = 'US') {
  const rawResponse = await canopyGet('/api/amazon/product/reviews', { asin, domain: toCanopyDomain(country) });
  const data = unwrapCanopyData(rawResponse, ['amazonProductReviews', 'reviews', 'amazonProduct']);
  const reviews = Array.isArray(data.reviews) ? data.reviews : Array.isArray(data) ? data : [];

  return {
    asin,
    averageRating: data.rating != null ? Number(data.rating) : null,
    ratingsTotal: data.ratingsTotal || data.reviewCount || reviews.length,
    ratingDistribution: data.ratingDistribution || null,
    reviews: reviews.map((r) => ({
      title: r.title || null,
      body: r.body || r.text || r.content || null,
      rating: r.rating != null ? Number(r.rating) : null,
      author: r.author || r.authorName || null,
      date: r.date || null,
      verifiedPurchase: !!r.verifiedPurchase,
      helpfulVotes: r.helpfulVotes || 0,
    })),
  };
}

/**
 * Searches Amazon products by keyword, with optional filters - used by
 * the Keyword Rank Checker (to find a target ASIN's position in results)
 * and can also power a general product-search feature later.
 *
 * @param {string} searchTerm
 * @param {object} options - { country, page, limit, minPrice, maxPrice, conditions, sort }
 */
async function searchProducts(searchTerm, options = {}) {
  const { country = 'US', page, limit, minPrice, maxPrice, conditions, sort } = options;

  const rawResponse = await canopyGet('/api/amazon/search', {
    searchTerm,
    domain: toCanopyDomain(country),
    page,
    limit,
    minPrice,
    maxPrice,
    conditions,
    sort,
  });

  const data = unwrapCanopyData(rawResponse, ['amazonProductSearchResults', 'amazonSearchResults', 'search']);
  const results = Array.isArray(data.products) ? data.products : Array.isArray(data.results) ? data.results : Array.isArray(data) ? data : [];

  return results.map((p, index) => ({
    position: (((page || 1) - 1) * (limit || 20)) + index + 1,
    asin: p.asin || null,
    title: p.title || null,
    brand: p.brand || null,
    price: p.price?.value != null ? Number(p.price.value) : null,
    currency: p.price?.currency || null,
    rating: p.rating != null ? Number(p.rating) : null,
    ratingsTotal: p.ratingsTotal || p.reviewCount || null,
    image: p.mainImageUrl || (Array.isArray(p.imageUrls) ? p.imageUrls[0] : null) || (Array.isArray(p.images) ? (p.images[0]?.url || p.images[0]) : null) || p.thumbnailUrl || null,
    isSponsored: !!p.isSponsored,
  }));
}

/**
 * Finds where a specific ASIN ranks for a given keyword, by searching
 * that keyword and locating the ASIN in the results across a few pages.
 * Used by the Keyword Rank Checker tool.
 *
 * @param {string} keyword
 * @param {string} targetAsin
 * @param {object} options - { country, maxPages }
 */
async function findKeywordRank(keyword, targetAsin, options = {}) {
  const { country = 'US', maxPages = 3 } = options;
  const pageSize = 40;

  for (let page = 1; page <= maxPages; page++) {
    const results = await searchProducts(keyword, { country, page, limit: pageSize });
    const match = results.find((r) => r.asin === targetAsin);
    if (match) {
      return { found: true, position: match.position, page, results };
    }
    if (results.length < pageSize) break; // no more pages of results
  }

  return { found: false, position: null, page: null, results: [] };
}

/**
 * Fetches Amazon's autocomplete suggestions for a partial search term -
 * useful for keyword research (seeing what related terms Amazon suggests).
 */
async function fetchAutocomplete(searchTerm, country = 'US') {
  const rawResponse = await canopyGet('/api/amazon/autocomplete', { searchTerm, domain: toCanopyDomain(country) });
  const data = unwrapCanopyData(rawResponse, ['amazonAutocomplete', 'autocomplete']);
  return Array.isArray(data.suggestions) ? data.suggestions : Array.isArray(data) ? data : [];
}

/**
 * Fetches the root Amazon category taxonomy for a marketplace.
 */
async function fetchCategories(country = 'US') {
  const rawResponse = await canopyGet('/api/amazon/categories', { domain: toCanopyDomain(country) });
  const data = unwrapCanopyData(rawResponse, ['amazonCategories', 'categories']);
  return Array.isArray(data.categories) ? data.categories : Array.isArray(data) ? data : [];
}

/**
 * Fetches details (including subcategories and, when sorted appropriately,
 * top-ranked products) for one Amazon category - used by both the
 * Category Finder and Bestseller Explorer tools.
 *
 * @param {string} categoryId
 * @param {object} options - { country, page, sort }
 */
async function fetchCategoryDetails(categoryId, options = {}) {
  const { country = 'US', page, sort } = options;
  const rawResponse = await canopyGet('/api/amazon/category', {
    categoryId,
    domain: toCanopyDomain(country),
    page,
    sort,
  });

  const data = unwrapCanopyData(rawResponse, ['amazonCategory', 'category']);

  return {
    categoryId: data.categoryId || categoryId,
    name: data.name || null,
    subcategories: Array.isArray(data.subcategories) ? data.subcategories : [],
    products: Array.isArray(data.products)
      ? data.products.map((p, index) => ({
          rank: (((page || 1) - 1) * 20) + index + 1,
          asin: p.asin || null,
          title: p.title || null,
          brand: p.brand || null,
          price: p.price?.value != null ? Number(p.price.value) : null,
          rating: p.rating != null ? Number(p.rating) : null,
          image: p.mainImageUrl || (Array.isArray(p.imageUrls) ? p.imageUrls[0] : null) || (Array.isArray(p.images) ? (p.images[0]?.url || p.images[0]) : null) || null,
        }))
      : [],
  };
}

/**
 * Finds which category/categories a specific product belongs to, along
 * with its best-seller rank within each - used by the Category Finder tool.
 * Canopy's product endpoint already returns this as part of standard
 * product data, so this is a thin, purpose-named wrapper around fetchProductByAsin.
 */
async function findProductCategories(asin, country = 'US') {
  const rawResponse = await canopyGet('/api/amazon/product', { asin, domain: toCanopyDomain(country) });
  const data = unwrapCanopyData(rawResponse, ['amazonProduct']);
  const categories = Array.isArray(data.categories)
    ? data.categories.map((c) => (typeof c === 'string' ? { name: c, rank: null } : { name: c.name, rank: c.rank || c.bestSellerRank || null, categoryId: c.id || c.categoryId || null }))
    : [];
  return { asin, title: data.title || null, categories };
}

/**
 * Grades a live listing on five conversion-critical dimensions, matching
 * the same transparent, deterministic heuristics Canopy's own free
 * Listing Grader tool uses (canopyapi.co/tools/listing-grader):
 *   - Title length: ideal is 80-200 characters
 *   - Feature bullets: ideal is all 5 used
 *   - Image count: ideal is 6 or more
 *   - Star rating: scored out of 5 stars
 *   - Review volume: more reviews scores higher, on a log-ish curve
 * Each dimension gets a 0-100 score; the overall grade is their average.
 */
function gradeListingData(product) {
  const titleLength = (product.title || '').length;
  const titleScore = titleLength >= 80 && titleLength <= 200
    ? 100
    : titleLength === 0
      ? 0
      : Math.max(0, 100 - Math.abs(140 - titleLength) * 0.7); // 140 is the sweet spot midpoint

  const bulletCount = (product.bulletPoints || []).length;
  const bulletScore = Math.min(100, (bulletCount / 5) * 100);

  const imageCount = (product.images || []).length;
  const imageScore = Math.min(100, (imageCount / 6) * 100);

  const rating = product.rating || 0;
  const ratingScore = Math.min(100, (rating / 5) * 100);

  const reviewCount = product.ratingsTotal || 0;
  // A log-ish curve so going from 0->100 reviews matters a lot more than
  // 10,000->10,100 - 500+ reviews is treated as effectively maxed out.
  const reviewScore = reviewCount <= 0 ? 0 : Math.min(100, (Math.log10(reviewCount + 1) / Math.log10(501)) * 100);

  const dimensions = [
    {
      name: 'Title length',
      score: Math.round(titleScore),
      detail: `${titleLength} characters`,
      suggestion: titleLength < 80
        ? 'Your title is short - aim for 80-200 characters to include more searchable keywords.'
        : titleLength > 200
          ? 'Your title is long - Amazon may truncate it. Aim for 80-200 characters.'
          : 'Title length is in the ideal range.',
    },
    {
      name: 'Feature bullets',
      score: Math.round(bulletScore),
      detail: `${bulletCount} of 5 used`,
      suggestion: bulletCount < 5
        ? `You're using ${bulletCount} of the 5 available bullet points - fill in all 5 to cover more buyer questions.`
        : 'All 5 feature bullets are in use.',
    },
    {
      name: 'Image count',
      score: Math.round(imageScore),
      detail: `${imageCount} images`,
      suggestion: imageCount < 6
        ? `You have ${imageCount} image(s) - Amazon recommends 6+ to show the product from multiple angles and in use.`
        : 'Image count meets the recommended minimum.',
    },
    {
      name: 'Star rating',
      score: Math.round(ratingScore),
      detail: rating ? `${rating.toFixed(1)} / 5` : 'No rating yet',
      suggestion: rating < 4
        ? 'A rating below 4 stars can hurt conversion - review recent negative feedback for fixable issues.'
        : 'Rating is strong.',
    },
    {
      name: 'Review volume',
      score: Math.round(reviewScore),
      detail: `${reviewCount.toLocaleString()} reviews`,
      suggestion: reviewCount < 50
        ? 'Low review volume can make buyers hesitant - consider a review-generation strategy (e.g. Amazon Vine).'
        : 'Review volume is healthy.',
    },
  ];

  const overallScore = Math.round(dimensions.reduce((sum, d) => sum + d.score, 0) / dimensions.length);

  return { overallScore, dimensions };
}

/**
 * Fetches a product and grades its listing quality in one call - powers
 * the Listing Grader tool.
 */
async function gradeListing(asin, country = 'US') {
  const product = await fetchProductByAsin(asin, country);
  const grade = gradeListingData(product);
  return { asin, title: product.title, ...grade };
}

module.exports = {
  fetchProductByUrl,
  fetchProductByAsin,
  checkAvailabilityByAsin,
  fetchProductReviews,
  searchProducts,
  findKeywordRank,
  fetchAutocomplete,
  fetchCategories,
  fetchCategoryDetails,
  findProductCategories,
  gradeListing,
  canopyGet,
  toCanopyDomain,
  extractAsinFromUrl,
  detectCountryFromUrl,
};
