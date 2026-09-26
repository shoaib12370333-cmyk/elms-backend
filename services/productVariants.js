/**
 * ELMS lists ONE product per link: the product whose link was pasted. The other colours / sizes of the same Amazon page are not
 * imported, kept or shown. Every source (Easyparser, Canopy, the browser extension) marks the product itself as `isCurrentProduct`,
 * and it is the entry with the product's own ASIN.
 */

/** The entry of `variants` that is the product itself (at most one); [] when the list does not have it. */
function ownVariantOnly(variants, asin) {
  const list = Array.isArray(variants) ? variants : [];
  const mine = String(asin || '').trim().toUpperCase();
  // The product's own ASIN is the surest sign; the flag the sources set is the second.
  const own = (mine && list.find((v) => v && String(v.asin || '').trim().toUpperCase() === mine)) || list.find((v) => v && v.isCurrentProduct === true);
  return own ? [own] : [];
}

/** Cuts an imported product down to itself (before it is saved). Returns the same object. */
function onlyThisProduct(product) {
  if (!product || typeof product !== 'object') return product;
  product.variants = ownVariantOnly(product.variants, product.asin);
  product.variantDimensions = [];
  return product;
}

module.exports = { ownVariantOnly, onlyThisProduct };
