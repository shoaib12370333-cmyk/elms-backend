const axios = require('axios');
const { retryWithBackoff } = require('./retryService');
const { extractAsinFromUrl, detectCountryFromUrl } = require('./canopyAmazonService');
const { currencyForAmazonUrl, currencyForSuffix } = require('../config/amazonDomains');

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
 * The way the price currency is written in the request. Easyparser documents it as an ISO code in capitals in the bulk
 * request ("GBP") and in small letters in the real-time one ("usd"), and a request it does not like is refused as a whole with
 * "Bad request." - so the capitals go first, then the small letters, and if neither is taken the request goes without a currency
 * (the price is then put right by the import itself, see routes/fetchProduct.alignPriceCurrency). The way that was last accepted is
 * remembered, so one refused try is all it costs after a restart.
 */
const CURRENCY_MODES = ['upper', 'lower', 'none'];
let currencyModeIndex = 0;

function currencyFor(domain, mode) {
  const code = currencyForSuffix(domain);
  if (!code || mode === 'none') return null;
  return mode === 'lower' ? code.toLowerCase() : code;
}

function buildJobObjects(groups, callbackUrl, mode) {
  const callback = callbackUrl || String(process.env.BACKEND_URL || process.env.RENDER_EXTERNAL_URL || 'https://elms-backend-1-tr5h.onrender.com').replace(/\/$/, '') + '/api/easyparser/callback';
  return groups.map((group) => {
    const currency = currencyFor(group.domain, mode);
    return {
      platform: 'AMZ',
      operation: 'DETAIL',
      domain: group.domain,
      // Without "currency" Easyparser formats prices its own default way (USD): a 8.00 GBP product from amazon.co.uk came back as
      // ~10.70 "USD" and ended up on eBay as 12 GBP. Localization settings belong inside the payload (see the Bulk Service Request
      // page), and the price is asked for in the currency the Amazon site itself sells in.
      payload: { asins: group.asins, ...(currency ? { currency } : {}) },
      callback_url: callback,
    };
  });
}

/** The error of a refused request: Easyparser's own words, with the HTTP status. */
function bulkError(err) {
  const data = err.response?.data;
  const own = data && typeof data === 'object' ? (data.message || data.error) : null;
  const message = (typeof own === 'string' && own) || err.message || 'The Easyparser bulk request failed.';
  const wrapped = new Error(message);
  wrapped.statusCode = err.response?.status || err.statusCode || 500;
  wrapped.responseBody = data;
  return wrapped;
}

/** A whole request that Easyparser refuses as malformed: HTTP 400/422, or a 200 whose body says success:false. */
const isBadRequest = (err) => err && (err.statusCode === 400 || err.statusCode === 422);

/** Which ASINs of the request a rejected entry is about, from the (documented) shapes of every rejection kind. */
function rejectedAsins(kind, entry, jobObjects) {
  const asinsOfDomain = (domain) => jobObjects.filter((j) => j.domain === domain).flatMap((j) => j.payload.asins);
  const single = (p) => (p && (p.asin || (Array.isArray(p.asins) && p.asins[0]))) || null;
  // the shape of the first versions of this adapter: { domain, results: [{ asin, message }] }
  if (Array.isArray(entry.results) && entry.results.length) return entry.results.filter((r) => r.asin).map((r) => ({ asin: r.asin, domain: entry.domain, reason: r.message || r.reason || null }));
  if (kind === 'invalid') {
    // { message, instancePath: '/0/payload/asins/3', domain } - the index says which request object and which ASIN
    const m = /^\/(\d+)\/payload\/asins\/(\d+)/.exec(String(entry.instancePath || ''));
    if (m && jobObjects[m[1]]) { const a = jobObjects[m[1]].payload.asins[m[2]]; return a ? [{ asin: a, domain: jobObjects[m[1]].domain }] : []; }
    const g = /^\/(\d+)\//.exec(String(entry.instancePath || ''));
    const job = g && jobObjects[g[1]];
    const domain = job ? job.domain : entry.domain;
    return (job ? job.payload.asins : asinsOfDomain(entry.domain)).map((a) => ({ asin: a, domain }));
  }
  // failed: { payload: { asin }, domain }    rate_limit_exceeded / insufficient_credit: { message, payload: { domain, payload: { asin } } }
  const outer = entry.payload && entry.payload.payload ? entry.payload : entry;
  const asin = single(outer.payload) || single(entry.payload);
  return asin ? [{ asin, domain: outer.domain || entry.domain }] : [];
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
 * future API version ever omits it). Every other ASIN comes back in `rejected` with Easyparser's reason
 * ({ asin, domain, reason, retryable }): invalid ones, ones that failed on their side, and ones dropped for
 * the per-minute limit or for lack of credit on the Easyparser account (retryable: a later try can work).
 * The shapes follow the Bulk Service Response page.
 */
async function submitBulkDetail(itemsByDomain, callbackUrl) {
  const key = apiKey();
  const groups = itemsByDomain.filter((group) => group.asins && group.asins.length);
  if (!groups.length) return { accepted: [], rejected: [], meta: null };
  const asksForCurrency = groups.some((g) => currencyForSuffix(g.domain));

  let response;
  let jobObjects;
  let mode = asksForCurrency ? currencyModeIndex : CURRENCY_MODES.length - 1;
  for (;;) {
    jobObjects = buildJobObjects(groups, callbackUrl, CURRENCY_MODES[mode]);
    try {
      response = await retryWithBackoff(() =>
        axios.post(BULK_URL, jobObjects, {
          headers: { 'api-key': key, 'Content-Type': 'application/json' },
          timeout: 30000,
        })
      );
      if (response.data && response.data.success === false) {
        const refused = new Error(response.data.message || 'Bad request.');
        refused.statusCode = 400;
        refused.responseBody = response.data;
        throw refused;
      }
      break;
    } catch (err) {
      const wrapped = err.responseBody !== undefined ? err : bulkError(err);
      console.warn('[easyparser] bulk request refused (' + wrapped.statusCode + ', currency ' + CURRENCY_MODES[mode] + '): ' + wrapped.message
        + ' ' + JSON.stringify(wrapped.responseBody === undefined ? null : wrapped.responseBody).slice(0, 500));
      // Refused as a whole while it carried a currency: the currency is the only thing that was added to it, so try the next way to write it.
      if (isBadRequest(wrapped) && asksForCurrency && mode < CURRENCY_MODES.length - 1) { mode += 1; continue; }
      throw wrapped;
    }
  }
  if (asksForCurrency) currencyModeIndex = mode;

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
  // Everything else (data.invalid / failed / insufficient_credit / rate_limit_exceeded) comes back with its reason.
  let currencyRefused = false;
  for (const [kind, entries] of Object.entries(body.data || {})) {
    if (kind === 'accepted' || !Array.isArray(entries)) continue;
    for (const entry of entries) {
      const text = String(entry.message || entry.reason || '');
      const aboutCurrency = kind === 'invalid' && /currency/i.test(text + ' ' + String(entry.instancePath || ''));
      if (aboutCurrency) currencyRefused = true;
      const retryable = kind === 'rate_limit_exceeded' || kind === 'insufficient_credit' || aboutCurrency;
      const reason = kind === 'failed' ? 'Easyparser could not process this product (a problem on their side). Try again.'
        : kind === 'insufficient_credit' ? 'The Easyparser account has no credit left for this product.'
        : text || kind;
      for (const r of rejectedAsins(kind, entry, jobObjects)) rejected.push({ asin: r.asin, domain: r.domain, reason: r.reason || reason, retryable });
    }
  }
  // The currency was refused for single items: the next try writes it the next way (or leaves it out).
  if (currencyRefused && currencyModeIndex < CURRENCY_MODES.length - 1) currencyModeIndex += 1;

  return { accepted, rejected, meta: body.meta_data || null };
}

/** Test hook: forget which way of writing the currency was accepted. */
function resetCurrencyMode() { currencyModeIndex = 0; }

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
  if (data.status === 'success') {
    const result = data.json_result?.result || {};
    // Documented as result.detail; the bulk data service has been seen returning the product one level up.
    const detail = result.detail && typeof result.detail === 'object' && !Array.isArray(result.detail) ? result.detail : result;
    return { status: 'success', raw: detail };
  }
  if (data.status === 'failure') {
    const detail = data.json_result?.request_info?.error_details?.[0]?.message;
    return { status: 'failure', error: detail || 'Easyparser could not fetch this product.' };
  }
  return { status: 'pending' };
}

/** Pulls a usable URL out of an Easyparser image entry ({ link, variant } in the documentation). */
function imageUrlOf(entry) {
  if (!entry) return null;
  if (typeof entry === 'string') return entry;
  return entry.link || entry.url || entry.src || entry.hi_res || entry.hires || entry.high_res
    || entry.large || entry.original || entry.full || entry.image_url || entry.src_url || null;
}

/**
 * A full https link for an Amazon picture. Easyparser's `main_image.link` is documented as only the image ID
 * (e.g. "617ecXxEdeL"), which is not a URL and used to end up as the first "image" of every product.
 */
function amazonImageUrl(value) {
  const v = String(value || '').trim();
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) return v;
  if (/^\/\//.test(v)) return 'https:' + v;
  if (/^[A-Za-z0-9+_-]{8,20}$/.test(v)) return 'https://m.media-amazon.com/images/I/' + v + '.jpg';
  return null;
}

/**
 * The original-size picture: Amazon's resize part (._AC_SL1500_ / ._SX679_) is dropped, so one picture that comes in two
 * sizes counts once, and eBay gets the big file.
 */
function fullSizeImage(url) {
  return String(url).replace(/\._[A-Za-z0-9,_%-]+_(?=\.(?:jpe?g|png|webp)(?:$|[?#]))/i, '');
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

/** All of a product's pictures, the MAIN one first, at full size, each once. */
function collectImages(raw) {
  const entries = imagesArrayOf(raw.images);
  const isMain = (e) => e && typeof e === 'object' && String(e.variant || '').toUpperCase() === 'MAIN';
  const ordered = [...entries.filter(isMain), ...entries.filter((e) => !isMain(e))];
  const listed = ordered.map((e) => amazonImageUrl(imageUrlOf(e))).filter(Boolean).map(fullSizeImage);
  const idOf = (u) => (String(u).match(/\/images\/I\/([^./]+)/) || [])[1] || u;
  // main_image is only an id: when the list has that picture (with its real file extension) it goes first from there,
  // and when the list does not have it, the id's own link is put first.
  let urls = listed;
  const mainLink = amazonImageUrl(imageUrlOf(raw.main_image));
  if (mainLink) {
    const main = fullSizeImage(mainLink);
    const at = listed.findIndex((u) => idOf(u) === idOf(main));
    urls = at >= 0 ? [listed[at], ...listed.filter((_, i) => i !== at)] : [main, ...listed];
  }
  const seen = new Set();
  return urls.filter((u) => { const k = idOf(u); if (seen.has(k)) return false; seen.add(k); return true; });
}

/** Pulls a numeric price out of an Easyparser price object, whose exact key name isn't confirmed. */
function numberFrom(value) {
  if (value == null) return null;
  if (typeof value === 'number') return value;
  const n = Number(String(value).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

const pairsOf = (list) => (Array.isArray(list) ? list : [])
  .map((s) => ({ name: String(s.name || s.key || s.label || s.title || '').trim(), value: String(s.value ?? s.val ?? '').trim() }))
  .filter((s) => s.name && s.value);

/**
 * Normalizes an Easyparser DETAIL result into the SAME shape
 * canopyAmazonService.normalizeProduct produces, so every caller downstream
 * (draft creation, the frontend) works unchanged regardless of provider.
 *
 * The field shapes follow Easyparser's DETAIL response documentation:
 *   images[]            { link, variant: MAIN | SIDE | BACK | PT01 ... }
 *   main_image          { link }   - the image ID only, not a URL
 *   variants[]          { asin, title, is_current_product, link, dimensions: [{ name, value }] }   - no picture per variant
 *   specifications[]    { name, value }    attributes[]  { name, value }
 *   buybox_winner       { price: { value, currency }, availability: { raw, min_quantity } }
 */
function normalizeDetail(raw, sourceUrl) {
  const allImages = collectImages(raw);

  // Only fires when 0-1 images came out, so a live Render log shows what Easyparser really sent.
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
  const availText = typeof availObj === 'string' ? availObj : (availObj?.raw || availObj?.message || availObj?.status || availObj?.type || null);
  const inStock = typeof availObj === 'object' && availObj && (availObj.in_stock ?? availObj.inStock ?? availObj.available) != null
    ? (availObj.in_stock ?? availObj.inStock ?? availObj.available)
    : (availText ? !/out of stock|unavailable/i.test(availText) : null);

  const bulletPoints = Array.isArray(raw.feature_bullets) ? raw.feature_bullets.filter(Boolean) : [];
  const description = raw.description || (bulletPoints.length ? bulletPoints.join('\n') : '');

  // Technical specifications and the overview attributes are two lists on the page: keep both, each name once.
  const specifications = [];
  const have = new Set();
  const add = (name, value) => {
    const key = String(name).toLowerCase();
    if (!name || !String(value || '').trim() || have.has(key)) return;
    have.add(key);
    specifications.push({ name: String(name), value: String(value).trim() });
  };
  [...pairsOf(raw.specifications), ...pairsOf(raw.attributes)].forEach((sp) => add(sp.name, sp.value));
  // Facts that come as plain fields: they also feed the package weight / size for calculated shipping.
  add('Manufacturer', raw.manufacturer);
  add('Color', raw.color);
  add('Item Weight', raw.weight);
  add('Shipping Weight', raw.shipping_weight);
  add('Product Dimensions', raw.dimensions);
  add('Item model number', raw.model_number);

  const categories = Array.isArray(raw.categories)
    ? raw.categories.map((c) => (typeof c === 'string' ? c : c.name || c.title)).filter(Boolean)
    : [];

  const variants = Array.isArray(raw.variants)
    ? raw.variants.filter((v) => v && v.asin).map((v) => {
        const dimensions = pairsOf(v.dimensions);
        return {
          asin: v.asin,
          title: v.title || v.name || dimensions.map((d) => d.value).join(' ') || null,
          image: amazonImageUrl(imageUrlOf(v.image) || imageUrlOf(v.main_image) || imageUrlOf(v.thumbnail)) || null,
          isCurrentProduct: v.is_current_product === true || v.asin === raw.asin,
          dimensions,
          link: v.link || null,
        };
      })
    : [];

  return {
    asin: raw.asin || null,
    title: raw.title || raw.title_excluding_variant_name || '',
    description,
    bulletPoints,
    images: allImages,
    price,
    currency: currency || currencyForAmazonUrl(sourceUrl || raw.link) || 'USD',
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
  resetCurrencyMode,
  pollResult,
  normalizeDetail,
  extractAsinFromUrl,
  detectCountryFromUrl,
};
