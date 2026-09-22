const axios = require('axios');
const { retryWithBackoff } = require('./retryService');
const { extractAsinFromUrl, detectCountryFromUrl } = require('./canopyAmazonService');

const BULK_URL = 'https://bulk.easyparser.com/v1/bulk';
const DATA_URL = 'https://data.easyparser.com/v1/queries';

/**
 * Our internal country codes (see canopyAmazonService.detectCountryFromUrl) to the
 * dot-prefixed domain suffix Easyparser's API expects (".com", ".co.uk", ...).
 * Unmapped countries fall back to ".com".
 */
const COUNTRY_TO_EASYPARSER_DOMAIN = {
  US: '.com', GB: '.co.uk', CA: '.ca', DE: '.de', FR: '.fr', IT: '.it',
  ES: '.es', AU: '.com.au', IN: '.in', MX: '.com.mx', BR: '.com.br',
  JP: '.co.jp', NL: '.nl', SE: '.se', SG: '.sg', AE: '.ae', SA: '.sa', TR: '.com.tr',
};

function toEasyparserDomain(countryCode) {
  return COUNTRY_TO_EASYPARSER_DOMAIN[countryCode] || '.com';
}

function apiKey() {
  const key = process.env.EASYPARSER_API_KEY;
  if (!key) {
    const err = new Error('EASYPARSER_API_KEY is not set on the server.');
    err.statusCode = 503;
    throw err;
  }
  return key;
}

/**
 * Submits one bulk DETAIL job: one Easyparser "job object" per Amazon domain present in
 * `itemsByDomain` (each { domain: '.com', asins: ['B0...', ...] }), all sent in a single
 * POST (Easyparser accepts an array of job objects, up to 5,000 items total per request -
 * see https://easyparser.gitbook.io/easyparser-documentation/bulk-integration).
 *
 * callbackUrl is required by their schema, but ELMS actually polls the Data Service for
 * results instead of waiting on it (also documented as supported). routes/easyparserCallback.js
 * just answers 200 to whatever this URL points at, so Easyparser doesn't send "Webhook Error
 * Notification" emails after enough failed delivery attempts - the payload itself is unused.
 *
 * Returns { asin, domain, queryId, credit }[] for every ASIN Easyparser accepted, matched
 * back by the `asin` field on each returned result (falling back to array position if a
 * future API version ever omits it). ASINs Easyparser rejected (invalid, insufficient
 * credit, rate limited...) are returned separately in `rejected` with whatever reason text
 * is available - the exact shape of a rejected entry is not confirmed against a real
 * response yet, so this is read defensively and may need adjusting after a real test run.
 */
async function submitBulkDetail(itemsByDomain, callbackUrl) {
  const key = apiKey();
  const jobObjects = itemsByDomain
    .filter((group) => group.asins && group.asins.length)
    .map((group) => ({
      platform: 'AMZ',
      operation: 'DETAIL',
      domain: group.domain,
      payload: { asins: group.asins },
      callback_url: callbackUrl || String(process.env.BACKEND_URL || process.env.RENDER_EXTERNAL_URL || 'https://elms-backend-1-tr5h.onrender.com').replace(/\/$/, '') + '/api/easyparser/callback',
    }));
  if (!jobObjects.length) return { accepted: [], rejected: [], meta: null };

  let response;
  try {
    response = await retryWithBackoff(() =>
      axios.post(BULK_URL, jobObjects, {
        headers: { 'api-key': key, 'Content-Type': 'application/json' },
        timeout: 30000,
      })
    );
  } catch (err) {
    const message = err.response?.data?.message || err.message || 'The Easyparser bulk request failed.';
    const wrapped = new Error(message);
    wrapped.statusCode = err.response?.status || 500;
    throw wrapped;
  }

  const body = response.data || {};
  const accepted = [];
  const rejected = [];
  const acceptedGroups = Array.isArray(body.data?.accepted) ? body.data.accepted : [];
  for (const group of acceptedGroups) {
    const domain = group.domain;
    const results = Array.isArray(group.results) ? group.results : [];
    results.forEach((r, i) => {
      const asin = r.asin || (itemsByDomain.find((g) => g.domain === domain)?.asins || [])[i] || null;
      if (asin && r.id) accepted.push({ asin, domain, queryId: r.id, credit: r.credit ?? 1 });
    });
  }
  // Best-effort: every other top-level key under `data` (rejected/invalid/insufficient_credit/...)
  // is assumed to hold the same { domain, results: [{ asin, ...reason }] } shape as `accepted`.
  // Not confirmed against a live response - if the real shape differs, these ASINs simply won't
  // be recognized here and will instead silently stay "pending" until the job's own timeout marks
  // them failed, which is a safe (if slower) fallback.
  for (const [key2, groups] of Object.entries(body.data || {})) {
    if (key2 === 'accepted' || !Array.isArray(groups)) continue;
    for (const group of groups) {
      const results = Array.isArray(group.results) ? group.results : [];
      for (const r of results) {
        if (r.asin) rejected.push({ asin: r.asin, domain: group.domain, reason: r.message || r.reason || key2 });
      }
    }
  }

  return { accepted, rejected, meta: body.meta_data || null };
}

/**
 * Polls one query's result. Returns { status: 'pending' } while still processing,
 * { status: 'success', raw } with the parsed product once done, or
 * { status: 'failure', error } if Easyparser could not fetch it.
 */
async function pollResult(queryId) {
  const key = apiKey();
  let response;
  try {
    response = await axios.get(`${DATA_URL}/${encodeURIComponent(queryId)}/results`, {
      params: { format: 'json' },
      headers: { 'api-key': key },
      timeout: 20000,
    });
  } catch (err) {
    // A 404 here typically means the result already expired (results are only kept ~24h) -
    // treat that the same as a failure rather than retrying forever.
    const message = err.response?.data?.message || err.message || 'Could not reach Easyparser.';
    return { status: 'failure', error: message };
  }

  const data = response.data?.data || {};
  if (data.status === 'success') return { status: 'success', raw: data.json_result?.result || {} };
  if (data.status === 'failure') {
    const detail = data.json_result?.request_info?.error_details?.[0]?.message;
    return { status: 'failure', error: detail || 'Easyparser could not fetch this product.' };
  }
  return { status: 'pending' };
}

/** Pulls a usable URL out of an Easyparser image entry, whose exact key name isn't confirmed. */
function imageUrlOf(entry) {
  if (!entry) return null;
  if (typeof entry === 'string') return entry;
  return entry.link || entry.url || entry.src || entry.hi_res || entry.hires || entry.high_res
    || entry.large || entry.original || entry.full || entry.image_url || entry.src_url || null;
}

/** `raw.images` might not be a plain array (e.g. `{ list: [...] }` or `{ items: [...] }`) - try the common wrapper shapes too. */
function imagesArrayOf(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    for (const key of ['list', 'items', 'all', 'images', 'gallery']) {
      if (Array.isArray(value[key])) return value[key];
    }
  }
  return [];
}

/** Pulls a numeric price out of an Easyparser price object, whose exact key name isn't confirmed. */
function numberFrom(value) {
  if (value == null) return null;
  if (typeof value === 'number') return value;
  const n = Number(String(value).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalizes an Easyparser DETAIL result into the SAME shape
 * canopyAmazonService.normalizeProduct produces, so every caller downstream
 * (draft creation, the frontend) works unchanged regardless of provider.
 *
 * IMPORTANT: the sub-shapes of `images`, `buybox_winner.price`,
 * `buybox_winner.availability`, `specifications`, `attributes`, `categories` and
 * `variants` are taken from Easyparser's documentation field LIST (names + types),
 * not from a real response - the exact key names inside each object are not
 * confirmed. This reads them defensively (several likely key names per field) so a
 * live test run can be used to fix any that come back empty, without needing a
 * different shape for the rest of the app.
 */
function normalizeDetail(raw, sourceUrl) {
  const images = imagesArrayOf(raw.images).map(imageUrlOf).filter(Boolean);
  const mainImage = imageUrlOf(raw.main_image);
  const allImages = mainImage ? [mainImage, ...images.filter((u) => u !== mainImage)] : images;

  // TEMPORARY: only fires when 0-1 images came out, i.e. exactly the case we don't yet trust -
  // logs the raw shape once so it can be fixed for real from a live Render log, then removed.
  if (allImages.length <= 1 && raw && typeof raw === 'object') {
    try {
      console.warn('[easyparser-debug] only ' + allImages.length + ' image(s) extracted for asin ' + (raw.asin || '?')
        + '. raw.images=' + JSON.stringify(raw.images).slice(0, 1500)
        + ' raw.main_image=' + JSON.stringify(raw.main_image).slice(0, 500));
    } catch (e) { /* ignore logging failures */ }
  }

  const priceObj = raw.buybox_winner?.price || {};
  const price = numberFrom(priceObj.value ?? priceObj.amount ?? priceObj.current_price ?? priceObj.raw ?? priceObj);
  const currency = priceObj.currency || null;

  const availObj = raw.buybox_winner?.availability;
  const availText = typeof availObj === 'string' ? availObj : (availObj?.message || availObj?.status || availObj?.type || null);
  const inStock = typeof availObj === 'object' && availObj
    ? (availObj.in_stock ?? availObj.inStock ?? availObj.available ?? null)
    : (availText ? !/out of stock/i.test(availText) : null);

  const bulletPoints = Array.isArray(raw.feature_bullets) ? raw.feature_bullets.filter(Boolean) : [];
  const description = raw.description || (bulletPoints.length ? bulletPoints.join('\n') : '');

  const specSource = (Array.isArray(raw.specifications) && raw.specifications.length ? raw.specifications : raw.attributes) || [];
  const specifications = specSource
    .map((s) => ({ name: s.name || s.key || s.label || s.title, value: String(s.value ?? s.val ?? '').trim() }))
    .filter((s) => s.name && s.value);

  const categories = Array.isArray(raw.categories)
    ? raw.categories.map((c) => (typeof c === 'string' ? c : c.name || c.title)).filter(Boolean)
    : [];

  const variants = Array.isArray(raw.variants)
    ? raw.variants.map((v) => ({
        asin: v.asin,
        title: v.title || v.name || null,
        image: imageUrlOf(v.image) || imageUrlOf(v.thumbnail) || null,
        isCurrentProduct: v.asin === raw.asin,
        dimensions: [],
      }))
    : [];

  return {
    asin: raw.asin || null,
    title: raw.title || raw.title_excluding_variant_name || '',
    description,
    bulletPoints,
    images: allImages,
    price,
    currency: currency || 'USD',
    availability: inStock === false ? 'Out of Stock' : inStock === true ? 'In Stock' : availText || null,
    rating: raw.rating != null ? Number(raw.rating) : null,
    ratingsTotal: raw.ratings_total || null,
    brand: raw.brand || raw.manufacturer || null,
    sourceUrl: sourceUrl || raw.link || null,
    categories,
    specifications,
    variants,
  };
}

module.exports = {
  toEasyparserDomain,
  submitBulkDetail,
  pollResult,
  normalizeDetail,
  extractAsinFromUrl,
  detectCountryFromUrl,
};
