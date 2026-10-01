// services/ebayDigitalSignatureService.js: the 3 headers eBay's "Digital Signatures for APIs" requires on an
// in-scope GET call (https://developer.ebay.com/develop/guides/sell/digital-signatures-for-apis), generated with
// eBay's own digital-signature-nodejs-sdk - verified here with a real, locally-generated ED25519 keypair by running
// the full round trip through that same SDK's own validateSignatureHeader, not just checking header shapes.
const assert = require('assert');
const crypto = require('crypto');
const sdk = require('digital-signature-nodejs-sdk');

const savedJwe = process.env.EBAY_SIGNING_KEY_JWE;
const savedPrivate = process.env.EBAY_SIGNING_KEY_PRIVATE;
delete process.env.EBAY_SIGNING_KEY_JWE;
delete process.env.EBAY_SIGNING_KEY_PRIVATE;

const { signedHeaders, signingConfigured } = require('../services/ebayDigitalSignatureService');

(async () => {
  // ---------- not configured: never signs, never throws - an in-scope call behaves exactly as before this file existed ----------
  assert.strictEqual(signingConfigured(), false);
  assert.deepStrictEqual(await signedHeaders({ method: 'GET', path: '/sell/finances/v1/transaction', host: 'apiz.ebay.com' }), {});

  // ---------- configured: produces 3 headers that a real verifier (eBay's own SDK) accepts as valid ----------
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const verifyConfig = {
    publicKey,
    masterKey: crypto.randomBytes(32).toString('base64'),
    jweHeaderParams: { alg: 'A256GCMKW', enc: 'A256GCM', zip: 'DEF' },
    jwtExpiration: 3,
    jwtPayload: { pkey: publicKey.replace(/-----BEGIN PUBLIC KEY-----\n|\n-----END PUBLIC KEY-----\n?/g, '') },
    signatureComponents: { method: 'GET', authority: 'apiz.ebay.com', path: '/sell/finances/v1/transaction' },
    signatureParams: ['x-ebay-signature-key', '@method', '@path', '@authority'],
  };
  const jwe = await sdk.generateSignatureKey(verifyConfig);

  process.env.EBAY_SIGNING_KEY_JWE = jwe;
  process.env.EBAY_SIGNING_KEY_PRIVATE = privateKey;
  assert.strictEqual(signingConfigured(), true);

  const headers = await signedHeaders({ method: 'GET', path: '/sell/finances/v1/transaction', host: 'apiz.ebay.com' });
  assert.strictEqual(Object.keys(headers).sort().join(','), 'signature,signature-input,x-ebay-signature-key', 'exactly these 3 - no content-digest for a bodyless GET');
  assert.strictEqual(headers['x-ebay-signature-key'], jwe, 'passed through as-is, never re-derived');
  assert.match(headers['signature-input'], /^sig1=\("x-ebay-signature-key" "@method" "@path" "@authority"\);created=\d+$/, 'no "content-digest" param for a GET with no body, matching the docs\' own example');
  assert.match(headers['signature'], /^sig1=:.+:$/);

  const isValid = await sdk.validateSignatureHeader(headers, verifyConfig);
  assert.strictEqual(isValid, true, 'eBay\'s own SDK, acting as the verifier, accepts the signature this produces');

  // ---------- the @path used for signing is the bare path, never the query string (caller's job - services/
  // ebayFinancesService.js strips it before calling signedHeaders) - a signature over the wrong path would fail to
  // verify against a config built from the true path, proving the two must already agree ----------
  const mismatchConfig = { ...verifyConfig, signatureComponents: { ...verifyConfig.signatureComponents, path: '/sell/finances/v1/transaction?limit=50' } };
  const stillValidForTrueePath = await sdk.validateSignatureHeader(headers, verifyConfig);
  const invalidForWrongPath = await sdk.validateSignatureHeader(headers, mismatchConfig).catch(() => false);
  assert.strictEqual(stillValidForTrueePath, true);
  assert.notStrictEqual(invalidForWrongPath, true, 'signing the wrong path would not verify against the real one');

  // ---------- a privateKey with literal "\n" escapes (as some env-var UIs store a pasted multi-line secret) still works ----------
  process.env.EBAY_SIGNING_KEY_PRIVATE = privateKey.replace(/\n/g, '\\n');
  const headers2 = await signedHeaders({ method: 'GET', path: '/sell/finances/v1/transaction', host: 'apiz.ebay.com' });
  assert.strictEqual(await sdk.validateSignatureHeader(headers2, verifyConfig), true);

  // ---------- real-world mangled pastes (the exact "error:1E08010C:DECODER routines::unsupported" a user hit when
  // Render's env var box collapsed the key) - each must still produce a header whose signature verifies ----------
  const bareBase64 = privateKey.replace(/-----BEGIN PRIVATE KEY-----|\n-----END PRIVATE KEY-----\n?/g, '').replace(/\n/g, '');
  const mangled = {
    'squished onto one line, no newline anywhere (BEGIN/body/END all glued together)': privateKey.replace(/\n/g, ''),
    'CRLF line endings': privateKey.replace(/\n/g, '\r\n'),
    'extra blank lines and leading/trailing whitespace': '  \n' + privateKey.replace(/\n/g, '\n\n') + '\n  ',
    // eBay's createSigningKey actually returns privateKey this way - bare base64 DER, no PEM wrapper at all
    // (confirmed 2026-10-02 against the docs' own sample and a real key: fixed PKCS8/Ed25519 prefix "MC4CAQAwBQYDK2VwB...").
    'bare base64, no PEM wrapper at all (eBay\'s real response shape)': bareBase64,
  };
  for (const [label, value] of Object.entries(mangled)) {
    process.env.EBAY_SIGNING_KEY_PRIVATE = value;
    const h = await signedHeaders({ method: 'GET', path: '/sell/finances/v1/transaction', host: 'apiz.ebay.com' });
    assert.strictEqual(await sdk.validateSignatureHeader(h, verifyConfig), true, label);
  }

  if (savedJwe === undefined) delete process.env.EBAY_SIGNING_KEY_JWE; else process.env.EBAY_SIGNING_KEY_JWE = savedJwe;
  if (savedPrivate === undefined) delete process.env.EBAY_SIGNING_KEY_PRIVATE; else process.env.EBAY_SIGNING_KEY_PRIVATE = savedPrivate;

  console.log('ebay digital signature service tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
