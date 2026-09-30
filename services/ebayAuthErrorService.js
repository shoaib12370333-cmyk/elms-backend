/**
 * Whether an error from an eBay API call means "this account's connection itself is broken and no retry will ever
 * fix it without the seller reconnecting" - a dead/revoked refresh token (eBay's OAuth invalid_grant, typically
 * HTTP 400: "the provided authorization refresh token is invalid or was issued to another client"), or a scope the
 * account's stored consent does not cover (e.g. sell.finances added after the account was first connected: "The
 * requested scope is invalid, unknown, malformed, or exceeds the scope granted to the client").
 *
 * Real eBay errors are not consistently HTTP 401/403 for either of these (confirmed 2026-09-30 against real seller
 * accounts: the token endpoint answers invalid_grant with 400), so the message itself is checked too, not just
 * statusCode. Used to short-circuit a per-order/per-account retry loop (jobs/orderEarningsSync.js) and to stop a
 * periodic job from re-hitting eBay's token endpoint every few minutes forever for an account that cannot succeed
 * until the seller acts (jobs/orderSync.js).
 */
function isUnrecoverableEbayAuthError(err) {
  if (!err) return false;
  if (err.statusCode === 401 || err.statusCode === 403) return true;
  const msg = String(err.message || '').toLowerCase();
  if (msg.includes('scope') && (msg.includes('invalid') || msg.includes('exceed') || msg.includes('malformed'))) return true;
  if (msg.includes('refresh token') && (msg.includes('invalid') || msg.includes('issued to another client'))) return true;
  return false;
}

module.exports = { isUnrecoverableEbayAuthError };
