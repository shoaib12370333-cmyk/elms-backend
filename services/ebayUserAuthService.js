const axios = require('axios');

const AUTHORIZE_URL = 'https://auth.ebay.com/oauth2/authorize';
const TOKEN_URL = 'https://api.ebay.com/identity/v1/oauth2/token';

// Full scope list confirmed to work for this application (from eBay's own
// "Select OAuth Scopes" tool). A narrower list (just sell.inventory +
// sell.account) was returning "invalid_request" from eBay's authorize
// endpoint, so we request the complete set the application is eligible for.
const SCOPES = [
  'https://api.ebay.com/oauth/api_scope',
  'https://api.ebay.com/oauth/api_scope/sell.marketing.readonly',
  'https://api.ebay.com/oauth/api_scope/sell.marketing',
  'https://api.ebay.com/oauth/api_scope/sell.inventory.readonly',
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.account.readonly',
  'https://api.ebay.com/oauth/api_scope/sell.account',
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly',
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
  'https://api.ebay.com/oauth/api_scope/sell.analytics.readonly',
  'https://api.ebay.com/oauth/api_scope/sell.finances',
  'https://api.ebay.com/oauth/api_scope/sell.payment.dispute',
  'https://api.ebay.com/oauth/api_scope/commerce.identity.readonly',
  'https://api.ebay.com/oauth/api_scope/sell.reputation',
  'https://api.ebay.com/oauth/api_scope/sell.reputation.readonly',
  'https://api.ebay.com/oauth/api_scope/commerce.notification.subscription',
  'https://api.ebay.com/oauth/api_scope/commerce.notification.subscription.readonly',
  'https://api.ebay.com/oauth/api_scope/sell.stores',
  'https://api.ebay.com/oauth/api_scope/sell.stores.readonly',
  'https://api.ebay.com/oauth/scope/sell.edelivery',
  'https://api.ebay.com/oauth/api_scope/commerce.vero',
  'https://api.ebay.com/oauth/api_scope/sell.inventory.mapping',
  'https://api.ebay.com/oauth/api_scope/commerce.message',
  'https://api.ebay.com/oauth/api_scope/commerce.feedback',
  'https://api.ebay.com/oauth/api_scope/commerce.shipping',
  'https://api.ebay.com/oauth/api_scope/sell.listing',
  'https://api.ebay.com/oauth/api_scope/sell.listing.read',
  'https://api.ebay.com/oauth/api_scope/sell.cancellation.read',
  'https://api.ebay.com/oauth/api_scope/sell.cancellation',
  'https://api.ebay.com/oauth/api_scope/sell.return.read',
  'https://api.ebay.com/oauth/api_scope/sell.return',
  'https://api.ebay.com/oauth/api_scope/sell.inquiry',
  'https://api.ebay.com/oauth/api_scope/sell.inquiry.read',
  'https://api.ebay.com/oauth/api_scope/commerce.post_order.document',
].join(' ');

// Maps our marketplace IDs to the locale eBay's consent page should be
// shown in, so the OAuth "Grant Application Access" page matches the
// marketplace the user is about to sell on (e.g. shows ebay.co.uk-style
// branding/language for EBAY_GB). This does NOT change which eBay account
// they log into (there's only one eBay account, not one per marketplace) -
// it only affects what the consent page looks like.
const MARKETPLACE_TO_LOCALE = {
  EBAY_US: 'en-US',
  EBAY_GB: 'en-GB',
  EBAY_DE: 'de-DE',
  EBAY_FR: 'fr-FR',
  EBAY_IT: 'it-IT',
  EBAY_ES: 'es-ES',
  EBAY_CA: 'en-CA',
  EBAY_AU: 'en-AU',
  EBAY_NL: 'nl-NL',
  EBAY_CH: 'de-CH',
  EBAY_AT: 'de-AT',
  EBAY_BE: 'nl-BE',
  EBAY_IE: 'en-IE',
  EBAY_PL: 'pl-PL',
  EBAY_HK: 'zh-HK',
  EBAY_SG: 'en-SG',
  EBAY_MY: 'en-MY',
  EBAY_PH: 'en-PH',
};

/**
 * Builds the URL to send a user to, so they can log into their own eBay
 * account and grant ELMS permission to manage their listings.
 *
 * @param {string} state - a value we can use to identify which ELMS user is connecting
 *   (passed through by eBay and returned on the callback)
 * @param {string} [marketplaceId] - the user's chosen marketplace (e.g.
 *   "EBAY_GB"), used only to localize the consent page's language/branding
 */
function buildAuthorizationUrl(state, marketplaceId) {
  const clientId = process.env.EBAY_CLIENT_ID;
  const ruName = process.env.EBAY_RU_NAME; // the redirect "RuName" from developer.ebay.com > User Tokens

  if (!clientId || !ruName) {
    throw new Error('EBAY_CLIENT_ID or EBAY_RU_NAME is not set in the .env file.');
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: ruName,
    response_type: 'code',
    scope: SCOPES,
    state,
  });

  const locale = MARKETPLACE_TO_LOCALE[marketplaceId];
  if (locale) {
    params.append('locale', locale);
  }

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
