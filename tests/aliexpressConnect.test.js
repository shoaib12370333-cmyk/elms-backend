// routes/aliexpressConnect.js: /start redirects straight to AliExpress and sets a short-lived state cookie (AliExpress's
// redirect_uri must match the App Console's registered callback EXACTLY - confirmed against a real app - so there is no
// query string available to carry which user is mid-connect; a cookie carries it instead). /callback reads that cookie,
// exchanges the code and stores credentials (or redirects with a friendly error). /disconnect clears the connection. Real
// route code; only the auth service's network call and usersModel storage are stand-ins.
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
  buildAuthorizationUrl: () => 'https://api-sg.aliexpress.com/oauth/authorize?client_id=12345678&redirect_uri=' + encodeURIComponent('https://elms-backend.onrender.com/api/aliexpress-connect/callback'),
  exchangeCodeForToken: (code) => nextExchange(code),
});
stub('../middleware/requireAuth', { requireAuth: (req, res, next) => { req.userId = req.headers['x-user'] || 'u1'; next(); } });

const { issueSessionToken, issueAliexpressConnectState } = require('../services/sessionService');
const router = require('../routes/aliexpressConnect');

function findRoute(method, path) {
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
const fakeRes = () => ({
  statusCode: 200, body: null, headers: {},
  status(c) { this.statusCode = c; return this; },
  json(b) { this.body = b; return this; },
  redirect(url) { this.redirectedTo = url; return this; },
  setHeader(k, v) { this.headers[k] = v; },
});
/** Pulls the state token out of the Set-Cookie header /start issued, the way a real browser would carry it to /callback. */
function cookieFrom(res) {
  const raw = res.headers['Set-Cookie'] || '';
  const m = raw.match(/^ae_connect_state=([^;]+)/);
  return m ? `ae_connect_state=${m[1]}` : null;
}

(async () => {
  // ---------- /status: reflects whether this user has a stored connection, never a token ----------
  const status = findRoute('get', '/status');
  let res = fakeRes();
  await status({ userId: 'u1', headers: {} }, res);
  assert.deepStrictEqual(res.body, { success: true, connected: false, connectedAt: null, account: null });

  // ---------- /start: a valid session token redirects straight to AliExpress and sets a state cookie ----------
  const start = findRoute('get', '/start');
  const sessionToken = issueSessionToken('u1');
  res = fakeRes();
  await start({ query: { token: sessionToken }, protocol: 'https' }, res);
  assert.ok(res.redirectedTo && res.redirectedTo.startsWith('https://api-sg.aliexpress.com/oauth/authorize'), 'the real authorize URL, no JSON body');
  assert.ok(!/aliexpress-connect\/callback\?/.test(decodeURIComponent(res.redirectedTo)), 'the redirect_uri inside it carries no query string');
  const cookieHeader = res.headers['Set-Cookie'];
  assert.ok(cookieHeader && cookieHeader.startsWith('ae_connect_state='), 'a state cookie is set');
  assert.ok(cookieHeader.includes('HttpOnly') && cookieHeader.includes('Secure') && cookieHeader.includes('SameSite=Lax'));
  const stateCookie = cookieFrom(res);

  // an invalid/missing session token redirects to the frontend with an error, never a bare 401/JSON (this is a plain browser navigation)
  res = fakeRes();
  await start({ query: {}, protocol: 'https' }, res);
  assert.ok(res.redirectedTo.includes('aliexpressConnect=error'));

  // over plain http (local dev), no "Secure" attribute (a Secure cookie is silently dropped by the browser over http)
  res = fakeRes();
  await start({ query: { token: sessionToken }, protocol: 'http' }, res);
  assert.ok(!res.headers['Set-Cookie'].includes('Secure'));

  // ---------- /callback: reads the state cookie (not a query param), exchanges the code, stores credentials, redirects with success ----------
  const callback = findRoute('get', '/callback');
  res = fakeRes();
  await callback({ query: { code: 'CODE1' }, headers: { cookie: stateCookie } }, res);
  assert.strictEqual(res.redirectedTo, 'http://localhost:5500?aliexpressConnect=success');
  assert.strictEqual(creds.get('u1').accessToken, 'AT1');
  assert.strictEqual(creds.get('u1').sellerId, 'S1');
  assert.ok(res.headers['Set-Cookie'].includes('Max-Age=0'), 'the one-time cookie is cleared once read');

  // a missing code, or a missing/already-cleared cookie, never reaches exchangeCodeForToken
  res = fakeRes();
  await callback({ query: {}, headers: {} }, res);
  assert.ok(res.redirectedTo.includes('aliexpressConnect=error'));
  assert.ok(res.redirectedTo.includes('Missing%20code%20and%20connection%20state'));

  res = fakeRes();
  await callback({ query: { code: 'CODE1' }, headers: {} }, res); // e.g. a stale bookmark, or cookies blocked
  assert.ok(res.redirectedTo.includes('Missing%20connection%20state'));

  // a forged/expired state cookie is rejected
  res = fakeRes();
  await callback({ query: { code: 'CODE1' }, headers: { cookie: 'ae_connect_state=not-a-real-token' } }, res);
  assert.ok(res.redirectedTo.includes('aliexpressConnect=error'));
  assert.ok(res.redirectedTo.includes('invalid%20or%20expired'));

  // AliExpress declining (or the code already expired / already used) surfaces as a friendly redirect, never a throw
  nextExchange = async () => { throw new Error('Invalid Code'); };
  res = fakeRes();
  const freshCookie = () => { const st = issueAliexpressConnectState('u1'); return `ae_connect_state=${encodeURIComponent(st)}`; };
  await callback({ query: { code: 'STALE' }, headers: { cookie: freshCookie() } }, res);
  assert.ok(res.redirectedTo.includes('aliexpressConnect=error'));
  assert.ok(res.redirectedTo.includes('Invalid%20Code'));

  // an AliExpress-side "error" (declined consent) also clears the cookie and redirects, without ever reading it
  res = fakeRes();
  await callback({ query: { error: 'access_denied' }, headers: { cookie: freshCookie() } }, res);
  assert.ok(res.redirectedTo.includes('aliexpressConnect=error'));
  assert.strictEqual(res.headers['Set-Cookie'].includes('Max-Age=0'), true);

  // ---------- /disconnect: clears the stored connection ----------
  const disconnect = findRoute('post', '/disconnect');
  res = fakeRes();
  await disconnect({ userId: 'u1', headers: {} }, res);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(creds.has('u1'), false);

  console.log('aliexpress connect route tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
