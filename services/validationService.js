/**
 * Reusable input validation helpers. These exist so routes can reject
 * obviously-malformed input early (before wasting a credit, an external
 * API call, or hitting the database) with a clear error message, instead
 * of a generic downstream failure or - worse - silently accepting garbage.
 */

const AMAZON_URL_PATTERN = /^https?:\/\/(www\.)?amazon\.[a-z.]{2,10}\//i;

/**
 * Checks that a string looks like a real Amazon product URL. This is a
 * shape check, not a guarantee the page exists - the actual fetch will
 * still fail cleanly for a bad/nonexistent link, but this catches typos,
 * non-Amazon URLs, and empty/garbage input immediately.
 */
function isValidAmazonUrl(url) {
  return typeof url === 'string' && AMAZON_URL_PATTERN.test(url.trim());
}

/**
 * Checks that a value is a valid MongoDB ObjectId shape (24 hex
 * characters) - used to reject obviously-invalid IDs in route params
 * before they even reach a database query.
 */
function isValidObjectIdString(value) {
  return typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value);
}

/**
 * Checks that a value is a positive, finite number - used for prices,
 * quantities, and similar numeric fields.
 */
function isPositiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}

module.exports = { isValidAmazonUrl, isValidObjectIdString, isPositiveNumber };
