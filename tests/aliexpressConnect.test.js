// routes/aliexpressConnect.js: /start builds the authorize URL for a valid session, /callback exchanges the code and
// stores credentials (or redirects with a friendly error), /disconnect clears them. Real route code; only the auth
// service's network call and usersModel storage are stand-ins.
const assert = require('assert');
process.env.JWT_SECRET = 'test-secret';
process.env.ALIEXPRESS_APP_KEY = '12345678';
process.env.ALIEXPRESS_APP_SECRET = 'my-app-secret';
process.env.ALIEXPRESS_REDIRECT_URI = 'https://elms-backend.onrender.com/api/aliexpress-connect/callback';

const stub = (specifier, exports) => { const p = require.resolve(specifier); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

const creds = new Map();
stub('../models/usersModel', {
  setAliexpressCredentials: async (userId, tokens) => { creds.set(userId, tokens); return true; },
  clearAliexpressCredentials: async (userId) => { creds.delete(userId); },
  isAliexpressConnected: async (userId) => ({ connected: creds.has(userId), connectedAt: creds.has(userId) ? new Date() : null, account: creds.get(userId)?.account || null }),
});

let nextExchange = async () => ({ accessToken: 'AT1', refreshToken: 'RT1', accessTokenExpiresAt: null, refreshTokenExpiresAt: null, sellerId: 'S1', account: 'a@b.com' });
stub('../services/aliexpressAuthService', {
  buildAuthorizationUrl: (state) => `https://api-sg.aliexpress.com/oauth/authorize?client_id=12345678&redirect_uri=${encodeURIComponent('https://x/callback?state=' + state)}`,
  exchangeCodeForToken: (code) => nextExchange(code),
});
stub('../middleware/requireAuth', { requireAuth: (req, res, next) => { req.userId = req.headers['x-user'] || 'u1'; next(); } });

const { issueSessionToken, issueAliexpressConnectState } = require('../services/sessionService');
const router = require('../routes/aliexpressConnect');

function findRoute(method, path) {
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
const fakeRes = () => ({ statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, redirect(url) { this.redirectedTo = url; return this; } });

(async () => {
  // ---------- /status: reflects whether this user has a stored connection, never a token ----------
  const status = findRoute('get', '/status');
  let res = fakeRes();
  await status({ userId: 'u1', headers: {} }, res);
  assert.deepStrictEqual(res.body, { success: true, connected: false, connectedAt: null, account: null });

  // ---------- /start: a valid session token returns an authorize URL carrying a signed state ----------
  const start = findRoute('get', '/start');
  const sessionToken = issueSessionToken('u1');
  res = fakeRes();
  await start({ query: { token: sessionToken } }, res);
  assert.strictEqual(res.body.success, true);
  assert.ok(res.body.url.startsWith('https://api-sg.aliexpress.com/oauth/authorize'), 'the real authorize URL');

  // an invalid/missing session token is rejected before any AliExpress call
  res = fakeRes();
  await start({ query: {} }, res);
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(res.body.success, false);

  // ---------- /callback: exchanges the code, stores credentials, redirects to the frontend with success ----------
  const callback = findRoute('get', '/callback');
  const state = issueAliexpressConnectState('u1');
  res = fakeRes();
  await callback({ query: { code: 'CODE1', state } }, res);
  assert.strictEqual(res.redirectedTo, 'http://localhost:5500?aliexpressConnect=success');
  assert.strictEqual(creds.get('u1').accessToken, 'AT1');
  assert.strictEqual(creds.get('u1').sellerId, 'S1');

  // a missing code/state never reaches exchangeCodeForToken
  res = fakeRes();
  await callback({ query: {} }, res);
  assert.ok(res.redirectedTo.includes('aliexpressConnect=error'));
  assert.ok(res.redirectedTo.includes('Missing%20code%20and%20state'));

  // a forged/expired state is rejected
  res = fakeRes();
  await callback({ query: { code: 'CODE1', state: 'not-a-real-token' } }, res);
  assert.ok(res.redirectedTo.includes('aliexpressConnect=error'));
  assert.ok(res.redirectedTo.includes('invalid%20or%20expired'));

  // AliExpress declining (or the code already expired / already used) surfaces as a friendly redirect, never a throw
  nextExchange = async () => { throw new Error('Invalid Code'); };
  res = fakeRes();
  await callback({ query: { code: 'STALE', state: issueAliexpressConnectState('u1') } }, res);
  assert.ok(res.redirectedTo.includes('aliexpressConnect=error'));
  assert.ok(res.redirectedTo.includes('Invalid%20Code'));

  // ---------- /disconnect: clears the stored connection ----------
  const disconnect = findRoute('post', '/disconnect');
  res = fakeRes();
  await disconnect({ userId: 'u1', headers: {} }, res);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(creds.has('u1'), false);

  console.log('aliexpress connect route tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
