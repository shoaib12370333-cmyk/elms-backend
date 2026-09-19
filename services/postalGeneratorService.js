const axios = require('axios');
const { lookupPostalCode } = require('./postalCodeService');

/**
 * Generates a REAL, existing postal code for a city in one of the countries
 * ELMS supports as an eBay marketplace. Nothing here is random or invented:
 *
 *   1. The city is geocoded with OpenStreetMap Nominatim.
 *   2. The postal code of an actual address at that spot is read back with a
 *      reverse geocode (GB uses postcodes.io, which returns a full, valid
 *      Royal Mail postcode such as "SW1A 2DX").
 *   3. Where Zippopotam.us covers the country the code is verified against it;
 *      a code that fails verification is discarded and another nearby address
 *      is tried instead.
 */

const NOMINATIM = 'https://nominatim.openstreetmap.org';
const USER_AGENT = process.env.POSTAL_LOOKUP_USER_AGENT || 'ELMS/1.0 (eBay listing tool; postal code generator)';

// eBay marketplace country -> ISO code, plus the format a full postal code must match.
const COUNTRIES = Object.freeze({
  US: { name: 'United States', format: /^\d{5}(-\d{4})?$/ },
  GB: { name: 'United Kingdom', format: /^[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}$/ },
  DE: { name: 'Germany', format: /^\d{5}$/ },
  FR: { name: 'France', format: /^\d{5}$/ },
  IT: { name: 'Italy', format: /^\d{5}$/ },
  ES: { name: 'Spain', format: /^\d{5}$/ },
  CA: { name: 'Canada', format: /^[A-Z]\d[A-Z] ?\d[A-Z]\d$/ },
  AU: { name: 'Australia', format: /^\d{4}$/ },
  NL: { name: 'Netherlands', format: /^\d{4} ?[A-Z]{2}$/ },
  CH: { name: 'Switzerland', format: /^\d{4}$/ },
  AT: { name: 'Austria', format: /^\d{4}$/ },
  BE: { name: 'Belgium', format: /^\d{4}$/ },
  IE: { name: 'Ireland', format: /^[A-Z]\d{2} ?[A-Z\d]{4}$/ },
  PL: { name: 'Poland', format: /^\d{2}-\d{3}$/ },
  HK: { name: 'Hong Kong', format: null, noPostalCodes: true },
  SG: { name: 'Singapore', format: /^\d{6}$/ },
  MY: { name: 'Malaysia', format: /^\d{5}$/ },
  PH: { name: 'Philippines', format: /^\d{4}$/ },
});

// Countries Zippopotam.us can verify a code for, and how to key the lookup.
const VERIFY_KEY = {
  US: (c) => c.slice(0, 5),
  CA: (c) => c.replace(/\s/g, '').slice(0, 3),
  GB: (c) => c.split(' ')[0],
  NL: (c) => c.replace(/\D/g, '').slice(0, 4),
  AU: (c) => c, DE: (c) => c, FR: (c) => c, IT: (c) => c, ES: (c) => c,
  CH: (c) => c, AT: (c) => c, BE: (c) => c, PL: (c) => c, MY: (c) => c, PH: (c) => c,
};

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map();

// Nominatim's usage policy allows at most one request per second.
let lastNominatimAt = 0;
let nominatimQueue = Promise.resolve();
function throttledNominatim(path, params) {
  const run = async () => {
    const wait = Math.max(0, lastNominatimAt + 1100 - Date.now());
    if (wait) await new Promise((r) => setTimeout(r, wait));
    lastNominatimAt = Date.now();
    const res = await axios.get(`${NOMINATIM}${path}`, {
      params: { format: 'jsonv2', addressdetails: 1, 'accept-language': 'en', ...params },
      headers: { 'User-Agent': USER_AGENT },
      timeout: 12000,
    });
    return res.data;
  };
  const result = nominatimQueue.then(run, run);
  nominatimQueue = result.catch(() => {});
  return result;
}

function httpError(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function normalizeCountry(value) {
  let code = String(value || '').trim().toUpperCase();
  if (code === 'UK') code = 'GB';
  if (!COUNTRIES[code]) throw httpError(`Postal codes are not available for "${value}".`, 400);
  return code;
}

/** Cleans a raw postcode string into the country's canonical form, or returns null if it does not look valid. */
function cleanPostalCode(cc, raw) {
  const rule = COUNTRIES[cc];
  if (!rule || !rule.format || !raw) return null;
  let code = String(raw).split(/[;,]/)[0].trim().toUpperCase();
  if (cc === 'US') {
    code = code.slice(0, 5);
    // OSM tags some city-hall buildings with a placeholder ZIP such as 10000 that is not a normal delivery ZIP.
    if (/^[0-9]{2}000$/.test(code)) return null;
  }
  if (cc === 'CA' || cc === 'GB' || cc === 'NL' || cc === 'IE') code = code.replace(/\s+/g, '');
  if (!rule.format.test(cc === 'US' ? code : (cc === 'CA' || cc === 'GB' || cc === 'NL' || cc === 'IE') ? spaced(cc, code) : code)) return null;
  return (cc === 'CA' || cc === 'GB' || cc === 'NL' || cc === 'IE') ? spaced(cc, code) : code;
}

function spaced(cc, compact) {
  const c = compact.replace(/\s+/g, '');
  if (cc === 'CA') return `${c.slice(0, 3)} ${c.slice(3)}`;
  if (cc === 'GB') return `${c.slice(0, -3)} ${c.slice(-3)}`;
  if (cc === 'NL') return `${c.slice(0, 4)} ${c.slice(4)}`;
  if (cc === 'IE') return c.length === 7 ? `${c.slice(0, 3)} ${c.slice(3)}` : c;
  return c;
}

/** true = confirmed real, false = confirmed NOT real, null = could not be checked. */
async function verifyPostalCode(cc, code) {
  const key = VERIFY_KEY[cc];
  if (!key) return null;
  try {
    const found = await lookupPostalCode(cc, key(code));
    return !!found;
  } catch (_) {
    return null;
  }
}

async function geocodeCity(cc, city, state) {
  const structured = { city, countrycodes: cc.toLowerCase(), limit: 5 };
  if (state) structured.state = state;
  let results = await throttledNominatim('/search', structured);
  if (!results.length) {
    results = await throttledNominatim('/search', { q: [city, state, COUNTRIES[cc].name].filter(Boolean).join(', '), countrycodes: cc.toLowerCase(), limit: 5 });
  }
  const hit = results.find((r) => r.lat && r.lon);
  if (!hit) return null;
  const a = hit.address || {};
  return {
    lat: Number(hit.lat),
    lon: Number(hit.lon),
    city: a.city || a.town || a.village || a.municipality || a.suburb || hit.name || city,
    state: a.state || a.region || a.county || null,
    postcode: a.postcode || null,
  };
}

async function reversePostcode(lat, lon) {
  const data = await throttledNominatim('/reverse', { lat, lon, zoom: 18 });
  return { postcode: data?.address?.postcode || null, address: data?.address || null };
}

async function nearestUkPostcode(lat, lon) {
  for (const radius of [500, 2000, 5000]) {
    try {
      const res = await axios.get('https://api.postcodes.io/postcodes', { params: { lon, lat, limit: 1, radius }, timeout: 10000 });
      const hit = res.data?.result?.[0];
      if (hit?.postcode) return { postcode: hit.postcode, city: hit.admin_district || hit.parish || null, state: hit.region || hit.country || null };
    } catch (_) { /* try a wider radius */ }
  }
  return null;
}

/**
 * @param {string} country ISO code (US, GB/UK, DE ...)
 * @param {string} city    e.g. "New York"
 * @param {string} [state] optional state/region to disambiguate ("Georgia" the state vs the country)
 */
async function generatePostalCode(country, city, state) {
  const cc = normalizeCountry(country);
  const cityName = String(city || '').trim();
  if (COUNTRIES[cc].noPostalCodes) {
    return { country: cc, countryName: COUNTRIES[cc].name, city: cityName || null, state: null, postalCode: null, notRequired: true, source: 'none' };
  }
  if (cityName.length < 2) throw httpError('Enter a city name first.', 400);

  const cacheKey = `${cc}|${cityName.toLowerCase()}|${String(state || '').toLowerCase()}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  let place;
  try {
    place = await geocodeCity(cc, cityName, state ? String(state).trim() : '');
  } catch (err) {
    throw httpError('The postal code service is busy right now. Please try again in a moment.', 502);
  }
  if (!place) throw httpError(`Could not find "${cityName}" in ${COUNTRIES[cc].name}. Check the spelling or add the state/region.`, 404);

  let result = null;

  if (cc === 'GB') {
    const uk = await nearestUkPostcode(place.lat, place.lon);
    if (uk) {
      result = { postalCode: uk.postcode, city: place.city, state: uk.state || place.state, source: 'postcodes.io' };
    }
  }

  if (!result) {
    // The city centre, then a few nearby points, until one yields a code that
    // has the right format and (where checkable) really exists.
    // A city's own OSM record often carries a placeholder code (e.g. "10000" for
    // New York), so the code is always read from a real address instead.
    const offsets = [[0, 0], [0.008, 0], [0, 0.008], [-0.008, 0], [0, -0.008]];
    let unverified = null;
    for (const [dLat, dLon] of offsets) {
      let rev;
      try { rev = await reversePostcode(place.lat + dLat, place.lon + dLon); } catch (_) { continue; }
      const code = cleanPostalCode(cc, rev.postcode);
      if (!code) continue;
      const verified = await verifyPostalCode(cc, code);
      const state = rev.address?.state || place.state;
      if (verified === true) {
        result = { postalCode: code, city: place.city, state, source: 'openstreetmap+verified' };
        break;
      }
      if (verified === null && !unverified) unverified = { postalCode: code, city: place.city, state, source: 'openstreetmap' };
    }
    if (!result && unverified) result = unverified;
  }

  if (!result) throw httpError(`No valid postal code could be found for "${cityName}". Try a larger nearby city.`, 404);

  const value = {
    country: cc,
    countryName: COUNTRIES[cc].name,
    city: result.city || cityName,
    state: result.state || null,
    postalCode: result.postalCode,
    latitude: place.lat,
    longitude: place.lon,
    source: result.source,
  };
  cache.set(cacheKey, { at: Date.now(), value });
  return value;
}

module.exports = { generatePostalCode, cleanPostalCode, normalizeCountry, COUNTRIES };
