const axios = require('axios');

const RAPIDAPI_HOST = 'real-time-amazon-data.p.rapidapi.com';
const BASE_URL = `https://${RAPIDAPI_HOST}`;

/**
 * Extracts an Amazon ASIN from a product URL. Handles the common URL
 * shapes: /dp/ASIN, /gp/product/ASIN, and a bare ASIN with query params.
 */
function extractAsinFromUrl(url) {
  const match = url.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
  if (match) return match[1].toUpperCase();

  // Fallback: some URLs put the ASIN right after the domain with no /dp/.
  const fallbackMatch = url.match(/\/([A-Z0-9]{10})(?:[/?]|$)/i);
  if (fallbackMatch) return fallbackMatch[1].toUpperCase();

  return null;
}

/**
 * Calls the Real-Time Amazon Data "product-details" endpoint for a given
 * ASIN and returns the raw response data.
 */
async function fetchRawProductByAsin(asin, country = 'US') {
  const apiKey = process.env.RAPIDAPI_KEY;

  if (!apiKey) {
    throw new Error('RAPIDAPI_KEY is not set in the .env file.');
  }
  if (!asin) {
    throw new Error('An ASIN is required.');
  }

  let response;
  try {
    response = await axios.get(`${BASE_URL}/product-details`, {
      params: { asin, country },
      headers: {
        'x-rapidapi-host': RAPIDAPI_HOST,
        'x-rapidapi-key': apiKey,
      },
      timeout: 20000,
    });
  } catch (err) {
    const message =
      err.response?.data?.message ||
      err.response?.data?.error ||
      'Could not get product data from the Amazon data API.';
    const wrapped = new Error(message);
    wrapped.statusCode = err.response?.status || 500;
    throw wrapped;
  }

  const data = response.data?.data;

  if (!data) {
    const err = new Error('No product data was found for this ASIN.');
    err.statusCode = 404;
    throw err;
  }

  return data;
}

/**
 * Fetches full product data (title, images, description, specifications,
 * price, etc.) from an Amazon product URL. This is the RapidAPI equivalent
 * of the old rainforestService.fetchProductByUrl, returning the same
 * normalized shape so the rest of the app (fetch-product route, frontend
 * rendering) works unchanged.
 *
 * @param {string} amazonUrl - Full Amazon product page URL
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

  const data = await fetchRawProductByAsin(asin);
  return normalizeProduct(data, amazonUrl);
}

/**
 * Fetches full product data by ASIN directly (used when a variant is
 * selected, since a variant only has an ASIN, not a full URL).
 */
async function fetchProductByAsin(asin, country) {
  const data = await fetchRawProductByAsin(asin, country);
  return normalizeProduct(data, data.product_url || null);
}

/**
 * Fetches a product's current availability from Amazon. Used by the stock
 * monitor for a lightweight "is this still in stock" check.
 *
 * @param {string} asin
 * @param {string} country - Amazon marketplace country code, e.g. "US" (default)
 * @returns {Promise<{ asin: string, inStock: boolean, availabilityText: string|null, price: number|null }>}
 */
async function checkAvailabilityByAsin(asin, country = 'US') {
  const data = await fetchRawProductByAsin(asin, country);

  // This API returns availability as a plain text string (e.g. "In Stock",
  // "Only 3 left in stock", "Currently unavailable"). We treat anything
  // that clearly says unavailable/out of stock as out of stock, and
  // everything else as in stock (safer default: don't wrongly end a listing).
  const availabilityText = data.product_availability || null;
  const outOfStockPhrases = ['currently unavailable', 'out of stock', 'unavailable'];
  const inStock = availabilityText
    ? !outOfStockPhrases.some((phrase) => availabilityText.toLowerCase().includes(phrase))
    : true;

  return {
    asin: data.asin || asin,
    inStock,
    availabilityText,
    price: data.product_price ? parseFloat(String(data.product_price).replace(/[^0-9.]/g, '')) || null : null,
  };
}

/**
 * Converts the Real-Time Amazon Data API's raw product object into the
 * same normalized shape rainforestService used to produce, so the rest of
 * the app (routes, frontend rendering) doesn't need to change.
 */
function normalizeProduct(data, sourceUrl) {
  const images = Array.isArray(data.product_photos) ? data.product_photos.filter(Boolean) : [];
  // This API sometimes also gives a single main photo separately - put it
  // first and avoid a duplicate, same approach as the old Rainforest service.
  const mainImageLink = data.product_photo || null;
  let allImages = images;
  if (mainImageLink) {
    allImages = [mainImageLink, ...images.filter((link) => link !== mainImageLink)];
  }

  const price = data.product_price
    ? parseFloat(String(data.product_price).replace(/[^0-9.]/g, '')) || null
    : null;

  // product_details is a flat object of spec name -> value (e.g. "Brand": "Sony").
  const specifications = data.product_details && typeof data.product_details === 'object'
    ? Object.entries(data.product_details)
        .map(([name, value]) => ({ name, value: String(value) }))
        .filter((spec) => spec.name && spec.value)
    : [];

  // This API doesn't return a separate category breadcrumb array the way
  // Rainforest did; category_path (if present) is the closest equivalent.
  const categories = Array.isArray(data.category_path)
    ? data.category_path.map((c) => (typeof c === 'string' ? c : c.name)).filter(Boolean)
    : [];

  // Variants come back as a flat list of ASINs with their own titles/photos.
  const variants = Array.isArray(data.product_variations)
    ? Object.entries(data.product_variations).map(([asin, variantData]) => ({
        asin,
        title: variantData?.title || null,
        image: variantData?.photo || null,
        isCurrentProduct: asin === data.asin,
        dimensions: variantData?.dimensions
          ? Object.entries(variantData.dimensions).map(([name, value]) => ({ name, value }))
          : [],
      }))
    : [];

  // This API's field for the long-form description isn't always consistent
  // across product types - try the known possibilities in order, and fall
  // back to joining the bullet points so the field is never left blank
  // when the product actually has content to show.
  const bulletPoints = Array.isArray(data.about_product) ? data.about_product : [];
  const description =
    data.product_description ||
    data.editorial_reviews?.[0]?.content ||
    data.product_information?.description ||
    (bulletPoints.length ? bulletPoints.join('\n') : '');

  return {
    asin: data.asin || null,
    title: data.product_title || '',
    description,
    bulletPoints,
    images: allImages,
    price,
    currency: data.currency || 'USD',
    availability: data.product_availability || null,
    rating: data.product_star_rating ? parseFloat(data.product_star_rating) : null,
    ratingsTotal: data.product_num_ratings || null,
    brand: data.product_information?.Brand || data.brand || null,
    sourceUrl: sourceUrl || data.product_url || null,
    categories,
    specifications,
    variants,
  };
}

module.exports = { fetchProductByUrl, fetchProductByAsin, checkAvailabilityByAsin };
