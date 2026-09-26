/**
 * Product identifiers (UPC / EAN / ISBN) for eBay.
 *
 * Some eBay categories need a barcode. ELMS does not have one for an Amazon product, so publishing such a listing fails with
 * "The UPC field is missing. Please add UPC to the listing and try again. (eBay error 25002)". eBay accepts the text "Does not apply"
 * for a product that has no barcode. Nothing is sent by default (a listing that publishes fine is left exactly as it is): only after
 * eBay says an identifier is missing, that listing is sent once more with "Does not apply" for the identifier(s) eBay named.
 */
const IDENTIFIERS = ['upc', 'ean', 'isbn'];
const NOT_APPLICABLE = 'Does not apply';

/** The identifiers ('upc' | 'ean' | 'isbn') an eBay error says are missing, or [] when it says nothing of the kind. */
function missingIdentifiers(err) {
  if (!err) return [];
  const text = [err.message, ...(Array.isArray(err.ebayErrors) ? err.ebayErrors.map((e) => [e && e.message, e && e.longMessage, ...((e && e.parameters) || []).map((p) => p && p.value)].join(' ')) : [])].join(' ');
  if (!/\b(missing|required)\b/i.test(text)) return [];
  const found = new Set();
  for (const m of text.matchAll(/\b(UPC|EAN|ISBN)\b/gi)) found.add(m[1].toLowerCase());
  return IDENTIFIERS.filter((k) => found.has(k));
}

/** The product fields to add to an inventory item for the identifiers a listing was marked "not applicable" for (nothing by default). */
function identifierFields(product) {
  const marked = product && Array.isArray(product.identifiersNotApplicable) ? product.identifiersNotApplicable : [];
  const out = {};
  for (const key of IDENTIFIERS) if (marked.includes(key)) out[key] = [NOT_APPLICABLE];
  return out;
}

module.exports = { missingIdentifiers, identifierFields, NOT_APPLICABLE, IDENTIFIERS };
