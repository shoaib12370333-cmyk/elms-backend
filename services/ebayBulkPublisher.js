/**
 * Publishes many listings with eBay's BULK calls instead of four calls each.
 *
 * One listing the old way = inventory item (PUT) + look for an existing offer (GET) + create offer (POST) + publish (POST): four eBay
 * calls. eBay's Inventory API takes up to 25 of each step in one call: bulkCreateOrReplaceInventoryItem, bulkCreateOffer,
 * bulkPublishOffer. A list of 1000 listings is then about 120 calls instead of about 4000.
 *
 * How it fits in: the publish worker publishes each listing on its own (credit, checks, marks, refunds), and calls publish() here in
 * place of publishListing() - same arguments, same answer. Listings that ask at about the same time (for the same eBay account and
 * marketplace) are collected for a moment (WINDOW_MS, or until 25 are there) and sent together. So the worker needs no change of shape:
 * it only runs more listings at the same time (PUBLISH_CONCURRENCY) so batches fill up.
 *
 * Safety: anything unusual never loses a listing. If a bulk call fails as a whole (timeout, 5xx, 429, an answer we cannot read), or eBay
 * says an offer already exists, or an answer for a listing is missing, THAT listing goes through the ordinary one-at-a-time publishListing
 * (which already knows how to reuse an existing offer). A listing eBay refuses with a real error (missing item specific ...) is failed with
 * eBay's own words, like the ordinary path. Off by default: set EBAY_BULK_PUBLISH=1.
 */
const listing = require('./ebayListingService');
const { getMarketplaceLocale } = require('../config/ebayMarketplaces');

const CHUNK = 25; // eBay's limit per bulk call
const CALL_TIMEOUT_MS = 2 * 60 * 1000; // a bulk call of 25 listings takes longer than a single one (eBay reads the pictures while publishing)
const MAX_CHAINS = 3; // bulk chains running at the same time for one eBay account and marketplace
const windowMs = () => Math.max(100, Number(process.env.BULK_PUBLISH_WINDOW_MS) || 1500);

const isEnabled = () => ['1', 'true', 'on', 'yes'].includes(String(process.env.EBAY_BULK_PUBLISH || '').trim().toLowerCase());

// Replaceable for tests.
const deps = {
  request: (...args) => listing.ebayRequest(...args),
  single: (args) => listing.publishListing(args),
  buildBodies: (args) => listing.buildListingBodies(args),
  describe: (e) => listing.describeEbayError(e),
};

const groups = new Map(); // "token|marketplace" -> { items: [], timer, active }

/** An error shaped like the ones the ordinary path throws (message, statusCode, ebayErrors), so the worker treats it the same way. */
function itemError(r, fallbackMessage) {
  const errors = Array.isArray(r && r.errors) ? r.errors : [];
  const err = new Error(errors.length ? errors.map((e) => deps.describe(e)).join('; ') : (fallbackMessage || 'eBay did not accept this listing.'));
  err.statusCode = (r && Number(r.statusCode)) || 400;
  err.ebayErrors = errors;
  return err;
}

const okStatus = (r) => !!r && Number(r.statusCode) >= 200 && Number(r.statusCode) < 300;

/** eBay answers a bulk call with `responses` in the order of the requests; they are matched by the key they carry, else by position. */
function matchResponses(responses, items, keyOf, requestKey) {
  const list = Array.isArray(responses) ? responses : [];
  const byKey = new Map();
  for (const r of list) { const k = keyOf(r); if (k) byKey.set(String(k), r); }
  return items.map((item, i) => {
    const k = requestKey(item);
    if (byKey.has(String(k))) return byKey.get(String(k));
    return list.length === items.length && !keyOf(list[i]) ? list[i] : null; // no key in the answer: by position, only if the counts agree
  });
}

async function viaSingle(item) {
  try { item.resolve(await deps.single(item.args)); } catch (err) { item.reject(err); }
}

/** Publishes these listings one at a time, three at once (the ordinary path). */
async function fallbackAll(items) {
  let next = 0;
  const workers = Array.from({ length: Math.min(3, items.length) }, async () => {
    for (;;) { const i = next; next += 1; if (i >= items.length) return; await viaSingle(items[i]); }
  });
  await Promise.all(workers);
}

async function bulkCall(chunk, path, requests) {
  const first = chunk[0].bodies;
  return deps.request(chunk[0].args.refreshToken, 'POST', path, { requests }, {
    marketplaceId: first.marketplaceId,
    deadlineAt: Date.now() + CALL_TIMEOUT_MS,
    maxTimeoutMs: CALL_TIMEOUT_MS,
    timeoutMessage: 'eBay timed out while publishing a group of listings.',
  });
}

async function processChunk(allItems) {
  const summary = { published: 0, refused: 0 };
  for (const item of allItems) {
    const { resolve, reject } = item;
    item.resolve = (v) => { summary.published += 1; resolve(v); };
    item.reject = (e) => { summary.refused += 1; reject(e); };
  }
  // The same SKU twice in one call would make the answers ambiguous: the second goes the ordinary way.
  const seen = new Set();
  const chunk = [];
  const duplicates = [];
  for (const item of allItems) {
    if (seen.has(item.bodies.finalSku)) duplicates.push(item); else { seen.add(item.bodies.finalSku); chunk.push(item); }
  }
  if (duplicates.length) fallbackAll(duplicates).catch(() => {});
  if (!chunk.length) return;
  const locale = String(getMarketplaceLocale(chunk[0].bodies.marketplaceId) || 'en-US').replace('-', '_');

  // ---- 1. inventory items ----
  let inv;
  try {
    inv = await bulkCall(chunk, '/sell/inventory/v1/bulk_create_or_replace_inventory_item', chunk.map((i) => ({ sku: i.bodies.finalSku, locale, ...i.bodies.inventoryItemBody })));
  } catch (err) {
    return fallbackAll(chunk);
  }
  const invAnswers = matchResponses(inv && inv.responses, chunk, (r) => r && r.sku, (i) => i.bodies.finalSku);
  const forOffers = [];
  const toSingle = [];
  chunk.forEach((item, i) => {
    const r = invAnswers[i];
    if (!r) toSingle.push(item); // no answer for it: the ordinary path settles it
    else if (okStatus(r)) forOffers.push(item);
    else item.reject(itemError(r, 'eBay did not accept the inventory item.'));
  });

  // ---- 2. offers ----
  let publishable = [];
  if (forOffers.length) {
    let off = null;
    try {
      off = await bulkCall(forOffers, '/sell/inventory/v1/bulk_create_offer', forOffers.map((i) => i.bodies.offerBody));
    } catch (err) {
      toSingle.push(...forOffers); // the offers may or may not exist now: the ordinary path finds and reuses them
    }
    if (off) {
      const offAnswers = matchResponses(off.responses, forOffers, (r) => r && r.sku, (i) => i.bodies.finalSku);
      forOffers.forEach((item, i) => {
        const r = offAnswers[i];
        if (!r) toSingle.push(item);
        else if (okStatus(r) && r.offerId) { item.offerId = String(r.offerId); publishable.push(item); }
        else if (/already exists/i.test(JSON.stringify(r.errors || []))) toSingle.push(item); // an offer for this SKU is there: reuse it (ordinary path)
        else item.reject(itemError(r, 'eBay did not create the offer.'));
      });
    }
  }

  // ---- 3. publish ----
  if (publishable.length) {
    let pub = null;
    try {
      pub = await bulkCall(publishable, '/sell/inventory/v1/bulk_publish_offer', publishable.map((i) => ({ offerId: i.offerId })));
    } catch (err) {
      toSingle.push(...publishable); // may have been published: the ordinary path sees the offer's state
      publishable = [];
    }
    if (pub) {
      const pubAnswers = matchResponses(pub.responses, publishable, (r) => r && r.offerId, (i) => i.offerId);
      publishable.forEach((item, i) => {
        const r = pubAnswers[i];
        if (!r) toSingle.push(item);
        else if (okStatus(r) && r.listingId) item.resolve({ sku: item.bodies.finalSku, offerId: item.offerId, listingId: String(r.listingId), imageUrls: item.bodies.imageUrls || [] });
        else item.reject(itemError(r, 'eBay did not publish the offer.'));
      });
    }
  }

  const started = Date.now();
  if (toSingle.length) await fallbackAll(toSingle);
  if (process.env.NODE_ENV !== 'test') {
    console.log('[bulk-publish] group of ' + allItems.length + ': ' + summary.published + ' published, ' + summary.refused + ' failed, '
      + toSingle.length + ' of them sent the ordinary way' + (toSingle.length ? ' (' + (Date.now() - started) + ' ms)' : '') + '.');
  }
}

/**
 * Sends the waiting listings of a group. A full 25 goes at once; fewer only when `force` (the wait is over, or a chain just ended and
 * they have been waiting for it). The rest waits for the timer.
 */
function flush(group, force) {
  if (group.timer) { clearTimeout(group.timer); group.timer = null; }
  while (group.items.length && group.active < MAX_CHAINS && (force || group.items.length >= CHUNK)) {
    const chunk = group.items.splice(0, CHUNK);
    group.active += 1;
    processChunk(chunk)
      .catch((err) => { chunk.forEach((item) => item.reject(err)); }) // never leave a listing waiting (rejecting twice is harmless)
      .finally(() => {
        group.active -= 1;
        if (group.items.length) flush(group, true);
        else if (!group.active) groups.delete(group.key);
      });
  }
  if (group.items.length && !group.timer && group.active < MAX_CHAINS) group.timer = setTimeout(() => flush(group, true), windowMs());
}

/**
 * Same arguments and same answer as publishListing(): { sku, offerId, listingId, imageUrls }. Rejects with the same kind of error.
 */
function publish(args) {
  return new Promise((resolve, reject) => {
    let bodies;
    try { bodies = deps.buildBodies(args); } catch (err) { reject(err); return; } // a missing policy / category fails at once, like before
    const key = args.refreshToken + '|' + bodies.marketplaceId;
    let group = groups.get(key);
    if (!group) { group = { key, items: [], timer: null, active: 0 }; groups.set(key, group); }
    group.items.push({ args, bodies, resolve, reject, offerId: null });
    if (group.items.length >= CHUNK) flush(group, false);
    else if (!group.timer) group.timer = setTimeout(() => flush(group, true), windowMs());
  });
}

module.exports = { publish, isEnabled, deps, CHUNK, _groups: groups };
