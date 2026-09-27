const express = require('express');
const router = express.Router();
const { buildAuthorizationUrl, exchangeCodeForToken } = require('../services/aliexpressAuthService');
const { setAliexpressCredentials, clearAliexpressCredentials, isAliexpressConnected } = require('../models/usersModel');
const { issueAliexpressConnectState, verifyAliexpressConnectState, verifySessionToken } = require('../services/sessionService');
const { requireAuth } = require('../middleware/requireAuth');

/**
 * AliExpress's redirect_uri must match the App Console's registered callback URL EXACTLY (confirmed against a real app:
 * appending a query string to it was rejected with "Redirect uri does not match the callback url of the APP"), so there is
 * no room on it to carry which ELMS user is mid-connect. A short-lived, HttpOnly cookie carries it instead - set here when
 * /start redirects the browser to AliExpress, read back when AliExpress redirects the browser to /callback. Both of those
 * are first-party requests straight to this backend's own domain, so the cookie survives the round trip through AliExpress.
 */
const STATE_COOKIE = 'ae_connect_state';
const STATE_COOKIE_MAX_AGE = 900; // seconds - matches issueAliexpressConnectState's 15-minute token expiry

function readCookie(req, name) {
  const header = req.headers && req.headers.cookie;
  if (!header) return null;
  const prefix = name + '=';
  const part = header.split(';').map((p) => p.trim()).find((p) => p.startsWith(prefix));
  return part ? decodeURIComponent(part.slice(prefix.length)) : null;
}

/** SameSite=Lax (not Strict) is required here: this cookie must still be sent on the top-level GET navigation AliExpress
 * sends the browser on when it redirects back to /callback, which is a cross-site navigation from AliExpress's domain. */
function setStateCookie(res, req, value, maxAgeSeconds) {
  const secure = req.protocol === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${STATE_COOKIE}=${encodeURIComponent(value)}; Max-Age=${maxAgeSeconds}; Path=/api/aliexpress-connect; HttpOnly${secure}; SameSite=Lax`);
}

/** GET /api/aliexpress-connect/status - whether this account has an AliExpress connection (never a token). */
router.get('/status', requireAuth, async (req, res) => {
  const status = await isAliexpressConnected(req.userId);
  res.json({ success: true, ...status });
});

/**
 * GET /api/aliexpress-connect/start?token=...
 * Hit by a direct browser navigation (never fetched), so the state cookie set here is a genuine first-party cookie by the
 * time /callback reads it back. Requires a valid session token (as ?token=..., not an Authorization header, since a plain
 * navigation cannot carry a custom header). Redirects straight to AliExpress's consent screen.
 */
router.get('/start', (req, res) => {
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5500';
  const { token } = req.query;
  let userId;
  try {
    userId = verifySessionToken(token);
  } catch (err) {
    return res.redirect(`${frontendUrl}?aliexpressConnect=error&message=${encodeURIComponent(err.message)}`);
  }

  try {
    const state = issueAliexpressConnectState(userId);
    const url = buildAuthorizationUrl();
    setStateCookie(res, req, state, STATE_COOKIE_MAX_AGE);
    res.redirect(url);
  } catch (err) {
    res.redirect(`${frontendUrl}?aliexpressConnect=error&message=${encodeURIComponent(err.message)}`);
  }
});

/**
 * GET /api/aliexpress-connect/callback
 * AliExpress redirects the browser here after the seller grants consent, with ?code=... in the query string - the state
 * lives in the cookie /start set, not in the query string (see the comment at the top of this file for why).
 */
router.get('/callback', async (req, res) => {
  const { code, error, error_description: errorDescription } = req.query;
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5500';
  // One-time use: cleared as soon as it's read, whether or not what follows succeeds.
  res.setHeader('Set-Cookie', `${STATE_COOKIE}=; Max-Age=0; Path=/api/aliexpress-connect; HttpOnly; SameSite=Lax`);

  if (error) {
    const message = errorDescription || error || 'AliExpress authorization was not completed.';
    return res.redirect(`${frontendUrl}?aliexpressConnect=error&message=${encodeURIComponent(message)}`);
  }

  const stateToken = readCookie(req, STATE_COOKIE);
  if (!code || !stateToken) {
    console.warn('[aliexpress-connect] callback missing code or the connect-state cookie; received query keys:', Object.keys(req.query || {}));
    const missing = !code && !stateToken ? 'code and connection state' : (!code ? 'code' : 'connection state');
    return res.redirect(`${frontendUrl}?aliexpressConnect=error&message=${encodeURIComponent(`Missing ${missing}. Please try connecting again.`)}`);
  }

  let connectionState;
  try {
    connectionState = verifyAliexpressConnectState(stateToken);
  } catch (err) {
    return res.redirect(`${frontendUrl}?aliexpressConnect=error&message=${encodeURIComponent(err.message)}`);
  }
  const { userId } = connectionState;

  try {
    const tokens = await exchangeCodeForToken(code);
    await setAliexpressCredentials(userId, tokens);
    res.redirect(`${frontendUrl}?aliexpressConnect=success`);
  } catch (err) {
    console.error('aliexpress-connect callback error:', err.message);
    res.redirect(`${frontendUrl}?aliexpressConnect=error&message=${encodeURIComponent(err.message)}`);
  }
});

/**
 * POST /api/aliexpress-connect/disconnect
 * Requires a valid session token. Removes this user's stored AliExpress connection.
 */
router.post('/disconnect', requireAuth, async (req, res) => {
  await clearAliexpressCredentials(req.userId);
  res.json({ success: true });
});

module.exports = router;
