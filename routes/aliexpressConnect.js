const express = require('express');
const router = express.Router();
const { buildAuthorizationUrl, exchangeCodeForToken } = require('../services/aliexpressAuthService');
const { setAliexpressCredentials, clearAliexpressCredentials, isAliexpressConnected } = require('../models/usersModel');
const { issueAliexpressConnectState, verifyAliexpressConnectState, verifySessionToken } = require('../services/sessionService');
const { requireAuth } = require('../middleware/requireAuth');

/** GET /api/aliexpress-connect/status - whether this account has an AliExpress connection (never a token). */
router.get('/status', requireAuth, async (req, res) => {
  const status = await isAliexpressConnected(req.userId);
  res.json({ success: true, ...status });
});

/**
 * GET /api/aliexpress-connect/start
 * Requires a valid session token (sent as ?token=... since this is a browser redirect, not a fetch call).
 * Returns the AliExpress authorization URL the frontend should redirect the user to.
 */
router.get('/start', (req, res) => {
  const { token } = req.query;
  let userId;
  try {
    userId = verifySessionToken(token);
  } catch (err) {
    return res.status(err.statusCode || 401).json({ success: false, error: err.message });
  }

  try {
    const state = issueAliexpressConnectState(userId);
    const url = buildAuthorizationUrl(state);
    res.json({ success: true, url });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/aliexpress-connect/callback
 * AliExpress redirects the browser here after the seller grants consent, with ?code=...&state=... in the query string
 * (state was appended to the redirect_uri ELMS sent - see services/aliexpressAuthService.js for why).
 */
router.get('/callback', async (req, res) => {
  const { code, state, error, error_description: errorDescription } = req.query;
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5500';

  if (error) {
    const message = errorDescription || error || 'AliExpress authorization was not completed.';
    return res.redirect(`${frontendUrl}?aliexpressConnect=error&message=${encodeURIComponent(message)}`);
  }

  if (!code || !state) {
    console.warn('[aliexpress-connect] callback missing code/state; received query keys:', Object.keys(req.query || {}));
    const missing = !code && !state ? 'code and state' : (!code ? 'code' : 'state');
    return res.redirect(`${frontendUrl}?aliexpressConnect=error&message=${encodeURIComponent(`Missing ${missing} from AliExpress callback. Please try connecting again.`)}`);
  }

  let connectionState;
  try {
    connectionState = verifyAliexpressConnectState(state);
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
