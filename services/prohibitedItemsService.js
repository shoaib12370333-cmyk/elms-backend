const { createMatcher } = require('./veroService');
const { getWords } = require('../config/prohibitedItemWords');

/**
 * A heads-up (never a block) that a draft or live listing's own text names something from eBay's "Illegal drugs and
 * drug paraphernalia" policy - confirmed 2026-10-02 against a real takedown ("RORA Glass Oil Burner Pipe ... Glass
 * Water Bongs" was removed, fees credited, after a user report). Reuses veroService.js's generic word matcher (whole
 * word, case-insensitive, hyphen/apostrophe-tolerant) with its own built-in word list - not the seller's VeRO list,
 * and not a general prohibited-items checker (weapons, counterfeit, hazmat, recalled items ... are each their own
 * eBay policy, not covered here).
 *
 * The word list is built ONCE at require time (module-level), since models/listingsModel.js's serialize() calls
 * scanListing() for every listing row a page shows - rebuilding the matcher per call would repeat that cost for no
 * reason.
 */
const matcher = createMatcher(getWords());

/**
 * @param {{title?, description?, bulletPoints?, specifications?}} listing
 * @returns {string[]} the matched terms (empty = nothing flagged)
 */
function scanListing(listing) {
  return matcher.hasWords ? matcher.scanListing(listing).terms : [];
}

module.exports = { scanListing };
