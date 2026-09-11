const axios = require('axios');

const BASE_URL = 'https://api.zippopotam.us';

/**
 * Looks up a place (city/state) for a given country code + postal code
 * using the free Zippopotam.us service. Returns null if the postal code
 * isn't found for that country (Zippopotam returns a 404 in that case).
 *
 * @param {string} countryCode - ISO 2-letter country code, e.g. "us", "gb"
 * @param {string} postalCode
 * @returns {Promise<{ placeName: string, state: string|null, countryName: string } | null>}
 */
async function lookupPostalCode(countryCode, postalCode) {
  try {
    const response = await axios.get(
      `${BASE_URL}/${encodeURIComponent(countryCode.toLowerCase())}/${encodeURIComponent(postalCode.trim())}`,
      { timeout: 8000 }
    );

    const data = response.data;
    const place = Array.isArray(data.places) && data.places.length ? data.places[0] : null;

    return {
      placeName: place?.['place name'] || null,
      state: place?.state || place?.['state abbreviation'] || null,
      countryName: data.country || null,
    };
  } catch (err) {
    if (err.response?.status === 404) return null; // postal code not found for this country
    const wrapped = new Error('Could not look up that postal code right now.');
    wrapped.statusCode = 502;
    throw wrapped;
  }
}

module.exports = { lookupPostalCode };
