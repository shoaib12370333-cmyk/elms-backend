const { getVeroWords } = require('../config/veroWords');
const { stripInvisible, fold, foldWithMap } = require('./textCleanService');

// Between the parts of a multi-word term: "spider-man", "spider man" and "spiderman" all match.
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

let compiled = null;
let compiledFor = '';

/** One regex for the whole list. Applied to accent-folded text, so it needs the "i" flag and no lookbehind. */
function getVeroPattern() {
  const words = getVeroWords();
  const key = words.length + ':' + words[words.length - 1];
  if (compiled && compiledFor === key) return compiled;
  const alternatives = words
    .slice()
    .sort((a, b) => b.length - a.length)
    .map(termToPattern)
    .filter(Boolean);
  // (^|non-alphanumeric)(term)(end|non-alphanumeric): a whole word only, so "nikey" or "snike" do not match "nike".
  const source = '(^|[^a-z0-9])(' + alternatives.join('|') + ")(?=$|[^a-z0-9])";
  compiled = { source, flags: 'gi' };
  compiledFor = key;
  return compiled;
}

function newRegex() {
  const { source, flags } = getVeroPattern();
  return new RegExp(source, flags);
}

/** Matches of the word list in one text, as { start, end } in the ORIGINAL text plus the matched words. */
function findMatches(text) {
  const original = String(text ?? '');
  if (!original) return [];
  const { text: folded, map } = foldWithMap(original);
  const re = newRegex();
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

const asList = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]);

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

const BRAND_NAMES = new Set(['brand', 'brand name', 'brand/manufacturer']);
const MAKER_NAMES = new Set(['manufacturer', 'manufacturer name', 'maker']);
const norm = (v) => stripInvisible(v).trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Item specifics / specification rows: a brand that is a VeRO word becomes "Unbranded", any other value has the
 * word cut out, and a row or value left empty is dropped.
 */
function cleanSpecificsAndAspects({ specifications, aspects }) {
  const removed = new Set();
  const note = (text) => findVeroTerms(stripInvisible(text)).forEach((t) => removed.add(t));

  const cleanedSpecs = [];
  for (const s of asList(specifications)) {
    if (!s || typeof s !== 'object') continue;
    const name = String(s.name ?? '');
    const value = String(s.value ?? '');
    if (!findVeroTerms(stripInvisible(name)).length && !findVeroTerms(stripInvisible(value)).length) { cleanedSpecs.push(s); continue; }
    note(name); note(value);
    if (BRAND_NAMES.has(norm(name)) && findVeroTerms(value).length) { cleanedSpecs.push({ ...s, value: 'Unbranded' }); continue; }
    if (MAKER_NAMES.has(norm(name)) && findVeroTerms(value).length) continue;
    const newName = stripVeroTerms(name);
    const newValue = stripVeroTerms(value);
    if (newName && newValue) cleanedSpecs.push({ ...s, name: newName, value: newValue });
  }

  const cleanedAspects = {};
  for (const [name, raw] of Object.entries(aspects && typeof aspects === 'object' ? aspects : {})) {
    const values = asList(raw).map((v) => String(v ?? ''));
    const nameHit = findVeroTerms(stripInvisible(name)).length > 0;
    if (nameHit) { note(name); continue; }
    const out = [];
    for (const v of values) {
      if (!findVeroTerms(stripInvisible(v)).length) { out.push(v); continue; }
      note(v);
      if (BRAND_NAMES.has(norm(name))) out.push('Unbranded');
      else if (!MAKER_NAMES.has(norm(name))) { const cut = stripVeroTerms(v); if (cut) out.push(cut); }
    }
    const unique = [...new Set(out)];
    if (unique.length) cleanedAspects[name] = unique;
  }
  return { specifications: cleanedSpecs, aspects: cleanedAspects, removed: [...removed] };
}

module.exports = { getVeroPattern, findVeroTerms, stripVeroTerms, scanListing, cleanSpecificsAndAspects };
