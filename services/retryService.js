/**
 * Retries an async operation with exponential backoff, but only for
 * errors that look transient (network issues, timeouts, and 5xx/429
 * responses) - a permanent failure like "invalid ASIN" (4xx, excluding
 * 429) fails immediately without wasting retries, since trying again
 * won't change the outcome.
 *
 * @param {() => Promise<any>} fn - the operation to attempt
 * @param {object} options
 * @param {number} options.maxAttempts - total attempts including the first (default 3)
 * @param {number} options.baseDelayMs - delay before the first retry, doubled each attempt (default 500ms)
 */
async function retryWithBackoff(fn, { maxAttempts = 3, baseDelayMs = 500 } = {}) {
  let lastErr;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;

      const status = err.statusCode || err.response?.status;
      const isTransient = !status || status === 429 || status >= 500;

      if (!isTransient || attempt === maxAttempts) {
        throw err;
      }

      const delay = baseDelayMs * 2 ** (attempt - 1);
      console.warn(`[retry] Attempt ${attempt}/${maxAttempts} failed (${err.message}), retrying in ${delay}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastErr;
}

module.exports = { retryWithBackoff };
