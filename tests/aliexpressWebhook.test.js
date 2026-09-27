// routes/aliexpressWebhook.js: the push-message callback (AppConsole "Message Subscription and Callback URL", separate from
// the OAuth redirect_uri). Ack fast (200, status only), verify the Authorization signature when one is sent, never block a
// message with no Authorization header at all (the docs call the signature "not mandatory, but highly recommended").
const assert = require('assert');
const crypto = require('crypto');

process.env.ALIEXPRESS_APP_KEY = '12345678';
process.env.ALIEXPRESS_APP_SECRET = 'my-app-secret';

const { verifySignature, describeMessage, MESSAGE_TYPES } = require('../services/aliexpressWebhookService');
const router = require('../routes/aliexpressWebhook');

const post = router.stack.find((l) => l.route && l.route.methods.post).route.stack[0].handle;
const get = router.stack.find((l) => l.route && l.route.methods.get).route.stack[0].handle;
const fakeRes = () => { const r = { statusCode: 200, ended: false, body: undefined }; r.status = (c) => { r.statusCode = c; return r; }; r.end = () => { r.ended = true; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };

const sign = (rawBody) => crypto.createHmac('sha256', 'my-app-secret').update('12345678' + rawBody, 'utf8').digest('hex');

(async () => {
  // ---------- verifySignature: the docs' own algorithm (Base = AppKey + messageBody, HMAC-SHA256 keyed by AppSecret, lowercase hex) ----------
  const rawBody = JSON.stringify({ seller_id: '1234567', message_type: 0, data: {} });
  const validAuth = sign(rawBody);
  assert.strictEqual(verifySignature(rawBody, validAuth), true);
  assert.strictEqual(verifySignature(rawBody, validAuth.toUpperCase()), true, 'case-insensitive compare');
  assert.strictEqual(verifySignature(rawBody, 'not-the-real-signature'), false);
  assert.strictEqual(verifySignature(rawBody, null), true, 'no Authorization header at all: never blocked - the docs call it optional');

  // ---------- describeMessage: readable log line from the docs' own message_type table ----------
  assert.strictEqual(describeMessage({ seller_id: 's1', message_type: 1 }), 'seller s1: order successfully (message_type=1)');
  assert.strictEqual(describeMessage({ seller_id: 's1', message_type: 999 }), 'seller s1: unknown type 999 (message_type=999)');
  assert.strictEqual(MESSAGE_TYPES[0], 'TEST AE PUSH');

  // ---------- the route: acks 200 fast, rejects a forged signature, never crashes on unparsable JSON ----------
  let res = fakeRes();
  await post({ body: Buffer.from(rawBody), headers: { authorization: validAuth } }, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.ended, true, 'a plain 200 with no body, per the docs');

  res = fakeRes();
  await post({ body: Buffer.from(rawBody), headers: { authorization: 'forged' } }, res);
  assert.strictEqual(res.statusCode, 401, 'a signature that does not verify is rejected, unlike a missing one');

  res = fakeRes();
  await post({ body: Buffer.from(rawBody), headers: {} }, res); // AliExpress's own TEST AE PUSH may send no Authorization at all
  assert.strictEqual(res.statusCode, 200);

  res = fakeRes();
  await post({ body: Buffer.from('not json'), headers: {} }, res);
  assert.strictEqual(res.statusCode, 200, 'still acknowledged even if the body cannot be parsed afterwards');

  // ---------- GET: a harmless 200, not eBay's GET-challenge scheme (AliExpress verifies this callback with a POST test push) ----------
  res = fakeRes();
  get({}, res);
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body, { ok: true });

  console.log('aliexpress webhook tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
