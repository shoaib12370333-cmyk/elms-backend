const axios = require('axios');
const crypto = require('crypto');
const { getAppAccessToken } = require('./ebayAuthService');
const { EBAY_API_BASE_URL: EBAY_BASE_URL } = require('../config/ebayEnvironment');

// eBay recommends caching a public key for about an hour rather than
// fetching it on every notification, to avoid unnecessary API call volume.
const PUBLIC_KEY_CACHE_TTL_MS = 60 * 60 * 1000;
const publicKeyCache = new Map(); // keyId -> { key, fetchedAt }

function normalizePublicKeyPem(publicKey) {
  const raw = typeof publicKey === 'object' && publicKey !== null
    ? (publicKey.key || publicKey.publicKey || publicKey.pem || '')
    : publicKey;
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error('eBay public key response did not contain a usable key.');
  }

  const key = raw.trim();
  const begin = '-----BEGIN PUBLIC KEY-----';
  const end = '-----END PUBLIC KEY-----';

  // Already valid PEM: normalize line endings only.
  if (key.includes(begin) && key.includes(end)) {
    const body = key
      .replace(begin, '')
      .replace(end, '')
      .replace(/\s+/g, '');
    if (!body) throw new Error('eBay public key body is empty.');
    return `${begin}\n${body.match(/.{1,64}/g).join('\n')}\n${end}`;
  }

  // Some responses provide only the base64 DER body.
  const body = key.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/=]+$/.test(body)) {
    throw new Error('eBay public key format is invalid.');
  }
  return `${begin}\n${body.match(/.{1,64}/g).join('\n')}\n${end}`;
}

/**
 * Fetches (and caches) the eBay public key for a given key ID, used to
 * verify the X-EBAY-SIGNATURE header on incoming notifications.
 */
async function getPublicKey(keyId) {
  const cached = publicKeyCache.get(keyId);
  if (cached && Date.now() - cached.fetchedAt < PUBLIC_KEY_CACHE_TTL_MS) {
    return cached.key;
  }

  const accessToken = await getAppAccessToken();
  const response = await axios.get(`${EBAY_BASE_URL}/commerce/notification/v1/public_key/${encodeURIComponent(keyId)}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: 10000,
  });

  const key = response.data.key;
  publicKeyCache.set(keyId, { key, fetchedAt: Date.now() });
  return key;
}

/**
 * Verifies an eBay notification's X-EBAY-SIGNATURE header against its raw
 * body, following eBay's documented verification process:
 *
 *   1. The header is base64-decoded to reveal a JSON object containing
 *      the algorithm, the public key ID ("kid"), and the signature itself.
 *   2. The public key for that key ID is fetched (with caching).
 *   3. The signature is verified against the raw request body using
 *      ECDSA - eBay's current notifications use the P-256 curve with
 *      SHA-1, per their documented Java example.
 *
 * @param {Buffer|string} rawBody - the raw (unparsed) request body
 * @param {string} signatureHeader - the "x-ebay-signature" request header
 * @returns {Promise<boolean>} true if the signature is valid
 */
async function verifyEbaySignature(rawBody, signatureHeader) {
  if (!signatureHeader) return false;

  let decodedHeader;
  try {
    decodedHeader = JSON.parse(Buffer.from(signatureHeader, 'base64').toString('utf8'));
  } catch {
    return false;
  }

  const { kid: keyId, signature } = decodedHeader;
  if (!keyId || !signature) return false;

  try {
    const publicKey = await getPublicKey(keyId);

    // eBay's Notification API can return the public key as a single-line
    // PEM-like string. Node/OpenSSL expects the PEM boundaries and the
    // base64 body to be separated by newlines. The official eBay Node SDK
    // applies the same normalization before calling crypto.verify().
    const publicKeyPem = normalizePublicKeyPem(publicKey);
    const signatureBuffer = Buffer.from(signature, 'base64');
    const bodyBuffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');

    // eBay's own official Node.js SDK (event-notification-nodejs-sdk) verifies
    // with the OpenSSL digest name 'ssl3-sha1', not the more common 'SHA1'
    // alias. On Node 22 / OpenSSL 3, using the 'SHA1' name here reliably
    // throws "error:1E08010C:DECODER routines::unsupported" while verifying
    // an EC (P-256) public key - 'ssl3-sha1' is the name that actually works
    // against eBay's keys. Try it first, and fall back to 'SHA1' only if the
    // runtime doesn't recognize that digest name at all (so this still works
    // in environments where 'ssl3-sha1' isn't registered).
    const algorithms = ['ssl3-sha1', 'SHA1'];
    let lastErr = null;
    for (const algorithm of algorithms) {
      try {
        const verifier = crypto.createVerify(algorithm);
        verifier.update(bodyBuffer);
        verifier.end();
        return verifier.verify(publicKeyPem, signatureBuffer);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  } catch (err) {
    console.error('[ebay-signature] Verification failed:', err.message, '| keyId:', decodedHeader?.kid);
    return false;
  }
}

module.exports = { verifyEbaySignature };
