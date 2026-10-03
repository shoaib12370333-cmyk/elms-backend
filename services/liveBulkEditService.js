/**
 * The Live Listings page's "Bulk edit": title, brand, quantity, item location, policies, tags, note and stock/price
 * monitoring for many LIVE (or sold-out) listings at once - unlike Drafts' own Bulk edit (services/bulkEditService.js
 * bulkEdit), which only ever saves ELMS's own copy, a live listing's eBay-facing fields are pushed to eBay first
 * (one reviseActiveListing call covers all of them together) and ELMS only keeps a copy once eBay has taken it.
 * Price has its own page action ("Change price", services/liveBulkPriceService.js) and its own eBay bulk endpoint -
 * it is refused here rather than silently ignored, so a seller never wonders why ticking it did nothing.
 *
 * Reuses bulkEditService.planDraft AS-IS: it already works out { fields, diff } (or an error) for title/brand/
 * quantity/tags/note/monitoring/location/policies from `changes` + the listing's own serialized fields, with no
 * knowledge of whether the listing is a draft or live - only this file decides what then happens with that plan.
 */
const { planDraft, mapPool } = require('./bulkEditService');
const { reviseActiveListing, createOrGetCustomLocation } = require('./ebayListingService');

const LIVE_STATUSES = ['published', 'sold']; // still live on eBay; a sold-out listing is "live in principle" (models/schemas/Listing.js), same definition liveBulkVeroService.js uses
const PARALLEL = 3; // each changed listing is a full revise (read+write the offer, read+write the inventory item, a verify read) - modest (liveBulkVeroService does 8 at a time: its listings are one AI call plus one revise, not a verify read as well)
// Of everything planDraft can produce, these are the fields eBay itself needs to be told about; everything else
// (tags, note, stockMonitoring, priceMonitoring) is ELMS-only and is simply saved, no eBay call required for it.
const EBAY_FIELD_KEYS = ['title', 'quantity', 'ebayAspects', 'countryLocation', 'locationCity', 'postalCode', 'useDynamicPolicies', 'paymentPolicyId', 'fulfillmentPolicyId', 'returnPolicyId'];

/**
 * @param {{ userId: string, ids: string[], changes: object }} args changes as validated by bulkEditService.validateChanges (never .price - see above)
 * @returns {Promise<{ results: Array<{id, title, status:'changed'|'unchanged'|'skipped', diff?: Array, reason?: string}>, summary: {changed, unchanged, skipped} }>}
 */
async function bulkLiveEdit({ userId, ids, changes }, d) {
  if (changes.price) { const e = new Error('Price is changed with Change price on this page, not here.'); e.statusCode = 400; throw e; }
  const ctx = { userId, getImportById: d.getImportById };
  const found = await d.getListingsByIds(userId, ids);

  // Policies belong to one eBay store (same rule as Drafts' own bulkEdit): chosen policies only make sense when
  // every selected listing is in the same store.
  if (changes.policies && changes.policies.useDynamicPolicies === false) {
    const accounts = new Set(ids.map((id) => (found.get(String(id)) || {}).ebay_account_id || null));
    if (accounts.size !== 1 || accounts.has(null)) {
      const e = new Error('The selected listings are in different stores (or not in one yet). Select listings from one store to pick their policies, or use the account default policies.');
      e.statusCode = 400;
      throw e;
    }
  }

  const tokens = new Map();
  const tokenFor = async (accountId) => {
    if (!tokens.has(accountId)) tokens.set(accountId, Promise.resolve(d.getRefreshToken(userId, accountId)).catch(() => null));
    return tokens.get(accountId);
  };
  const locationKeys = new Map(); // "country|postal" -> Promise<merchantLocationKey>, set before awaiting so concurrent listings share one in-flight request instead of creating the same location twice

  const results = await mapPool(ids, PARALLEL, async (id) => {
    const l = found.get(String(id));
    const title = l ? (l.title || l.sku || id) : null;
    const skip = (reason) => ({ id, title, status: 'skipped', reason });
    if (!l) return skip('Not found.');
    if (!LIVE_STATUSES.includes(String(l.status || '').toLowerCase())) return skip('Only a live (or sold-out) listing can be changed here. A draft is changed with Bulk edit on the Drafts page.');
    if (!l.ebay_offer_id || !l.sku) return skip('This listing has no eBay offer to change.');
    if (!l.ebay_account_id) return skip('No eBay account is connected to this listing.');

    let plan;
    try {
      plan = await planDraft(l, changes, ctx);
    } catch (err) {
      return skip(err.message || 'Could not work out the change.');
    }
    if (plan.error) return skip(plan.error);
    if (!plan.diff.length) return { id, title, status: 'unchanged', diff: [] };

    const ebayFields = Object.fromEntries(Object.entries(plan.fields).filter(([k]) => EBAY_FIELD_KEYS.includes(k)));
    if (Object.keys(ebayFields).length) {
      const refreshToken = await tokenFor(l.ebay_account_id);
      if (!refreshToken) return skip('The connected eBay account is missing its connection. Reconnect it in Settings.');

      let merchantLocationKey;
      if (ebayFields.countryLocation !== undefined || ebayFields.postalCode !== undefined) {
        const country = ebayFields.countryLocation !== undefined ? ebayFields.countryLocation : l.country_location;
        const postal = ebayFields.postalCode !== undefined ? ebayFields.postalCode : l.postal_code;
        if (!country || !postal) return skip('A country and postcode are both needed to set the item location.');
        const key = country + '|' + postal;
        if (!locationKeys.has(key)) locationKeys.set(key, createOrGetCustomLocation(refreshToken, country, postal));
        try { merchantLocationKey = await locationKeys.get(key); }
        catch (err) { return skip(err.message || 'Could not set up that item location on eBay.'); }
      }

      // useDynamicPolicies true = the account's own default policies: nothing explicit to send, same as the
      // single-listing editor's own /:id/revise route (eBay keeps the offer's current policies as they are).
      let policies;
      if (ebayFields.useDynamicPolicies !== true && (ebayFields.paymentPolicyId || ebayFields.fulfillmentPolicyId || ebayFields.returnPolicyId)) {
        policies = { paymentPolicyId: ebayFields.paymentPolicyId, fulfillmentPolicyId: ebayFields.fulfillmentPolicyId, returnPolicyId: ebayFields.returnPolicyId };
      }

      try {
        await reviseActiveListing(refreshToken, {
          offerId: l.ebay_offer_id,
          sku: l.sku,
          title: ebayFields.title || l.title,
          description: l.description,
          aspects: ebayFields.ebayAspects || undefined,
          sellPrice: l.sell_price,
          priceCurrency: l.currency,
          quantity: ebayFields.quantity !== undefined ? ebayFields.quantity : l.quantity,
          categoryId: l.category_id,
          policies,
          merchantLocationKey,
        });
      } catch (err) {
        return skip(err.message || 'eBay did not accept this change.');
      }
    }

    try {
      await d.updateListing(userId, id, { ...plan.fields, markDraftCustomized: false });
    } catch (err) {
      console.warn('[live-bulk-edit] eBay was updated but ELMS could not save its copy for ' + id + ': ' + err.message);
    }
    return { id, title, status: 'changed', diff: plan.diff };
  });

  const count = (s) => results.filter((r) => r.status === s).length;
  return { results, summary: { changed: count('changed'), unchanged: count('unchanged'), skipped: count('skipped') } };
}

module.exports = { bulkLiveEdit, LIVE_STATUSES };
