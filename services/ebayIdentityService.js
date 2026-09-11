const axios = require('axios');
const { getAccessToken } = require('./ebayAuthService');

const { EBAY_API_BASE_URL: EBAY_BASE_URL } = require('../config/ebayEnvironment');

/**
 * Fetches the eBay username for the account behind a given refresh token,
 * using the Commerce Identity API. This is what lets us show a friendly
 * name (e.g. "sept19deals-au") for each of a user's connected eBay
 * accounts, instead of just an opaque token.
 */
async function fetchEbayUsername(refreshToken) {
  const accessToken = await getAccessToken(refreshToken);

  try {
    const response = await axios.get(`${EBAY_BASE_URL}/commerce/identity/v1/user/`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    });
    return response.data.username || null;
  } catch (err) {
    // Non-fatal - if this fails, the caller can fall back to a generic label.
    console.warn('Could not fetch eBay username:', err.response?.data || err.message);
    return null;
  }
}

module.exports = { fetchEbayUsername };
