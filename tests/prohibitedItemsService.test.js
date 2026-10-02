// services/prohibitedItemsService.js: a heads-up (never a block) for a listing whose own text names something from
// eBay's "Illegal drugs and drug paraphernalia" policy - confirmed 2026-10-02 against a real takedown. Must not flag
// ordinary, legal products (tobacco pipes, plumbing pipes, coffee grinders - eBay explicitly allows these).
const assert = require('assert');

const { getWords } = require('../config/prohibitedItemWords');
const { scanListing } = require('../services/prohibitedItemsService');

(async () => {
  // ---------- getWords: deduped, sorted, has the real-world example's own terms ----------
  const words = getWords();
  assert.ok(words.includes('bong'));
  assert.ok(words.includes('bongs'));
  assert.ok(words.includes('oil burner pipe'));
  assert.ok(words.includes('dab rig'));
  assert.deepStrictEqual(words, [...new Set(words)].sort(), 'deduped and sorted');

  // ---------- the exact real-world listing that was taken down (the longest match wins at each position - "water
  // bongs" is matched as one term, not "bongs" again separately within it) ----------
  assert.deepStrictEqual(
    scanListing({ title: 'RORA Glass Oil Burner Pipe Thick Clear Glass for Oil Rigs Glass Water Bongs 2 Se' }).sort(),
    ['oil burner pipe', 'oil rigs', 'water bongs'].sort()
  );

  // ---------- a clean, ordinary product: nothing flagged ----------
  assert.deepStrictEqual(scanListing({ title: 'Stainless Steel Kitchen Knife Set, 6 Pieces', description: 'Sharp, dishwasher safe, wooden block included.' }), []);

  // ---------- eBay explicitly allows these - must never be flagged: tobacco pipes, plumbing pipes, coffee grinders ----------
  assert.deepStrictEqual(scanListing({ title: 'Handmade Wooden Tobacco Pipe, Briar Wood' }), [], 'a bare "pipe" is never flagged - eBay allows wood/ceramic/stone pipes');
  assert.deepStrictEqual(scanListing({ title: '1/2 inch Copper Pipe Fitting, 10 Pack' }), [], 'a plumbing pipe is not drug paraphernalia');
  assert.deepStrictEqual(scanListing({ title: 'Electric Coffee Bean Grinder, Stainless Steel' }), [], 'a bare "grinder" is never flagged - only "weed grinder"/"herb grinder" are specific enough');

  // ---------- whole-word matching: "bongo drum" must not match "bong" ----------
  assert.deepStrictEqual(scanListing({ title: 'African Bongo Drum, Hand Carved' }), []);

  // ---------- case-insensitive, and checks description/bulletPoints/specifications too, not just the title ----------
  assert.deepStrictEqual(scanListing({ title: 'Glass Accessory', description: 'Great DAB RIG for home use' }), ['dab rig']);
  assert.deepStrictEqual(scanListing({ title: 'Accessory', bulletPoints: ['Durable', 'Works as a Bubbler Pipe'] }), ['bubbler pipe']);
  assert.deepStrictEqual(scanListing({ title: 'Accessory', specifications: [{ name: 'Type', value: 'Ash Catcher' }] }), ['ash catcher']);

  // ---------- nothing at all / empty listing: no throw, empty result ----------
  assert.deepStrictEqual(scanListing({}), []);
  assert.deepStrictEqual(scanListing(undefined), []);

  // ---------- performance regression guard: models/listingsModel.js's serialize() runs this for every listing row a
  // page shows (Drafts and Live Listings both, every page load) - a real production report (2026-10-02) traced
  // "Live Listings Bulk Edit is very slow" to an earlier version of this file reusing veroService.js's matcher, whose
  // foldWithMap() normalizes the text one character at a time (needed there to cut a word back OUT of the original
  // text - never needed for a heads-up). 300 listings, each with a long (4000-word, the app's own cap) description,
  // must stay comfortably fast - generous enough to never flake on a loaded CI box, tight enough to catch that
  // regression coming back (it measured at roughly 25x slower before this fix).
  const longDescription = '<div><h2>Product</h2><p>' + Array.from({ length: 4000 }, (_, i) => 'word' + (i % 50)).join(' ') + '</p></div>';
  const manyListings = Array.from({ length: 300 }, () => ({ title: 'An Ordinary Product Title', description: longDescription, bulletPoints: ['Durable', 'Lightweight'], specifications: [{ name: 'Color', value: 'Blue' }] }));
  const start = Date.now();
  manyListings.forEach((l) => scanListing(l));
  const elapsedMs = Date.now() - start;
  assert.ok(elapsedMs < 2000, `300 listings with a 4000-word description took ${elapsedMs}ms - expected well under 2000ms`);

  console.log('prohibited items service tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
