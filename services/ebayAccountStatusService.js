const { ebayUserGet } = require('./ebayRestClient');
const Listing = require('../models/schemas/Listing');

/**
 * Two read-only things eBay can tell about a seller's store, shown next to it in Settings and on the Live listings page:
 *  - the selling limit (Account API getPrivileges): how many items and how much money a new or small seller may sell per month,
 *    which is the most common reason a publish suddenly fails;
 *  - listings that break an eBay rule (Compliance API): missing or wrong item specifics, links that lead buyers away from eBay ...
 * Both are asked with the seller's own token (no new permission), remembered for 30 minutes, and each one fails on its own:
 * a store that eBay does not answer for simply shows less.
 */
const CACHE_MS = 30 * 60 * 1000;
const REFRESH_EVERY_MS = 60 * 1000; // "refresh now" is honoured at most once a minute per store
const cache = new Map(); // accountId -> { at, status }

const COMPLIANCE_LABELS = Object.freeze({
  ASPECTS_ADOPTION: 'Missing or invalid item specifics',
  PRODUCT_ADOPTION: 'Product details eBay could match to its catalogue',
  OUTSIDE_EBAY_BUYING_AND_SELLING: 'Links or contact details that lead buyers away from eBay',
  HTTPS: 'Links that are not https',
});
const complianceLabel = (type) => COMPLIANCE_LABELS[type]
  || String(type || 'Other').toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

const num = (v) => (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

/** getPrivileges -> { registrationCompleted, sellingLimit } (sellingLimit is null when the seller has no monthly cap). */
function parsePrivileges(data) {
  const limit = data?.sellingLimit;
  const quantity = num(limit?.quantity);
  const value = num(limit?.amount?.value);
  return {
    registrationCompleted: typeof data?.sellerRegistrationCompleted === 'boolean' ? data.sellerRegistrationCompleted : null,
    sellingLimit: quantity === null && value === null ? null : {
      quantity,
      amount: value === null ? null : { value, currency: String(limit.amount.currency || '') },
    },
  };
}

/** getListingViolationsSummary -> { total, byType: [{ complianceType, label, marketplaceId, listingCount }] } (types with 0 listings are left out). */
function parseViolationSummary(data) {
  const byType = (Array.isArray(data?.violationSummaries) ? data.violationSummaries : [])
    .map((s) => ({ complianceType: String(s.complianceType || ''), label: complianceLabel(s.complianceType), marketplaceId: s.marketplaceId || null, listingCount: num(s.listingCount) || 0 }))
    .filter((s) => s.complianceType && s.listingCount > 0)
    .sort((a, b) => b.listingCount - a.listingCount);
  return { total: byType.reduce((sum, s) => sum + s.listingCount, 0), byType };
}

/** getListingViolations -> [{ listingId, complianceType, label, sku, violations: [{ reasonCode, message }] }] */
function parseViolations(data) {
  return (Array.isArray(data?.listingViolations) ? data.listingViolations : [])
    .filter((v) => v && v.listingId)
    .map((v) => ({
      listingId: String(v.listingId),
      complianceType: String(v.complianceType || ''),
      label: complianceLabel(v.complianceType),
      sku: v.sku || null,
      violations: (Array.isArray(v.violations) ? v.violations : [])
        .map((x) => ({ reasonCode: x.reasonCode || null, message: String(x.message || x.reasonCode || '').slice(0, 300) }))
        .filter((x) => x.message)
        .slice(0, 5),
    }));
}

/** A readable reason for a failed read; a 403 usually means the store was connected before eBay allowed this. */
function reasonOf(err) {
  if (err.statusCode === 401 || err.statusCode === 403) return 'eBay did not allow this read for the store. Reconnecting the store usually fixes it.';
  return err.message || 'eBay could not answer.';
}

/**
 * The status of one store: { sellingLimit, registrationCompleted, violations, errors, fetchedAt }. `sellingLimit`, `registrationCompleted`
 * and `violations` are null when eBay did not answer; `errors` says why, per part.
 */
async function getAccountStatus(accountId, refreshToken, marketplaceId, { refresh = false } = {}) {
  const key = String(accountId);
  const hit = cache.get(key);
  if (hit) {
    const age = Date.now() - hit.at;
    if (age < (refresh ? REFRESH_EVERY_MS : CACHE_MS)) return hit.status;
  }

  const status = { sellingLimit: null, registrationCompleted: null, violations: null, errors: {}, fetchedAt: new Date().toISOString() };
  const [priv, summary] = await Promise.allSettled([
    ebayUserGet(refreshToken, '/sell/account/v1/privilege', { marketplaceId }),
    ebayUserGet(refreshToken, '/sell/compliance/v1/listing_violation_summary', { marketplaceId }),
  ]);
  if (priv.status === 'fulfilled') Object.assign(status, parsePrivileges(priv.value));
  else status.errors.privileges = reasonOf(priv.reason);
  if (summary.status === 'fulfilled') status.violations = parseViolationSummary(summary.value);
  else status.errors.compliance = reasonOf(summary.reason);

  cache.set(key, { at: Date.now(), status });
  return status;
}

/**
 * The listings behind one compliance type, with ELMS's own title for each (up to 200), so the seller can open and fix them.
 * @returns {Promise<{ total: number, listings: Array<{ listingId: string, title: string|null, sku: string|null, complianceType: string, label: string, violations: Array }> }>}
 */
async function getViolations(userId, accountId, refreshToken, marketplaceId, complianceType) {
  const type = String(complianceType || '').toUpperCase().replace(/[^A-Z_]/g, ''); // only letters and underscores go into the address
  if (!type) { const e = new Error('Choose a violation type.'); e.statusCode = 400; throw e; }
  const data = await ebayUserGet(refreshToken, `/sell/compliance/v1/listing_violation?compliance_type=${type}&limit=200&offset=0`, { marketplaceId });
  const rows = parseViolations(data);
  const own = rows.length
    ? await Listing.find({ userId, ebayAccountId: accountId, ebayListingId: { $in: rows.map((r) => r.listingId) } }).select('ebayListingId title sku').lean()
    : [];
  const byItem = new Map(own.map((l) => [String(l.ebayListingId), l]));
  return {
    total: num(data?.total) ?? rows.length,
    listings: rows.map((r) => ({ ...r, title: byItem.get(r.listingId)?.title || null, sku: r.sku || byItem.get(r.listingId)?.sku || null })),
  };
}

function clearStatusCache() { cache.clear(); }

module.exports = { getAccountStatus, getViolations, parsePrivileges, parseViolationSummary, parseViolations, complianceLabel, clearStatusCache, CACHE_MS };
