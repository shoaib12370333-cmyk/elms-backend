const { fold } = require('./textCleanService');
const { AREAS, ALLOW_PHRASES } = require('../config/ebayPolicyRules');

/**
 * eBay's list of what it does not allow, as a matcher (config/ebayPolicyRules.js holds the list and links each area to its eBay policy page).
 *
 * Two uses:
 *  - A HEADS-UP on the Drafts and Live listings rows (scanListing / scanDetailed, called by models/listingsModel.js serialize() for every row a page
 *    shows): first only for "Illegal drugs and drug paraphernalia" (confirmed 2026-10-02 against a real takedown: "RORA Glass Oil Burner Pipe ...
 *    Glass Water Bongs"), now for every area of the list.
 *  - A BLOCK: services/publishQueueService.js refuses to publish a product that checkListing() flags, before any credit is charged and before eBay
 *    is called, so it is never listed.
 *
 * Deliberately NOT built on veroService.js's matcher: that one computes, for every single character of the text, foldWithMap's per-character
 * .normalize('NFD') plus a map back to the original string's positions - needed there to cut a VeRO word back OUT of the original text, but wasted work
 * here, since this only ever needs to know WHICH words matched, never where. Confirmed 2026-10-02: serialize() runs this for every listing row of a
 * page - reusing veroService.js's matcher there measurably slowed those pages down, especially with a long description (now up to 4000 words). This
 * file folds each field ONCE as a whole string and runs ONE regex exec per field. With several hundred terms that stays fast because the regex is a
 * trie (words that start the same share their start, so most positions are rejected on the first letter) - see buildPattern.
 *
 * Matching is whole-word, case-insensitive and tolerant of hyphens, apostrophes and accents ("water-bong", "Water Bong" and "waterbong" are one term).
 */

const SEPARATOR_CHARS = new Set([' ', '-', "'", '.']);
const SEP = Symbol('separator');
const SEP_SOURCE = "[\\s\\-'.]*";

function escapeChar(ch) {
  return /[.*+?^${}()|[\]\\\/]/.test(ch) ? '\\' + ch : ch;
}

/** A term as a list of tokens: a character, or SEP for any run of separators between two parts of it. */
function tokensOf(term) {
  const out = [];
  let pendingSep = false;
  for (const ch of fold(term).toLowerCase()) {
    if (SEPARATOR_CHARS.has(ch)) { pendingSep = out.length > 0; continue; }
    if (pendingSep) { out.push(SEP); pendingSep = false; }
    out.push(ch);
  }
  return out;
}

/** A single context word as regex source (letters and digits only). */
function keyOfWord(word) {
  return fold(word).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** The key two spellings of one term share ("water bong" / "water-bong" / "waterbong"). */
function keyOf(text) {
  return fold(text).toLowerCase().replace(/[\s\-'.]+/g, '');
}

/**
 * One regex for a whole list of terms, written as a trie: bong / bongs / bubbler pipe become b(?:ong(?:s)?|ubbler...) so the engine checks one
 * letter per position instead of trying every term. The longest term wins where one contains another ("water bongs" over "bong").
 */
function buildPattern(terms) {
  const root = { children: new Map(), end: false };
  let count = 0;
  for (const term of terms) {
    const tokens = tokensOf(term);
    if (!tokens.length) continue;
    let node = root;
    for (const tok of tokens) {
      if (!node.children.has(tok)) node.children.set(tok, { children: new Map(), end: false });
      node = node.children.get(tok);
    }
    node.end = true;
    count += 1;
  }
  if (!count) return null;
  const source = (node) => {
    const parts = [];
    for (const [tok, child] of node.children) parts.push((tok === SEP ? SEP_SOURCE : escapeChar(tok)) + source(child));
    if (!parts.length) return '';
    const body = parts.length === 1 ? parts[0] : '(?:' + parts.join('|') + ')';
    return node.end ? '(?:' + body + ')?' : body;
  };
  // (^|non-alphanumeric)(term)(end|non-alphanumeric): a whole word only, so "bongo" does not match "bong".
  return { source: '(^|[^a-z0-9])(' + source(root) + ")(?=$|[^a-z0-9])", flags: 'gi' };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Settings an ELMS admin can change (Admin -> eBay rules): areas switched off, terms added, phrases that are always fine.

const MAX_EXTRA_TERMS = 500;
const MAX_ALLOW_PHRASES = 300;
const MAX_TERM_LENGTH = 60;
const CUSTOM_AREA = { id: 'custom', label: 'Added by the ELMS admin', reason: 'The ELMS admin does not allow this word to be listed.', url: null, mediaExempt: true };

function cleanTerm(input) {
  const word = String(input == null ? '' : input).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^["'`,;]+|["'`,;]+$/g, '').trim().toLowerCase();
  if (word.length < 2 || word.length > MAX_TERM_LENGTH) return null;
  if (!/[a-z0-9À-￿]/i.test(word)) return null;
  return word;
}

/** What may be saved: only known areas, usable terms, no duplicates, within the limits. */
function normalizeSettings(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const ids = new Set(AREAS.map((a) => a.id));
  const disabledAreas = [...new Set((Array.isArray(s.disabledAreas) ? s.disabledAreas : []).map(String).filter((id) => ids.has(id)))];
  const seen = new Set();
  const extraTerms = [];
  for (const e of Array.isArray(s.extraTerms) ? s.extraTerms : []) {
    const area = e && typeof e === 'object' ? String(e.area || 'custom') : 'custom';
    const term = cleanTerm(e && typeof e === 'object' ? e.term : e);
    if (!term || !(ids.has(area) || area === 'custom')) continue;
    const key = area + '|' + keyOf(term);
    if (seen.has(key)) continue;
    seen.add(key);
    extraTerms.push({ area, term });
    if (extraTerms.length >= MAX_EXTRA_TERMS) break;
  }
  const allowPhrases = [...new Set((Array.isArray(s.allowPhrases) ? s.allowPhrases : []).map(cleanTerm).filter(Boolean))].slice(0, MAX_ALLOW_PHRASES);
  return { disabledAreas, extraTerms, allowPhrases };
}

const compiledCache = new Map();
// Remembered by the settings OBJECT as well: serialize() calls this for every row of a page, and cleaning + stringifying the admin's settings each time made a row
// about 25 times slower once the admin had added a few words. A settings object must therefore never be changed after it has been used (state.settings is replaced, not edited).
const compiledByObject = new WeakMap();

/** The matcher for one set of settings (kept: the same settings serve every request). */
function compile(settings) {
  const isObject = settings !== null && typeof settings === 'object';
  if (isObject) { const known = compiledByObject.get(settings); if (known) return known; }
  const s = normalizeSettings(settings);
  const key = JSON.stringify(s);
  let hit = compiledCache.get(key);
  if (hit) { if (isObject) compiledByObject.set(settings, hit); return hit; }
  const disabled = new Set(s.disabledAreas);
  const areas = AREAS.filter((a) => !disabled.has(a.id)).map((a) => ({ ...a, terms: [...a.terms, ...s.extraTerms.filter((e) => e.area === a.id).map((e) => e.term)] }));
  const custom = s.extraTerms.filter((e) => e.area === 'custom').map((e) => e.term);
  if (custom.length) areas.push({ ...CUSTOM_AREA, terms: custom });
  const byKey = new Map(); // spelling-independent term -> its area (the first area that lists it wins)
  const all = [];
  for (const area of areas) {
    for (const term of area.terms) {
      const k = keyOf(term);
      if (!k) continue;
      if (!byKey.has(k)) byKey.set(k, area);
      all.push(term);
    }
  }
  // Context rules (config/ebayPolicyRules.js): a hit for these terms is dropped when one of the `unless` words is in the same text ("Wii controllers with
  // nunchucks", "counterfeit money detector pen") - or in the TITLE, for a hit in another field (a real store's "Rubber Training Nunchucks" says "Nunchakus" in a
  // bullet point and in a specification; the title says what the product is). A word in the description never excuses the title. Only for the area that owns the term.
  const unlessByKey = new Map();
  for (const area of areas) {
    for (const rule of area.contextRules || []) {
      const words = (rule.unless || []).map((w) => keyOfWord(w)).filter(Boolean);
      if (!words.length) continue;
      const re = new RegExp('(^|[^a-z0-9])(?:' + words.join('|') + ')(?=$|[^a-z0-9])', 'i');
      for (const t of rule.terms || []) if (byKey.get(keyOf(t)) === area) unlessByKey.set(keyOf(t), re);
    }
  }
  const pattern = buildPattern(all);
  const allowPattern = buildPattern([...ALLOW_PHRASES, ...s.allowPhrases]);
  hit = {
    settings: s,
    areas,
    byKey,
    unlessByKey,
    re: pattern ? new RegExp(pattern.source, pattern.flags) : null,
    allowRe: allowPattern ? new RegExp(allowPattern.source, allowPattern.flags) : null,
  };
  compiledCache.set(key, hit);
  if (compiledCache.size > 50) compiledCache.delete(compiledCache.keys().next().value);
  if (isObject) compiledByObject.set(settings, hit);
  return hit;
}

// The settings the sync callers (serialize() of every listing row) use; refreshed from the database by refreshSettings.
const state = { settings: normalizeSettings({}), loadedAt: 0, loading: null };
const REFRESH_MS = 60 * 1000;
const RETRY_MS = 15 * 1000; // after a failed read

// Replaceable for tests. Without a connection the read is skipped: a query would only wait (mongoose buffers it for 10 s) and then fail.
const deps = { isConnected: () => require('mongoose').connection.readyState === 1 };

/** Loads the admin's settings (at most once a minute). Never throws: on a failure the last good settings, or the defaults, stay in use. */
async function refreshSettings({ force = false } = {}) {
  if (!force && Date.now() - state.loadedAt < REFRESH_MS) return state.settings;
  if (!deps.isConnected()) return state.settings;
  if (state.loading) return state.loading;
  state.loading = (async () => {
    try {
      const Settings = require('../models/schemas/Settings');
      const doc = await Settings.findOne({ key: 'global' }, { ebayPolicy: 1 }).lean();
      state.settings = normalizeSettings(doc && doc.ebayPolicy);
      state.loadedAt = Date.now();
    } catch (err) {
      state.loadedAt = Date.now() - REFRESH_MS + RETRY_MS; // try again in RETRY_MS, not on every request
      console.warn('[ebay-policy] could not load the admin settings, using the last ones:', err.message);
    } finally {
      state.loading = null;
    }
    return state.settings;
  })();
  return state.loading;
}

/** The admin just saved: used at once (the next refresh would only repeat it). */
function setSettings(raw) {
  state.settings = normalizeSettings(raw);
  state.loadedAt = Date.now();
  return state.settings;
}

const currentSettings = () => state.settings;

// ---------------------------------------------------------------------------------------------------------------------------------------------

const asList = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]);
const MEDIA_CATEGORY = /\b(books?|kindle|audible|audiobooks?|movies?|tv series|music|cds?|vinyl|dvds?|blu-?rays?|video games?)\b/i;

/** Books, films, music and games may be ABOUT a subject the areas forbid ("The Cocaine Chronicles"): those areas are not applied to them. */
function isMedia(categories) {
  return asList(categories).some((c) => MEDIA_CATEGORY.test(String(c == null ? '' : c)));
}

const FIELD_NAMES = { title: 'title', description: 'description', bulletPoints: 'bullet points', specifications: 'specifications', aspects: 'item specifics', brand: 'brand' };

/**
 * Everything a listing's text names from the list.
 * @param {{ title?, description?, bulletPoints?, specifications?: {name,value}[], aspects?: Object, brand?, categories? }} listing
 * @param {{ settings?: object }} [options] the admin's settings (default: the current ones)
 * @returns {{ areaId: string, label: string, reason: string, url: string|null, term: string, field: string }[]}
 */
function scanDetailed(listing, options = {}) {
  if (!listing) return [];
  const c = compile(options.settings || state.settings);
  if (!c.re) return [];
  const media = isMedia(listing.categories);
  const hits = [];
  const seen = new Set();
  let titleText = ''; // the title is scanned first; what it says ("Rubber Training Nunchucks") is what the rest of the listing talks about too
  const scan = (field, raw) => {
    if (raw == null || raw === '') return;
    let text = fold(String(raw).replace(/<[^>]*>/g, ' ')).toLowerCase();
    if (!text) return;
    if (c.allowRe) { c.allowRe.lastIndex = 0; text = text.replace(c.allowRe, '$1 '); }
    if (field === 'title') titleText = text;
    const re = c.re;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const termKey = keyOf(m[2]);
      const area = c.byKey.get(termKey);
      const harmless = c.unlessByKey.get(termKey);
      if (area && !(media && area.mediaExempt) && !(harmless && (harmless.test(text) || (titleText && harmless.test(titleText))))) {
        const k = area.id + '|' + termKey;
        if (!seen.has(k)) { seen.add(k); hits.push({ areaId: area.id, label: area.label, reason: area.reason, url: area.url, term: m[2], field }); }
      }
      if (m[0].length === 0) re.lastIndex += 1;
    }
  };
  scan('title', listing.title);
  scan('description', listing.description);
  asList(listing.bulletPoints).forEach((b) => scan('bulletPoints', b));
  asList(listing.specifications).forEach((s) => { scan('specifications', s && s.name); scan('specifications', s && s.value); });
  const aspects = listing.aspects && typeof listing.aspects === 'object' ? listing.aspects : {};
  Object.entries(aspects).forEach(([name, values]) => { scan('aspects', name); asList(values).forEach((v) => scan('aspects', v)); });
  scan('brand', listing.brand);
  return hits;
}

/** The matched terms only (lowercase, deduped): what the rows have always carried as policy_warning_terms. */
function scanListing(listing) {
  return [...new Set(scanDetailed(listing).map((h) => h.term))];
}

/** The words a person is shown for the first (most serious) problem found. */
function describe(hits) {
  if (!hits || !hits.length) return '';
  const h = hits[0];
  const more = hits.length > 1 ? ` (${hits.length - 1} more problem${hits.length === 2 ? '' : 's'} found)` : '';
  return `Not allowed on eBay (${h.label}): "${h.term}" is in the ${FIELD_NAMES[h.field] || h.field}. ${h.reason} ELMS will not list this product${more}.`;
}

/**
 * The verdict for one listing: the text that would reach eBay (the listing's own text where the person edited it, the imported product's
 * otherwise - the same choice the publish makes) against the list.
 * @param {object} listing the ELMS listing (title, description, bullet_points, specifications, ebay_aspects)
 * @param {object} product the imported product it came from (title, description, bulletPoints, specifications, ebayAspects, brand, categories)
 */
function checkListing(listing, product, options = {}) {
  const l = listing || {};
  const p = product || {};
  const hits = scanDetailed({
    title: l.title || p.title,
    description: l.description || p.description,
    bulletPoints: Array.isArray(l.bullet_points) && l.bullet_points.length ? l.bullet_points : p.bulletPoints,
    specifications: Array.isArray(l.specifications) && l.specifications.length ? l.specifications : p.specifications,
    aspects: l.ebay_aspects && typeof l.ebay_aspects === 'object' && Object.keys(l.ebay_aspects).length ? l.ebay_aspects : p.ebayAspects,
    brand: p.brand,
    categories: p.categories,
  }, options);
  return { blocked: hits.length > 0, hits, message: describe(hits) };
}

module.exports = {
  scanListing, scanDetailed, checkListing, describe,
  refreshSettings, setSettings, currentSettings, normalizeSettings, compile, deps,
  AREAS, ALLOW_PHRASES, MAX_EXTRA_TERMS, MAX_ALLOW_PHRASES, MAX_TERM_LENGTH,
};
