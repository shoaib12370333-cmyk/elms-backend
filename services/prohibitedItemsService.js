const { fold } = require('./textCleanService');
const { getWords } = require('../config/prohibitedItemWords');

/**
 * A heads-up (never a block) that a draft or live listing's own text names something from eBay's "Illegal drugs and
 * drug paraphernalia" policy - confirmed 2026-10-02 against a real takedown ("RORA Glass Oil Burner Pipe ... Glass
 * Water Bongs" was removed, fees credited, after a user report). Its own built-in word list - not the seller's VeRO
 * list, and not a general prohibited-items checker (weapons, counterfeit, hazmat, recalled items ... are each their
 * own eBay policy, not covered here).
 *
 * Deliberately NOT built on veroService.js's matcher: that one computes, for every single character of the text,
 * foldWithMap's per-character .normalize('NFD') plus a map back to the original string's positions - needed there to
 * cut a VeRO word back OUT of the original text (services/veroCleanerService.js), but wasted work here, since a
 * heads-up only ever needs to know WHICH words matched, never where. Confirmed 2026-10-02: models/listingsModel.js's
 * serialize() calls scanListing() for every listing row a page shows (Drafts and Live Listings both, every page
 * load) - reusing veroService.js's matcher there measurably slowed those pages down, especially with a long
 * description (now up to 4000 words). This file instead folds each field ONCE as a whole string (fold(), not
 * foldWithMap()) and runs one regex exec per field - the same whole-word, case-insensitive, hyphen/apostrophe-
 * tolerant matching, at a small fraction of the cost.
 */

const SEP = "[\\s\\-'.]*";
const SEPARATOR_CHARS = new Set([' ', '-', "'", '.']);

function escapeChar(ch) {
  return /[.*+?^${}()|[\]\\\/]/.test(ch) ? '\\' + ch : ch;
}

function termToPattern(term) {
  let out = '';
  let pendingSep = false;
  for (const ch of fold(term).toLowerCase()) {
    if (SEPARATOR_CHARS.has(ch)) { pendingSep = out.length > 0; continue; }
    if (pendingSep) { out += SEP; pendingSep = false; }
    out += escapeChar(ch);
  }
  return out;
}

// Built once at require time - the word list is fixed, not per-user like VeRO, so there is nothing to rebuild per call.
const PATTERN = (() => {
  const alternatives = [...new Set(getWords())]
    .sort((a, b) => b.length - a.length) // the longest term first, so "water bong" wins over "bong" at the same spot
    .map(termToPattern)
    .filter(Boolean);
  return alternatives.length ? new RegExp('(^|[^a-z0-9])(' + alternatives.join('|') + ')(?=$|[^a-z0-9])', 'gi') : null;
})();

/** The distinct matched terms in one piece of text (lowercase, deduped). */
function findTerms(text) {
  if (!PATTERN || !text) return [];
  const folded = fold(String(text)).toLowerCase();
  const re = new RegExp(PATTERN.source, PATTERN.flags);
  const found = new Set();
  let m;
  while ((m = re.exec(folded)) !== null) {
    found.add(m[2]);
    if (m[0].length === 0) re.lastIndex += 1;
  }
  return [...found];
}

const asList = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]);

/**
 * @param {{title?, description?, bulletPoints?, specifications?}} listing
 * @returns {string[]} the matched terms (empty = nothing flagged)
 */
function scanListing(listing) {
  if (!PATTERN || !listing) return [];
  const found = new Set();
  findTerms(listing.title).forEach((t) => found.add(t));
  findTerms(listing.description).forEach((t) => found.add(t));
  asList(listing.bulletPoints).forEach((b) => findTerms(b).forEach((t) => found.add(t)));
  asList(listing.specifications).forEach((s) => {
    findTerms(s && s.name).forEach((t) => found.add(t));
    findTerms(s && s.value).forEach((t) => found.add(t));
  });
  return [...found];
}

module.exports = { scanListing };
