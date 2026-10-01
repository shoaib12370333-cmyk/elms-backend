const { generateSignatureInput, generateSignature } = require('digital-signature-nodejs-sdk');

/**
 * eBay requires a digital signature (RFC 9421 HTTP Message Signatures) on every call to certain APIs - "All methods
 * in the Finances API" among them (https://developer.ebay.com/develop/guides/sell/digital-signatures-for-apis) -
 * when the call is made on behalf of an EU- or UK-domiciled seller. Without it, eBay's own error is 215001 "Missing
 * x-ebay-signature-key header" (confirmed 2026-10-02 against a real UK seller account: every Finances API call for
 * that store failed this way, forever, since nothing here ever added the header). eBay ignores the signature
 * entirely for a seller it is not required for, so it is simplest and safest to add it to every call an in-scope
 * API makes, regardless of the seller's own marketplace, rather than trying to detect which sellers are EU/UK-
 * domiciled ourselves.
 *
 * The signing keypair is generated ONCE via eBay's Key Management API (scripts/createEbaySigningKey.js - an
 * owner-run, one-off setup step against real eBay credentials, never something ELMS does on its own) and stored as
 * two env vars:
 *   EBAY_SIGNING_KEY_JWE     - the ready-made "Public Key as JWE" value, used as-is for x-ebay-signature-key
 *   EBAY_SIGNING_KEY_PRIVATE - the PEM private key, used to compute the Signature header
 * Until both are set, signedHeaders() returns {} and an in-scope call simply fails for an EU/UK seller exactly as it
 * did before this file existed - never a half-signed request.
 */
function signingConfigured() {
  return !!(process.env.EBAY_SIGNING_KEY_JWE && process.env.EBAY_SIGNING_KEY_PRIVATE);
}

// eBay's createSigningKey response gives privateKey as BARE base64 (confirmed 2026-10-02 against the docs' own
// sample response and a real key: "MC4CAQAwBQYDK2VwB..." - the fixed PKCS8/Ed25519 DER prefix - with no
// "-----BEGIN PRIVATE KEY-----" wrapper at all), not a PEM. On top of that, a pasted PEM (if one is ever provided
// instead) commonly arrives mangled anyway - a host's env var box collapsing it to one line (BEGIN/END markers
// glued directly onto the base64 body), a literal "\n" escape instead of a real newline, or Windows CRLF - and
// Node's crypto rejects any of this with the unhelpful "error:1E08010C:DECODER routines::unsupported" rather than
// anything mentioning a newline or a missing header. Rebuilding a clean PEM from whatever is actually in the env
// var - with or without existing BEGIN/END markers, wherever the newlines did or didn't end up - is robust to all
// of this at once, instead of guessing which single shape a given value is in.
function privateKeyPem() {
  const raw = String(process.env.EBAY_SIGNING_KEY_PRIVATE || '').replace(/\\n/g, '\n');
  const match = raw.match(/-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/);
  const label = match ? match[1] : 'PRIVATE KEY'; // eBay's own key is PKCS8, whose standard PEM label is "PRIVATE KEY"
  const body = match ? match[2] : raw;
  const base64 = body.replace(/\s+/g, '');
  const wrapped = base64.match(/.{1,64}/g) || [];
  return `-----BEGIN ${label}-----\n${wrapped.join('\n')}\n-----END ${label}-----\n`;
}

/**
 * The headers eBay needs for one in-scope GET call with no request body - Content-Digest is only required when a
 * payload is sent (RFC9530), so it is left out here; a signed POST/PUT would need to add it the same way
 * (digital-signature-nodejs-sdk's own generateDigestHeader), in the signatureParams array below, and before
 * generateSignatureInput.
 * @returns {Promise<object>} the 3 headers to merge into the request, or {} when no signing key is configured.
 */
async function signedHeaders({ method, path, host }) {
  if (!signingConfigured()) return {};
  const config = {
    privateKey: privateKeyPem(),
    signatureComponents: { method, authority: host, path },
    signatureParams: ['x-ebay-signature-key', '@method', '@path', '@authority'],
  };
  const headers = {};
  headers['signature-input'] = generateSignatureInput(headers, config);
  headers['x-ebay-signature-key'] = process.env.EBAY_SIGNING_KEY_JWE;
  headers['signature'] = generateSignature(headers, config);
  return headers;
}

module.exports = { signedHeaders, signingConfigured };
