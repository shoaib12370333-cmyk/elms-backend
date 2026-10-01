/**
 * ONE-OFF, owner-run setup step - not something ELMS calls on its own, ever.
 *
 * Generates the single ED25519 signing keypair that services/ebayDigitalSignatureService.js needs to add a digital
 * signature to every eBay Finances API call, required by eBay for an EU/UK-domiciled seller's data
 * (https://developer.ebay.com/develop/guides/sell/digital-signatures-for-apis). One keypair covers every seller:
 * the signature authenticates THIS APPLICATION's calls, not any particular seller's own authorization, so this never
 * needs to run again per seller - only once per application keyset (EBAY_CLIENT_ID/EBAY_CLIENT_SECRET in .env), and
 * again only if the keypair's own expiry (see the printed "expires" below) is reached or the private key is lost -
 * eBay does not store it, so losing it means running this again.
 *
 * Usage (needs a real EBAY_CLIENT_ID/EBAY_CLIENT_SECRET in .env, the same ones the running server uses):
 *   node scripts/createEbaySigningKey.js
 *
 * Prints the two env vars to add in Render (Dashboard -> elms-backend-1 -> Environment):
 *   EBAY_SIGNING_KEY_JWE
 *   EBAY_SIGNING_KEY_PRIVATE
 * Nothing is saved to disk or committed anywhere by this script - copy the values directly from the console output.
 */
require('dotenv').config();
const axios = require('axios');
const { getAppAccessToken } = require('../services/ebayAuthService');
const { EBAY_FINANCES_BASE_URL } = require('../config/ebayEnvironment'); // apiz.ebay.com - same host as Key Management

(async () => {
  const accessToken = await getAppAccessToken();
  const response = await axios.post(
    `${EBAY_FINANCES_BASE_URL}/developer/key_management/v1/signing_key`,
    { signingKeyCipher: 'ED25519' },
    { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
  );
  const { jwe, privateKey, signingKeyId, expirationTime } = response.data;

  console.log('\nSigning key created (keyId: ' + signingKeyId + ').');
  console.log('Expires: ' + (expirationTime ? new Date(Number(expirationTime) * 1000).toISOString() : 'not given') + ' - regenerate before then by running this script again.\n');
  console.log('Add these two environment variables in Render, then redeploy:\n');
  console.log('EBAY_SIGNING_KEY_JWE=' + jwe + '\n');
  console.log('EBAY_SIGNING_KEY_PRIVATE=' + privateKey + '\n');
  console.log('(Render\'s Environment tab accepts a multi-line value for EBAY_SIGNING_KEY_PRIVATE directly - paste the PEM exactly as printed above, including the BEGIN/END lines.)');
})().catch((err) => {
  console.error('Could not create a signing key:', err.response?.data || err.message);
  process.exit(1);
});
