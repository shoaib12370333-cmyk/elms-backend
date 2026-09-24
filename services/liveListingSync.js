// Helpers for keeping a LIVE eBay listing and ELMS' copy of it in step: reading what eBay really holds (offer + inventory item),
// merging item specifics the way a partial edit needs, and telling the seller exactly what eBay did not take.
// Pure functions - the eBay calls themselves live in ebayListingService.

const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');
const lc = (s) => norm(s).toLowerCase();
const stripHtml = (s) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();

// Details of a product that eBay takes from its catalog when the listing is matched to one (ePID): they cannot be changed per listing.
const CATALOG_LOCKED = new Set(['brand', 'mpn', 'upc', 'ean', 'isbn', 'model', 'manufacturer part number', 'type']);

/** What eBay holds for a live listing, in one plain object. offer = GET offer, item = GET inventory_item. */
function normalizeLive(offer, item) {
  const p = (item && item.product) || {};
  const price = Number(offer?.pricingSummary?.price?.value);
  const qty = offer?.availableQuantity ?? item?.availability?.shipToLocationAvailability?.quantity;
  return {
    title: String(p.title || ''),
    description: String(offer?.listingDescription || p.description || ''),
    imageUrls: Array.isArray(p.imageUrls) ? p.imageUrls.filter(Boolean) : [],
    aspects: p.aspects && typeof p.aspects === 'object' ? p.aspects : {},
    hasBrandField: Object.prototype.hasOwnProperty.call(p, 'brand'),
    epid: p.epid || null,
    condition: item?.condition || null,
    price: Number.isFinite(price) ? price : null,
    currency: offer?.pricingSummary?.price?.currency || null,
    quantity: Number.isFinite(Number(qty)) ? Number(qty) : null,
    categoryId: offer?.categoryId ? String(offer.categoryId) : null,
    policies: {
      paymentPolicyId: offer?.listingPolicies?.paymentPolicyId || null,
      fulfillmentPolicyId: offer?.listingPolicies?.fulfillmentPolicyId || null,
      returnPolicyId: offer?.listingPolicies?.returnPolicyId || null,
    },
    merchantLocationKey: offer?.merchantLocationKey || null,
    listingId: offer?.listing?.listingId || null,
    offerStatus: offer?.status || null,
  };
}

/** eBay's aspects ({ Brand: ['X'] }) as the plain { name: [values] } ELMS keeps on a listing. */
function aspectsForListing(aspects) {
  const out = {};
  for (const [name, values] of Object.entries(aspects || {})) {
    const list = (Array.isArray(values) ? values : [values]).map((v) => norm(v)).filter(Boolean);
    if (name && list.length) out[name] = list;
  }
  return out;
}

const keyOf = (obj, name) => Object.keys(obj || {}).find((k) => lc(k) === lc(name));

/**
 * The item specifics to send for a partial edit: everything eBay already holds, with the sent ones replacing theirs by name
 * (case does not matter) and the names in `clear` taken off. The editor only shows the specifics of the category, so sending its
 * values alone used to wipe every other item specific of the listing.
 */
function mergeAspects(current, sent, clear = []) {
  const out = {};
  const cleared = new Set((clear || []).map(lc));
  for (const [name, values] of Object.entries(current || {})) {
    if (!cleared.has(lc(name))) out[name] = values;
  }
  for (const [name, values] of Object.entries(sent || {})) {
    const old = keyOf(out, name);
    if (old) delete out[old];
    out[name] = values;
  }
  return out;
}

function firstValue(aspects, name) {
  const k = keyOf(aspects, name);
  const v = k ? aspects[k] : null;
  return norm(Array.isArray(v) ? v[0] : v) || null;
}

const listText = (v) => (Array.isArray(v) ? v : [v]).map(norm).filter(Boolean).join(', ');

/**
 * What the seller asked for against what eBay holds afterwards.
 * intent: { title, price, quantity, categoryId, aspects, clearAspects, description, imageCount, policies, merchantLocationKey }
 * (a field that was not part of the edit is left out and is not compared). Returns [{ field, label, sent, ebay, reason }].
 */
function compareLive(intent, live) {
  const out = [];
  const add = (field, label, sent, ebay, reason) => out.push({ field, label, sent: sent == null ? '' : String(sent), ebay: ebay == null ? '' : String(ebay), reason });
  if (!live) return out;

  if (intent.title !== undefined && norm(String(intent.title).slice(0, 80)) !== norm(live.title)) {
    add('title', 'Title', norm(intent.title).slice(0, 80), live.title, 'eBay kept its own title. eBay usually only lets a title change while the listing has no sales or bids.');
  }
  if (intent.price !== undefined && live.price !== null && Math.abs(Number(intent.price) - live.price) > 0.005) {
    add('price', 'Price', Number(intent.price).toFixed(2), live.price.toFixed(2), 'eBay kept its own price.');
  }
  if (intent.quantity !== undefined && live.quantity !== null && Number(intent.quantity) !== live.quantity) {
    add('quantity', 'Quantity', intent.quantity, live.quantity, 'eBay kept its own quantity.');
  }
  if (intent.categoryId && live.categoryId && String(intent.categoryId) !== live.categoryId) {
    add('category', 'Category', intent.categoryId, live.categoryId, 'eBay kept the category. A category can usually not be changed on a live listing that has sales.');
  }
  for (const [name, values] of Object.entries(intent.aspects || {})) {
    const k = keyOf(live.aspects, name);
    const want = (Array.isArray(values) ? values : [values]).map(lc).filter(Boolean).sort();
    const have = k ? (Array.isArray(live.aspects[k]) ? live.aspects[k] : [live.aspects[k]]).map(lc).filter(Boolean).sort() : [];
    if (JSON.stringify(want) !== JSON.stringify(have)) {
      const locked = live.epid && CATALOG_LOCKED.has(lc(name));
      add('aspect:' + name, name, listText(values), k ? listText(live.aspects[k]) : '',
        locked ? 'This listing is matched to an eBay catalog product (ePID). eBay controls ' + name + ' from the catalog, so it cannot be changed here.' : 'eBay kept its own value for this item specific.');
    }
  }
  for (const name of intent.clearAspects || []) {
    const k = keyOf(live.aspects, name);
    if (k && !(intent.aspects && keyOf(intent.aspects, name))) add('aspect:' + name, name, '', listText(live.aspects[k]), 'eBay kept this item specific (it may be required for the category).');
  }
  if (intent.description !== undefined) {
    const a = stripHtml(intent.description).slice(0, 120).toLowerCase();
    const b = stripHtml(live.description).slice(0, 120).toLowerCase();
    if (a && a !== b) add('description', 'Description', stripHtml(intent.description).slice(0, 80), stripHtml(live.description).slice(0, 80), 'eBay shows a different description (it removes some HTML).');
  }
  if (intent.imageCount !== undefined && live.imageUrls.length !== intent.imageCount) {
    add('images', 'Pictures', intent.imageCount, live.imageUrls.length, 'eBay took a different number of pictures (it rejects pictures it cannot download or that are too small).');
  }
  const P = { paymentPolicyId: 'Payment policy', fulfillmentPolicyId: 'Shipping policy', returnPolicyId: 'Return policy' };
  for (const [key, label] of Object.entries(P)) {
    const want = intent.policies?.[key];
    if (want && live.policies[key] && String(want) !== String(live.policies[key])) add('policy:' + key, label, want, live.policies[key], 'eBay kept the previous policy.');
  }
  if (intent.merchantLocationKey && live.merchantLocationKey && intent.merchantLocationKey !== live.merchantLocationKey) {
    add('location', 'Item location', intent.merchantLocationKey, live.merchantLocationKey, 'eBay kept the previous item location.');
  }
  return out;
}

module.exports = { normalizeLive, aspectsForListing, mergeAspects, firstValue, compareLive, stripHtml, CATALOG_LOCKED };
