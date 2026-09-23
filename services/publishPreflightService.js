const { getItemAspectsForCategory } = require('./ebayTaxonomyService');
const { buildAspects } = require('./ebayListingService');

const norm = (v) => String(v || '').trim().toLowerCase().replace(/\s+/g, ' ');

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
async function prepareAspects({ categoryId, marketplaceId, product }) {
  const notes = [];
  const merged = buildAspects(product);
  let defs;
  try {
    defs = (await getItemAspectsForCategory(null, categoryId, marketplaceId)).aspects || [];
  } catch (err) {
    if (err.statusCode === 404 || err.statusCode === 400) {
      const e = new Error('eBay does not recognise category ' + categoryId + ' on ' + marketplaceId + ' (each eBay site has its own category numbers). Pick the category again in the editor.');
      e.statusCode = 400;
      throw e;
    }
    return { aspects: null, notes: ['category lookup unavailable, sent as is'] };
  }
  if (!defs.length) return { aspects: merged, notes };

  const byName = new Map(defs.map((d) => [norm(d.name), d]));
  const final = {};
  for (const [name, values] of Object.entries(merged)) {
    const def = byName.get(norm(name));
    let vals = values.slice();
    if (def && def.mode === 'SELECTION_ONLY' && def.values.length) {
      const allowed = new Map(def.values.map((v) => [norm(v), v]));
      const kept = vals.map((v) => allowed.get(norm(v))).filter(Boolean);
      if (!kept.length) notes.push('dropped "' + name + '" (' + vals.join(', ') + ' is not one of eBay\'s allowed values)');
      vals = kept;
    }
    if (def && def.cardinality !== 'MULTI') vals = vals.slice(0, 1);
    if (vals.length) final[def ? def.name : name] = vals;
  }

  const missing = [];
  for (const def of defs) {
    if (!def.required || final[def.name]) continue;
    const list = def.values || [];
    const pick = (wanted) => list.find((v) => norm(v) === norm(wanted));
    const isBrand = norm(def.name) === 'brand';
    let value = null;
    if (list.length) value = (isBrand && pick('Unbranded')) || pick('Does not apply') || null;
    else value = isBrand ? 'Unbranded' : 'Does not apply';
    if (value) { final[def.name] = [value]; notes.push('"' + def.name + '" was empty, set to ' + value); }
    else missing.push(def.name);
  }
  if (missing.length) {
    const e = new Error('eBay requires these item specifics for this category and they are empty: ' + missing.join(', ') + '. Open the draft \u2192 Item Specifications and fill them (or press Fill with AI), then publish again.');
    e.statusCode = 400;
    throw e;
  }
  return { aspects: final, notes };
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

module.exports = { prepareAspects, assertUsableCategory };
