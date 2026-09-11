const axios = require('axios');
const { EBAY_AUTHORIZE_URL, EBAY_TOKEN_URL } = require('../config/ebayEnvironment');

const AUTHORIZE_URL = EBAY_AUTHORIZE_URL;
const TOKEN_URL = EBAY_TOKEN_URL;

const SCOPES = [
  'https://api.ebay.com/oauth/api_scope',
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.account',
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
  'https://api.ebay.com/oauth/api_scope/commerce.identity.readonly',
  'https://api.ebay.com/oauth/api_scope/commerce.message',
  'https://api.ebay.com/oauth/api_scope/commerce.notification.subscription',
];

function buildAuthorizationUrl(state, locale) {
  const params = new URLSearchParams();
  params.append('client_id', process.env.EBAY_CLIENT_ID || '');
  params.append('redirect_uri', process.env.EBAY_RU_NAME || '');
  params.append('response_type', 'code');
  params.append('scope', SCOPES.join(' '));
  if (state) params.append('state', state);
  if (locale) params.append('locale', locale);
  // Force eBay to show the account login/selection screen. This is important
  // when an ELMS user connects a second eBay account in the same browser,
  // otherwise eBay can silently reuse the already-signed-in first account.
  params.append('prompt', 'login');
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

/**
 * Exchanges the authorization code (received on the redirect callback)
 * for the user's access token and refresh token.
 *
 * @param {string} code - the "code" query param eBay sent back
 * @returns {Promise<{ refreshToken: string, expiresIn: number }>}
 */
async function exchangeCodeForToken(code) {
  const clientId = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;
  const ruName = process.env.EBAY_RU_NAME;

  if (!clientId || !clientSecret || !ruName) {
    throw new Error('eBay credentials are not fully set in the .env file.');
  }

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const params = new URLSearchParams();
  params.append('grant_type', 'authorization_code');
  params.append('code', code);
  params.append('redirect_uri', ruName);

  let response;
  try {
    response = await axios.post(TOKEN_URL, params, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basicAuth}`,
      },
      timeout: 15000,
    });
  } catch (err) {
    const message =
      err.response?.data?.error_description ||
      err.response?.data?.error ||
      'Could not exchange the authorization code for a token.';
    const wrapped = new Error(message);
    wrapped.statusCode = err.response?.status || 500;
    throw wrapped;
  }

  return {
    refreshToken: response.data.refresh_token,
    expiresIn: response.data.refresh_token_expires_in, // seconds (refresh tokens last ~18 months)
  };
}

module.exports = { buildAuthorizationUrl, exchangeCodeForToken };
