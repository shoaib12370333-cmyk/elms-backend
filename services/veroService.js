const { stripInvisible, fold, foldWithMap } = require('./textCleanService');

/**
 * VeRO words are the user's OWN list (Settings -> VeRO): whatever they saved is what gets flagged, warned about and
 * removed. This file turns such a list into a matcher. Matching is whole-word, case-insensitive and tolerant of
 * hyphens, apostrophes and accents ("spider-man", "Spider Man" and "spiderman" are one word).
 */

// Between the parts of a multi-word term: "spider-man", "spider man" and "spiderman" all match.
const SEP = "[\\s\\-'.]*";
const SEPARATOR_CHARS = new Set([' ', '-', "'", '.']);

const MAX_WORDS = 500;
const MAX_WORD_LENGTH = 60;

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

/** A word as the user typed it, made storable: trimmed, single spaces, no surrounding quotes / commas. null when unusable. */
function normalizeWord(input) {
  const word = String(input == null ? '' : input).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^["'`,;]+|["'`,;]+$/g, '').trim().toLowerCase();
  if (word.length < 2 || word.length > MAX_WORD_LENGTH) return null;
  if (!/[a-z0-9À-￿]/i.test(word)) return null;
  return word;
}

const asList = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]);
const BRAND_NAMES = new Set(['brand', 'brand name', 'brand/manufacturer']);
const MAKER_NAMES = new Set(['manufacturer', 'manufacturer name', 'maker']);
const norm = (v) => stripInvisible(v).trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * @param {string[]} words the user's VeRO words
 */
function buildMatcher(words) {
  const alternatives = [...new Set((words || []).map((w) => normalizeWord(w)).filter(Boolean))]
    .sort((a, b) => b.length - a.length) // the longest word first, so "polo ralph lauren" wins over "ralph lauren"
    .map(termToPattern)
    .filter(Boolean);
  // (^|non-alphanumeric)(term)(end|non-alphanumeric): a whole word only, so "nikey" or "snike" do not match "nike".
  const pattern = alternatives.length ? { source: '(^|[^a-z0-9])(' + alternatives.join('|') + ")(?=$|[^a-z0-9])", flags: 'gi' } : null;

  /** Matches in one text, as { start, end } in the ORIGINAL text plus the matched word. */
  function findMatches(text) {
    const original = String(text ?? '');
    if (!pattern || !original) return [];
    const { text: folded, map } = foldWithMap(original);
    const re = new RegExp(pattern.source, pattern.flags);
    const found = [];
    let m;
    while ((m = re.exec(folded)) !== null) {
      const startFolded = m.index + m[1].length;
      const endFolded = startFolded + m[2].length;
      found.push({ start: map[startFolded], end: map[endFolded - 1] + 1, word: fold(m[2]).toLowerCase() });
      if (m[0].length === 0) re.lastIndex += 1;
    }
    return found;
  }

  /** The distinct VeRO words found in a text (lowercase). */
  function findVeroTerms(text) {
    return [...new Set(findMatches(text).map((f) => f.word))];
  }

  /** The text with every VeRO word cut out and the leftovers (double spaces, empty brackets, dangling dashes) tidied. */
  function stripVeroTerms(text) {
    const original = String(text ?? '');
    const matches = findMatches(original);
    if (!matches.length) return original;
    let out = '';
    let pos = 0;
    for (const { start, end } of matches) {
      out += original.slice(pos, start);
      pos = end;
    }
    out += original.slice(pos);
    return out
      .replace(/[(\[]\s*(?:for|with|by|from|fits|compatible with)?\s*[)\]]/gi, '')
      .replace(/[ \t]+(?:for|with|by|from|fits|compatible with|and|&)[ \t]*$/gim, '')
      .replace(/,(?:[ \t]*,)+/g, ',')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/[ \t]+([,.;:!?])/g, '$1')
      .replace(/^[ \t]*[-–—|,:;\/]+[ \t]*/gm, '')
      .replace(/[ \t]*[-–—|,:;\/]+[ \t]*$/gm, '')
      .replace(/^[ \t]+|[ \t]+$/gm, '')
      .trim();
  }

  /**
   * Looks for VeRO words in everything a listing shows or sends to eBay.
   * @param {{ title?, description?, bulletPoints?, specifications?: {name,value}[], aspects?: Object<string, string[]|string>, brand? }} listing
   * @returns {{ terms: string[], fields: Object<string, string[]> }} fields: where each word was found
   */
  function scanListing(listing = {}) {
    const fields = {};
    const add = (field, text) => {
      const hits = findVeroTerms(stripInvisible(text));
      if (hits.length) fields[field] = [...new Set([...(fields[field] || []), ...hits])];
    };
    add('title', listing.title);
    add('description', listing.description);
    asList(listing.bulletPoints).forEach((b) => add('bulletPoints', b));
    asList(listing.specifications).forEach((s) => { add('specifications', s && s.name); add('specifications', s && s.value); });
    Object.entries(listing.aspects && typeof listing.aspects === 'object' ? listing.aspects : {}).forEach(([name, values]) => {
      add('aspects', name);
      asList(values).forEach((v) => add('aspects', v));
    });
    add('brand', listing.brand);
    return { terms: [...new Set(Object.values(fields).flat())], fields };
  }

  /**
   * Item specifics / specification rows: a brand that is a VeRO word becomes "Unbranded", any other value has the
   * word cut out, and a row or value left empty is dropped.
   */
  function cleanSpecificsAndAspects({ specifications, aspects }) {
    const removed = new Set();
    const hits = (text) => findVeroTerms(stripInvisible(text));
    const note = (text) => hits(text).forEach((t) => removed.add(t));

    const cleanedSpecs = [];
    for (const s of asList(specifications)) {
      if (!s || typeof s !== 'object') continue;
      const name = String(s.name ?? '');
      const value = String(s.value ?? '');
      if (!hits(name).length && !hits(value).length) { cleanedSpecs.push(s); continue; }
      note(name); note(value);
      if (BRAND_NAMES.has(norm(name)) && hits(value).length) { cleanedSpecs.push({ ...s, value: 'Unbranded' }); continue; }
      if (MAKER_NAMES.has(norm(name)) && hits(value).length) continue;
      const newName = stripVeroTerms(name);
      const newValue = stripVeroTerms(value);
      if (newName && newValue) cleanedSpecs.push({ ...s, name: newName, value: newValue });
    }

    const cleanedAspects = {};
    for (const [name, raw] of Object.entries(aspects && typeof aspects === 'object' ? aspects : {})) {
      const values = asList(raw).map((v) => String(v ?? ''));
      if (hits(name).length) { note(name); continue; }
      const out = [];
      for (const v of values) {
        if (!hits(v).length) { out.push(v); continue; }
        note(v);
        if (BRAND_NAMES.has(norm(name))) out.push('Unbranded');
        else if (!MAKER_NAMES.has(norm(name))) { const cut = stripVeroTerms(v); if (cut) out.push(cut); }
      }
      const unique = [...new Set(out)];
      if (unique.length) cleanedAspects[name] = unique;
    }
    return { specifications: cleanedSpecs, aspects: cleanedAspects, removed: [...removed] };
  }

  return { pattern, hasWords: !!pattern, findVeroTerms, stripVeroTerms, scanListing, cleanSpecificsAndAspects };
}

// The same list is used for every request of a user, so the compiled matcher is kept for a while.
const cache = new Map();
function createMatcher(words) {
  const key = (words || []).join('\u0001');
  let matcher = cache.get(key);
  if (!matcher) {
    matcher = buildMatcher(words);
    cache.set(key, matcher);
    if (cache.size > 300) cache.delete(cache.keys().next().value);
  }
  return matcher;
}

module.exports = { createMatcher, normalizeWord, MAX_WORDS, MAX_WORD_LENGTH };
