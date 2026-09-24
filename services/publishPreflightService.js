const { getItemAspectsForCategory } = require('./ebayTaxonomyService');
const { buildAspects } = require('./ebayListingService');

// Amazon pastes invisible direction marks (U+200E etc.) in front of many values; they must not break matching.
const { stripInvisible } = require('./textCleanService');
const norm = (v) => stripInvisible(v || '').trim().toLowerCase().replace(/\s+/g, ' ');

// Allowed values that say nothing about the product, so they are never picked by matching text.
const VAGUE_VALUE = /^(other|does not apply|not applicable|not specified|unbranded|multi|multicolor|multicoloured|multicolour|assorted|none|unknown|yes|no)$/;
const words = (v) => norm(v).replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Allowed values (from eBay's list) that the text names as whole words, in the order the text mentions them.
 * @returns {string[]} at most `limit` values
 */
function wordsIn(text, choices, limit) {
  const haystack = ' ' + words(text) + ' ';
  const hits = [];
  for (const choice of choices) {
    const needle = words(choice);
    if (needle.length < 3 || VAGUE_VALUE.test(needle)) continue;
    const at = haystack.indexOf(' ' + needle + ' ');
    if (at >= 0) hits.push({ choice, at, length: needle.length });
  }
  hits.sort((a, b) => a.at - b.at || b.length - a.length);
  return hits.slice(0, limit).map((h) => h.choice);
}

/** A number for a required NUMBER aspect: from a specification with a similar name, or "12-pack" style wording in the title. */
function numberFromFacts(def, product) {
  const want = norm(def.name);
  for (const s of product.specifications || []) {
    const name = norm(s && s.name);
    if (name.length < 3 || !(name === want || name.includes(want) || want.includes(name))) continue;
    const m = String(s.value || '').match(/\d+(?:[.,]\d+)?/);
    if (m) return m[0].replace(',', '.');
  }
  if (/piece|pack|count|quantity|number of|pcs/.test(want)) {
    const m = String(product.title || '').match(/(\d+)\s*-?\s*(?:pack|pcs|pc|pieces|piece|count|ct)\b/i);
    if (m) return m[1];
  }
  return null;
}

/**
 * Makes the item specifics of a listing acceptable to eBay BEFORE anything is sent:
 *  - aspects eBay lets you only choose from a list are matched to that list (a value that is not on it is dropped),
 *  - required aspects nobody filled get eBay's accepted "not applicable" value (Brand -> Unbranded, others -> Does not apply)
 *    where the category allows it,
 *  - if a required aspect still has no acceptable value the publish stops with a message that names it,
 *  - a category eBay does not know on this marketplace stops the publish with a clear message.
 * The category lookup is cached; if eBay's taxonomy is unreachable the listing is sent as it is.
 *
 * @returns {Promise<{ aspects: Object<string,string[]>|null, notes: string[] }>}
 */
async function prepareAspects(args) {
  const out = await checkAspects(args);
  if (out.missing.length) {
    const e = new Error('eBay requires these item specifics for this category and they are empty: ' + out.missing.join(', ') + '. Open the draft → Item Specifications and fill them (or press Fill with AI), then publish again.');
    e.statusCode = 400;
    throw e;
  }
  return { aspects: out.aspects, notes: out.notes };
}

/**
 * The same work as prepareAspects, but a required item specific that cannot be filled is REPORTED (missing) instead of
 * thrown, so the AI filler can save everything else and tell the seller exactly what is left.
 * fillRequired: false stops after matching the passed-in values (no "Unbranded" / "Does not apply" / product-text fill for the rest).
 * aspectsOnly: keep only the item specifics that were passed in (product.ebayAspects) - the Amazon specifications and
 * brand are still read as facts, but are not turned into item specifics (that is what publishing does).
 * @returns {Promise<{ aspects: Object<string,string[]>|null, notes: string[], missing: string[] }>}
 */
async function checkAspects({ categoryId, marketplaceId, product, aspectsOnly = false, fillRequired = true }) {
  const notes = [];
  const merged = buildAspects(aspectsOnly ? { ebayAspects: product.ebayAspects } : product);
  let defs;
  try {
    defs = (await getItemAspectsForCategory(null, categoryId, marketplaceId)).aspects || [];
  } catch (err) {
    if (err.statusCode === 404 || err.statusCode === 400) {
      const e = new Error('eBay does not recognise category ' + categoryId + ' on ' + marketplaceId + ' (each eBay site has its own category numbers). Pick the category again in the editor.');
      e.statusCode = 400;
      throw e;
    }
    return { aspects: null, notes: ['category lookup unavailable, sent as is'], missing: [] };
  }
  if (!defs.length) return { aspects: merged, notes, missing: [] };

  const byName = new Map(defs.map((d) => [norm(d.name), d]));
  const final = {};
  const factsText = [product.title, product.description, ...(product.bulletPoints || []), ...(product.specifications || []).map((s) => (s.name || '') + ' ' + (s.value || ''))].join(' \n ');
  for (const [name, values] of Object.entries(merged)) {
    const def = byName.get(norm(name));
    let vals = values.slice();
    const choices = def ? (def.allValues || def.values || []) : [];
    if (def && def.mode === 'SELECTION_ONLY' && choices.length) {
      const allowed = new Map(choices.map((v) => [norm(v), v]));
      let kept = vals.map((v) => allowed.get(norm(v))).filter(Boolean);
      // "Black/Silver" is not on eBay's list but "Black" is and the seller's own value names it.
      if (!kept.length) kept = wordsIn(vals.join(' '), choices, def.cardinality === 'MULTI' ? 3 : 1);
      if (!kept.length) notes.push('dropped "' + name + '" (' + vals.join(', ') + ' is not one of eBay\'s allowed values)');
      vals = kept;
    }
    if (def && def.cardinality !== 'MULTI') vals = vals.slice(0, 1);
    if (vals.length) final[def ? def.name : name] = vals;
  }

  // fillRequired: false = only match what was passed in (a partial edit of a live listing must not fill the other required ones).
  if (!fillRequired) return { aspects: final, notes, missing: [] };

  const missing = [];
  for (const def of defs) {
    if (!def.required || final[def.name]) continue;
    const list = def.allValues || def.values || [];
    const pick = (wanted) => list.find((v) => norm(v) === norm(wanted));
    const isBrand = norm(def.name) === 'brand';
    // "Does not apply" is text: it is not an acceptable value for a number or date aspect.
    const textAspect = !def.dataType || def.dataType === 'STRING';
    let value = null;
    if (list.length) value = (isBrand && pick('Unbranded')) || pick('Does not apply') || null;
    // A FREE_TEXT aspect only SUGGESTS values (Brand has thousands), so "Unbranded" / "Does not apply" are fine even when
    // they are not on its list; only a "choose from" aspect needs one of the listed values.
    if (!value && textAspect && (!list.length || def.mode === 'FREE_TEXT')) value = isBrand ? 'Unbranded' : 'Does not apply';
    if (value) { final[def.name] = [value]; notes.push('"' + def.name + '" was empty, set to ' + value); continue; }

    // Nothing "not applicable" is allowed here, so use what the product itself says: an allowed value that
    // its title / bullets / specifications name, or a number from its specifications.
    const found = list.length ? wordsIn(factsText, list, def.cardinality === 'MULTI' ? 3 : 1) : [];
    const number = !list.length && def.dataType === 'NUMBER' ? numberFromFacts(def, product) : null;
    if (found.length) { final[def.name] = found; notes.push('"' + def.name + '" was empty, taken from the product text: ' + found.join(', ')); }
    else if (number) { final[def.name] = [number]; notes.push('"' + def.name + '" was empty, taken from the specifications: ' + number); }
    else missing.push(def.name + (list.length ? ' (' + list.slice(0, 5).join(' / ') + (list.length > 5 ? ' ...' : '') + ')' : def.dataType && def.dataType !== 'STRING' ? ' (a ' + def.dataType.toLowerCase() + ')' : ''));
  }
  return { aspects: final, notes, missing };
}

/**
 * Stops a publish early, with a clear message, when the category is not one eBay accepts listings in:
 * unknown on this marketplace (each site has its own category numbers) or not a leaf (too general).
 * If eBay's taxonomy is unreachable the publish is not blocked.
 */
async function assertUsableCategory({ categoryId, marketplaceId }) {
  const { getCategoryInfo } = require('./ebayTaxonomyService');
  let info;
  try {
    info = await getCategoryInfo(null, categoryId, marketplaceId);
  } catch (err) {
    if (err.statusCode === 404 || err.statusCode === 400) {
      const e = new Error('eBay does not recognise category ' + categoryId + ' on ' + marketplaceId + ' (each eBay site has its own category numbers). Pick the category again in the editor.');
      e.statusCode = 400;
      throw e;
    }
    return;
  }
  if (!info.isLeaf) {
    const hint = info.childNames.length ? ' Pick a more specific one, for example: ' + info.childNames.join(', ') + '.' : ' Pick a more specific category.';
    const e = new Error('Category ' + categoryId + (info.name ? ' ("' + info.name + '")' : '') + ' is too general - eBay only accepts listings in a final (most specific) category.' + hint);
    e.statusCode = 400;
    throw e;
  }
}

module.exports = { prepareAspects, checkAspects, assertUsableCategory };
