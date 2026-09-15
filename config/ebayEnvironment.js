/**
 * Central switch between eBay's Production and Sandbox environments,
 * controlled by the EBAY_ENV env var ("production" [default] or
 * "sandbox"). Sandbox is eBay's free, fake-marketplace testing
 * environment - nothing published there is real or visible to real
 * buyers, which makes it the safe place to test ELMS's publish / stock
 * monitor / price monitor flows without touching a real eBay account.
 *
 * A separate eBay Developer keyset is required for Sandbox - EBAY_CLIENT_ID,
 * EBAY_CLIENT_SECRET and EBAY_RU_NAME must all be the SANDBOX versions of
 * those values (from developer.ebay.com > Application Keys, Sandbox tab)
 * whenever EBAY_ENV=sandbox. Production and Sandbox keysets are never
 * interchangeable - using a production keyset with EBAY_ENV=sandbox (or
 * vice versa) will fail auth.
 *
 * IMPORTANT: OAuth scope URIs (e.g.
 * "https://api.ebay.com/oauth/api_scope/sell.inventory", as used in
 * services/ebayAuthService.js and services/ebayUserAuthService.js) are
 * NOT part of this switch. eBay uses the exact same scope URI strings in
 * both environments - only which scopes are actually assigned to a given
 * keyset can differ, not the string itself - so those scope arrays must
 * stay as literal api.ebay.com URIs even when running against Sandbox.
 * Only the actual request hosts below (token endpoint, authorize page,
 * REST API base) change per environment.
 */
const isSandbox =
  String(process.env.EBAY_ENV || '').trim().toLowerCase() === 'sandbox' ||
  String(process.env.ELMS_TEST_MODE || '').trim().toLowerCase() === 'true';

const EBAY_API_BASE_URL = isSandbox ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com';
const EBAY_TOKEN_URL = `${EBAY_API_BASE_URL}/identity/v1/oauth2/token`;
const EBAY_AUTHORIZE_URL = isSandbox
  ? 'https://auth.sandbox.ebay.com/oauth2/authorize'
  : 'https://auth.ebay.com/oauth2/authorize';

module.exports = { isSandbox, EBAY_API_BASE_URL, EBAY_TOKEN_URL, EBAY_AUTHORIZE_URL };
