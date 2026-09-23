const axios = require('axios');
const crypto = require('crypto');

/**
 * CashTap hosted checkout (https://api.cashtap.cash/checkout/v1).
 *   CASHTAP_SECRET_KEY     sk_live_...   (Developers -> API Settings; backend only, never sent to the browser)
 *   CASHTAP_WEBHOOK_SECRET whsec_...     (Developers -> Webhooks; shown once)
 *   CASHTAP_API_URL        optional, defaults to the public API
 * CashTap has no test mode: use the smallest amount (min $0.50) while integrating.
 */

const DEFAULT_API = 'https://api.cashtap.cash/checkout/v1';

const isConfigured = () => !!String(process.env.CASHTAP_SECRET_KEY || '').trim();
const apiBase = () => String(process.env.CASHTAP_API_URL || DEFAULT_API).replace(/\/+$/, '');

/** CashTap answers every error as { error: { code, message, request_id } }. */
function toError(err, fallback) {
  const body = err.response && err.response.data && err.response.data.error;
  const wrapped = new Error(body && body.message ? body.message : fallback);
  wrapped.statusCode = err.response ? err.response.status : 502;
  wrapped.code = body && body.code;
  wrapped.requestId = body && body.request_id;
  return wrapped;
}

async function call(method, path, data) {
  if (!isConfigured()) {
    const err = new Error('CASHTAP_SECRET_KEY is not set.');
    err.statusCode = 503;
    throw err;
  }
  try {
    const res = await axios({
      method,
      url: apiBase() + path,
      data,
      headers: { Authorization: 'Bearer ' + String(process.env.CASHTAP_SECRET_KEY).trim(), 'Content-Type': 'application/json' },
      timeout: 20000,
    });
    return res.data;
  } catch (err) {
    throw toError(err, 'CashTap could not be reached.');
  }
}

/**
 * Creates a hosted checkout session.
 * @param {{ amount: number, lineItems?: object[], customerEmail?: string, successUrl: string, cancelUrl: string, metadata?: Object<string,string>, paymentMethods?: string[] }} p
 * @returns {Promise<{ id: string, url: string, status: string, amount: number, expires_at: number }>}
 */
function createSession({ amount, lineItems, customerEmail, successUrl, cancelUrl, metadata, paymentMethods }) {
  return call('post', '/sessions', {
    amount: Number(Number(amount).toFixed(2)),
    ...(lineItems && lineItems.length ? { line_items: lineItems } : {}),
    ...(customerEmail ? { customer_email: customerEmail } : {}),
    ...(paymentMethods && paymentMethods.length ? { payment_methods: paymentMethods } : {}),
    success_url: successUrl,
    cancel_url: cancelUrl,
    ...(metadata ? { metadata } : {}),
  });
}

/** The session as CashTap has it now (the source of truth for whether it was paid). */
function getSession(sessionId) {
  return call('get', '/sessions/' + encodeURIComponent(sessionId));
}

/**
 * Checks X-CashTap-Signature ("t=<unix seconds>,v1=<hex>[,v1=<hex>]") against the RAW request body.
 * signed string = "<t>.<raw body>", HMAC-SHA256 with the whole whsec_... string as the key. Any v1 may match
 * (two are sent while a rotated secret overlaps); constant-time compare; timestamps older than the tolerance are refused.
 */
function verifySignature(rawBody, header, secret, toleranceSec = 300, nowMs = Date.now()) {
  if (typeof header !== 'string' || header.length > 1024 || !secret) return false;
  let t = null;
  const signatures = [];
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (key === 't') t = value;
    else if (key === 'v1') signatures.push(value);
  }
  if (!/^\d{1,12}$/.test(t || '')) return false;
  if (toleranceSec !== null && Math.abs(nowMs / 1000 - Number(t)) > toleranceSec) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  const expected = crypto.createHmac('sha256', secret).update(t + '.').update(body).digest();
  return signatures.slice(0, 5).some((s) => /^[0-9a-f]{64}$/i.test(s) && crypto.timingSafeEqual(Buffer.from(s, 'hex'), expected));
}

module.exports = { isConfigured, createSession, getSession, verifySignature };
