const { askClaude } = require('./aiService');
const { getAiSettings } = require('../models/settingsModel');
const { getListingById, updateListing } = require('../models/listingsModel');
const { withCredits } = require('./creditService');
const { ACTION_COSTS } = require('../config/actionCosts');
const AiUsage = require('../models/schemas/AiUsage');
const { AVAILABLE_BLOCKS, TEMPLATE_STYLES, normalizeTemplate } = require('./descriptionTemplateLibrary');

const DATA_BLOCK_KEYS = new Set(['gallery', 'store_banner', 'size_chart', 'video', 'custom_html']);
const PLACEHOLDER = { gallery: '{{ELMS_GALLERY}}', store_banner: '{{ELMS_STORE_BANNER}}', size_chart: '{{ELMS_SIZE_CHART}}', video: '{{ELMS_VIDEO}}', custom_html: '{{ELMS_CUSTOM_HTML}}' };

const AI_BLOCK_INSTRUCTIONS = {
  intro: 'A short (2 to 4 sentence) persuasive paragraph selling the product, written from the facts given - no heading needed. This is the main sales pitch a shopper reads first, not a repeat of the bullets/specs below.',
  bullets: 'A "Key Features" heading, then a <ul> of 3 to 8 <li> bullets, one real feature per line, from the facts given.',
  specs: 'A "Specifications" heading, then an HTML <table> of the given specifications as name/value rows. Leave this whole block out if no specifications were given.',
  shipping: 'A short "Shipping & Delivery" heading with one or two generic sentences - never invent delivery dates, countries or carriers.',
  returns: 'A short "Returns & Warranty" heading with one or two generic, reassuring sentences - never invent specific policy numbers or day counts.',
  trust_badges: 'One short reassurance line (e.g. buyer protection, secure checkout) - plain text, never invent certifications or awards.',
  faq: 'A short "FAQ" heading with 2 to 3 generic buyer questions and answers, using only the facts given - never invent specific policy numbers.',
};

const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;');

function renderGallery(images) {
  const imgs = (Array.isArray(images) ? images : []).filter((u) => /^https?:\/\//i.test(String(u || ''))).slice(0, 8);
  if (!imgs.length) return '';
  return `<div style="text-align:center;padding:12px 0;">${imgs.map((u) => `<img src="${escapeAttr(u)}" alt="" style="max-width:100%;height:auto;margin:4px;border-radius:6px;" />`).join('')}</div>`;
}
function renderStoreBanner(branding) {
  if (!branding.storeName && !branding.logoUrl) return '';
  const logo = branding.logoUrl ? `<img src="${escapeAttr(branding.logoUrl)}" alt="" style="max-height:60px;" />` : '';
  const name = branding.storeName ? `<div style="font:600 16px Arial,sans-serif;color:${escapeAttr(branding.accentColor || '#111111')};">${escapeHtml(branding.storeName)}</div>` : '';
  return `<div style="text-align:center;padding:10px 0;">${logo}${name}</div>`;
}
function renderVideo(videoUrl) {
  if (!videoUrl) return '';
  return `<div style="text-align:center;padding:10px 0;"><a href="${escapeAttr(videoUrl)}" target="_blank" rel="noopener noreferrer">&#9654; Watch the product video</a></div>`;
}

/** True when `phraseSource` appears wrapped in something that reads as a heading (<h1>-<h6>, <b> or <strong>) -
 * never a plain substring search across the whole answer. A bare, common word from one block's heading (shipping,
 * returns, specifications...) is very likely to show up by coincidence inside a DIFFERENT block's own prose (a FAQ
 * answer mentioning "how long does shipping take", a bullet mentioning "full specifications included") even when
 * that block's real section was dropped outright - a plain html.includes(word) check would wrongly call it
 * "present" in exactly that case, which is the one thing this whole check exists to catch. */
function headingPhrasePresent(html, phraseSource) {
  return new RegExp(`<(?:h[1-6]|b|strong)[^>]*>\\s*(?:<[^>]+>\\s*)*(?:${phraseSource})`, 'i').test(html);
}

// The exact, multi-word heading phrase each block was actually instructed to use (AI_BLOCK_INSTRUCTIONS above) -
// distinctive enough that it is very unlikely to appear by coincidence in a different section's own sentence.
const HEADING_PHRASE_SOURCE = {
  bullets: '\\bkey features\\b',
  specs: '\\bspecifications\\b',
  shipping: 'shipping\\s*(?:&amp;|&|and)\\s*delivery', // &amp; first: the AI may write a literal & or the HTML-escaped entity
  returns: 'returns?\\s*(?:&amp;|&|and)\\s*warranty',
  faq: '\\bfaq\\b|frequently asked',
};

/** For the two blocks the AI is told to give real markup (a <ul> of bullets, a <table> of specs) as well as a
 * heading: true when there is one with enough children whose NEAREST preceding heading is this block's own (or no
 * heading precedes it at all) - so a bullet list written under "FAQ", or a table written under "Returns &
 * Warranty", is never mistaken for the Key Features / Specifications block just because a <ul> or <table> exists
 * somewhere in the answer. */
function structuralBlockPresent(html, tagName, childTag, minChildren, ownKey) {
  const blockRe = new RegExp(`<${tagName}[^>]*>[\\s\\S]*?<\\/${tagName}>`, 'gi');
  let m;
  while ((m = blockRe.exec(html))) {
    const count = (m[0].match(new RegExp(`<${childTag}[\\s>]`, 'gi')) || []).length;
    if (count < minChildren) continue;
    const before = html.slice(0, m.index);
    let nearestKey = null;
    let nearestAt = -1;
    for (const [key, src] of Object.entries(HEADING_PHRASE_SOURCE)) {
      const re = new RegExp(`<(?:h[1-6]|b|strong)[^>]*>\\s*(?:<[^>]+>\\s*)*(?:${src})`, 'gi');
      let last = -1;
      let mm;
      while ((mm = re.exec(before))) last = mm.index;
      if (last > nearestAt) { nearestAt = last; nearestKey = key; }
    }
    if (nearestKey === null || nearestKey === ownKey) return true;
  }
  return false;
}

/** Best-effort textual "is this block probably in the AI's raw answer" checks for the 'ai' kind blocks that have a
 * recognizable instructed heading - content wording varies, so this only catches a block the AI dropped outright,
 * not one it reworded. 'intro' and 'trust_badges' have no instructed heading, so they cannot be checked this way -
 * see headinglessSlotText below for how those two are checked instead. */
const AI_BLOCK_PRESENT = {
  bullets: (html) => headingPhrasePresent(html, HEADING_PHRASE_SOURCE.bullets) || structuralBlockPresent(html, 'ul', 'li', 2, 'bullets'),
  // The prompt asks for a <table>, but the AI occasionally writes a real specifications list as a <ul> instead (under
  // a heading this heuristic doesn't recognize, e.g. "Product Details") - accepting either markup, still resolved by
  // its nearest heading (see structuralBlockPresent), trades a little precision for fewer false "left out" warnings
  // on specs that really are there.
  specs: (html) => headingPhrasePresent(html, HEADING_PHRASE_SOURCE.specs) || structuralBlockPresent(html, 'table', 'tr', 1, 'specs') || structuralBlockPresent(html, 'ul', 'li', 2, 'specs'),
  shipping: (html) => headingPhrasePresent(html, HEADING_PHRASE_SOURCE.shipping),
  returns: (html) => headingPhrasePresent(html, HEADING_PHRASE_SOURCE.returns),
  faq: (html) => headingPhrasePresent(html, HEADING_PHRASE_SOURCE.faq),
};

const MIN_HEADINGLESS_TEXT = 40; // roughly "a short sentence" - short of that, there is nothing there worth calling a paragraph
// trust_badges has no fixed wording of its own (unlike a heading phrase), so presence also asks for a plausible
// reassurance word - without this, any stray sentence in its slot (including one that is really the neighbouring
// intro's) would count.
const TRUST_KEYWORDS = /secure checkout|buyer protection|money[- ]back|satisfaction guarantee|trusted seller|encrypted|verified seller|safe (?:and|&|&amp;) secure|\bguarantee/i;

/** Where each block in `template.blocks` most likely starts in `rawHtml`, in the same order: the index of its own
 * heading phrase for a headed 'ai' block, the index of its placeholder token for a data block, or null for a
 * headingless 'ai' block (intro, trust_badges) - those are resolved against their neighbours' positions instead,
 * by headinglessSlotText below. */
function blockAnchors(rawHtml, template) {
  return template.blocks.map((key) => {
    if (DATA_BLOCK_KEYS.has(key)) {
      const at = rawHtml.indexOf(PLACEHOLDER[key]);
      return { key, at: at === -1 ? null : at };
    }
    if (HEADING_PHRASE_SOURCE[key]) {
      const m = new RegExp(`<(?:h[1-6]|b|strong)[^>]*>\\s*(?:<[^>]+>\\s*)*(?:${HEADING_PHRASE_SOURCE[key]})`, 'i').exec(rawHtml);
      return { key, at: m ? m.index : null };
    }
    return { key, at: null };
  });
}

/** The plain text (HTML tags and data-block placeholders stripped) between the nearest marker before `index` and
 * the nearest marker after it, in template order - the best available stand-in for "this headingless block's own
 * content" when the block itself has no heading or markup to look for. Two headingless blocks sitting right next to
 * each other (only the 'bold' style pairs intro with trust_badges) cannot be told apart this way: the same text is
 * offered to both, so a genuinely dropped trust_badges right after a real intro is not caught - a known gap, not a
 * silent assumption of correctness. */
function headinglessSlotText(rawHtml, anchors, index) {
  let from = 0;
  for (let i = index - 1; i >= 0; i -= 1) { if (anchors[i].at != null) { from = anchors[i].at; break; } }
  let to = rawHtml.length;
  for (let i = index + 1; i < anchors.length; i += 1) { if (anchors[i].at != null) { to = anchors[i].at; break; } }
  if (to <= from) return '';
  return Object.values(PLACEHOLDER).reduce((acc, p) => acc.split(p).join(' '), rawHtml.slice(from, to))
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Best-effort check that every block the prompt instructed actually shows up in the AI's raw answer, so a block
 * the AI silently dropped - skipped an instructed 'ai' section, or paraphrased away a literal data-block placeholder
 * so split/join finds nothing to splice - surfaces as a warning instead of just shipping a shorter description than
 * the seller configured, with no error anywhere. Never a hard failure, and never certain: a block that IS there can
 * still be flagged if the AI's wording doesn't match the heuristic. */
function findMissingBlocks(rawHtml, template, hasSpecs) {
  const missingBlocks = [];
  const warnings = [];
  const anchors = blockAnchors(rawHtml, template);
  for (let index = 0; index < template.blocks.length; index += 1) {
    const key = template.blocks[index];
    const def = AVAILABLE_BLOCKS.find((b) => b.key === key);
    if (!def) continue;
    if (DATA_BLOCK_KEYS.has(key)) {
      if (!rawHtml.includes(PLACEHOLDER[key])) {
        missingBlocks.push(key);
        warnings.push(`"${def.label}" was left out - the AI didn't include its placeholder, so no data could be filled in. Try beautifying again.`);
      }
      continue;
    }
    if (key === 'specs' && !hasSpecs) continue; // the AI is told to skip this block entirely when there are no specs to write
    let present;
    if (key === 'intro') present = headinglessSlotText(rawHtml, anchors, index).length >= MIN_HEADINGLESS_TEXT;
    else if (key === 'trust_badges') {
      const text = headinglessSlotText(rawHtml, anchors, index);
      present = text.length >= MIN_HEADINGLESS_TEXT && TRUST_KEYWORDS.test(text);
    } else {
      const isPresent = AI_BLOCK_PRESENT[key];
      present = !isPresent || isPresent(rawHtml); // a block with no recognizable check of its own is never flagged
    }
    if (!present) {
      missingBlocks.push(key);
      warnings.push(`"${def.label}" doesn't seem to be in the AI's answer and may have been left out. Try beautifying again.`);
    }
  }
  return { missingBlocks, warnings };
}

/** Replaces each data-block placeholder with the seller's own real data, or removes it when there is none - the AI
 * never sees or invents this content, it only leaves room for it. */
function spliceDataBlocks(html, template, images) {
  return String(html || '')
    .split(PLACEHOLDER.gallery).join(renderGallery(images))
    .split(PLACEHOLDER.store_banner).join(renderStoreBanner(template.branding))
    .split(PLACEHOLDER.size_chart).join(template.sizeChartHtml || '')
    .split(PLACEHOLDER.video).join(renderVideo(template.videoUrl))
    .split(PLACEHOLDER.custom_html).join(template.customHtml || '');
}

/**
 * Restructures the seller's own description facts into their saved description template: an AI-written HTML
 * fragment for the "tool" blocks that are written from the product's own facts (bullets, specs, shipping...), with
 * the blocks that need real data (gallery, store banner, size chart, video, custom HTML) spliced in afterwards from
 * what the seller actually saved - never guessed by the AI. Same "never invent facts" rule as generateEbayDescription.
 */
async function beautifyEbayDescription({ title, description, bulletPoints, specifications, images, template: templateIn }) {
  const settings = await getAiSettings();
  const template = normalizeTemplate(templateIn);
  const style = TEMPLATE_STYLES.find((s) => s.id === template.templateId) || TEMPLATE_STYLES[0];
  const bullets = (Array.isArray(bulletPoints) ? bulletPoints : []).map((b) => String(b).trim()).filter(Boolean).slice(0, 12);
  const specs = (Array.isArray(specifications) ? specifications : [])
    .map((sp) => (sp && (sp.name || sp.label) ? `${sp.name || sp.label}: ${sp.value ?? ''}` : ''))
    .filter(Boolean)
    .slice(0, 25);

  const blockLines = template.blocks.map((key) => {
    const def = AVAILABLE_BLOCKS.find((b) => b.key === key);
    if (!def) return null;
    if (DATA_BLOCK_KEYS.has(key)) return `- ${def.label}: output ONLY the exact literal text ${PLACEHOLDER[key]} on its own line here. Write no content of your own for this block - ELMS fills it in afterwards from the seller's own saved data.`;
    return `- ${def.label}: ${AI_BLOCK_INSTRUCTIONS[key] || ''}`;
  }).filter(Boolean);

  const prompt = [
    'Write the description for an eBay listing as a single HTML fragment.',
    'No <html>, <head>, <body>, <script> or <style> tags, and no external CSS/JS - only inline "style" attributes on plain tags (div, h2, p, ul, li, table).',
    `Overall tone: ${style.tone}.`,
    'Include exactly these sections, in this exact order, and nothing else:',
    blockLines.join('\n'),
    'Rules: use only the facts given below; never invent specifications, materials, sizes, compatibility, warranty terms, delivery times, return windows, certifications or brand claims; do not mention Amazon or any other seller; do not repeat the title word for word more than once.',
    settings.aiCustomInstructions ? `Extra instructions from the store owner: ${settings.aiCustomInstructions}` : '',
    'Reply with ONLY the HTML fragment - no markdown code fences, no commentary.',
    '',
    `Title: ${title}`,
    bullets.length ? `Feature bullets:\n${bullets.map((b) => `- ${b}`).join('\n')}` : '',
    specs.length ? `Specifications:\n${specs.join('\n')}` : '',
    description ? `Current description (source facts):\n${String(description).slice(0, 2500)}` : '',
  ].filter(Boolean).join('\n');

  const result = await askClaude({ prompt, maxTokens: 1800 });
  let html = result.text.replace(/^```(?:html)?\s*/i, '').replace(/```\s*$/i, '').trim();
  if (html.length < 40) {
    if (typeof result.discard === 'function') result.discard(); // do not replay it from the cache on the next try
    const err = new Error('The AI service returned an empty description.');
    err.statusCode = 502;
    throw err;
  }
  const { missingBlocks, warnings } = findMissingBlocks(html, template, specs.length > 0);
  html = spliceDataBlocks(html, template, images);
  return { text: html, usage: result, missingBlocks, warnings };
}

/**
 * The Drafts bulk bar's "Beautify descriptions with AI": restructures ONE draft's description into the seller's own
 * saved template and saves it. Costs ACTION_COSTS.AI_DESCRIPTION_BEAUTIFY credits, charged first and refunded if the
 * AI or the save fails - mirrors services/listingAspectFillService.js's fillDraftAspects exactly.
 *
 * @returns {Promise<{ id, title, status: 'done'|'skipped'|'failed'|'no_credits', creditsUsed }>}
 */
async function beautifyDraftDescription(userId, id, template) {
  const skip = (title, reason) => ({ id, title, status: 'skipped', reason, creditsUsed: 0 });
  const listing = await getListingById(userId, id);
  if (!listing) return skip(null, 'Not found.');
  const title = listing.title || listing.sku || id;
  if (!['draft', 'error'].includes(listing.status)) return skip(title, 'Only drafts can be beautified here.');
  if (String(listing.title || '').trim().length < 3) return skip(title, 'This draft has no title yet.');

  const cost = Number(ACTION_COSTS.AI_DESCRIPTION_BEAUTIFY || 0);
  try {
    const out = await withCredits(userId, cost, async () => {
      const ai = await beautifyEbayDescription({
        title: listing.title, description: listing.description, bulletPoints: listing.bullet_points,
        specifications: listing.specifications, images: listing.images, template,
      });
      await updateListing(userId, id, { description: ai.text });
      return ai;
    });
    AiUsage.create({ userId, kind: 'beautify', ok: true, credits: cost, model: out.usage?.model, inputTokens: out.usage?.inputTokens, outputTokens: out.usage?.outputTokens }).catch(() => {});
    return { id, title, status: 'done', creditsUsed: cost, missingBlocks: out.missingBlocks, warnings: out.warnings };
  } catch (err) {
    if (err.outOfCredits) return { id, title, status: 'no_credits', reason: err.message, creditsUsed: 0 };
    AiUsage.create({ userId, kind: 'beautify', ok: false, credits: 0 }).catch(() => {});
    console.error('[bulk-description-beautify]', id, err.message);
    return { id, title, status: 'failed', reason: err.message || 'The AI request failed.', creditsUsed: 0 };
  }
}

/** Beautifies several drafts' descriptions, a few at a time - same worker-pool/no_credits short-circuit as fillManyDraftAspects. */
async function beautifyManyDraftDescriptions(userId, ids, template, { concurrency = 3 } = {}) {
  const results = new Array(ids.length);
  let next = 0;
  let broke = false;
  const worker = async () => {
    while (next < ids.length) {
      const at = next++;
      if (broke) { results[at] = { id: ids[at], title: null, status: 'no_credits', reason: 'Not enough credits.', creditsUsed: 0 }; continue; }
      try { results[at] = await beautifyDraftDescription(userId, ids[at], template); } catch (err) {
        results[at] = { id: ids[at], title: null, status: 'failed', reason: err.message || 'Could not beautify.', creditsUsed: 0 };
      }
      if (results[at].status === 'no_credits') broke = true;
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, ids.length)) }, worker));
  return results;
}

const LIVE_BEAUTIFY_STATUSES = ['published', 'sold']; // still live on eBay; a sold-out listing is "live in principle" (models/schemas/Listing.js) - same definition liveBulkVeroService.js uses

/**
 * The Live Listings bulk bar's "Beautify descriptions with AI": the same beautifyEbayDescription restructuring
 * fillDraftAspects' sibling (beautifyDraftDescription) uses, but the new HTML is pushed to eBay with
 * reviseActiveListing first, and ELMS's own copy is only saved once eBay has taken it.
 * @returns {Promise<{ id, title, status: 'done'|'skipped'|'failed'|'no_credits', creditsUsed }>}
 */
async function beautifyLiveDescription(userId, id, template, d) {
  const skip = (title, reason) => ({ id, title, status: 'skipped', reason, creditsUsed: 0 });
  const listing = await d.getListingById(userId, id);
  if (!listing) return skip(null, 'Not found.');
  const title = listing.title || listing.sku || id;
  if (!LIVE_BEAUTIFY_STATUSES.includes(String(listing.status || '').toLowerCase())) return skip(title, 'Only a live (or sold-out) listing can be beautified here. A draft is beautified with Beautify descriptions with AI on the Drafts page.');
  if (!listing.ebay_offer_id || !listing.sku) return skip(title, 'This listing has no eBay offer to change.');
  if (!listing.ebay_account_id) return skip(title, 'No eBay account is connected to this listing.');

  const refreshToken = await Promise.resolve(d.getRefreshToken(userId, listing.ebay_account_id)).catch(() => null);
  if (!refreshToken) return skip(title, 'The connected eBay account is missing its connection. Reconnect it in Settings.');

  const cost = Number(ACTION_COSTS.AI_DESCRIPTION_BEAUTIFY || 0);
  try {
    const out = await withCredits(userId, cost, async () => {
      const ai = await beautifyEbayDescription({
        title: listing.title, description: listing.description, bulletPoints: listing.bullet_points,
        specifications: listing.specifications, images: listing.images, template,
      });
      await d.reviseActiveListing(refreshToken, {
        offerId: listing.ebay_offer_id, sku: listing.sku, title: listing.title, description: ai.text,
        sellPrice: listing.sell_price, priceCurrency: listing.currency, quantity: listing.quantity, categoryId: listing.category_id,
      });
      await d.updateListing(userId, id, { description: ai.text, markDraftCustomized: false });
      return ai;
    });
    AiUsage.create({ userId, kind: 'beautify', ok: true, credits: cost, model: out.usage?.model, inputTokens: out.usage?.inputTokens, outputTokens: out.usage?.outputTokens }).catch(() => {});
    return { id, title, status: 'done', creditsUsed: cost, missingBlocks: out.missingBlocks, warnings: out.warnings };
  } catch (err) {
    if (err.outOfCredits) return { id, title, status: 'no_credits', reason: err.message, creditsUsed: 0 };
    AiUsage.create({ userId, kind: 'beautify', ok: false, credits: 0 }).catch(() => {});
    console.error('[bulk-live-description-beautify]', id, err.message);
    return { id, title, status: 'failed', reason: err.message || 'The AI request failed, or eBay did not accept the change.', creditsUsed: 0 };
  }
}

/** Beautifies several live listings' descriptions, a few at a time - same worker-pool/no_credits short-circuit as beautifyManyDraftDescriptions. */
async function beautifyManyLiveDescriptions(userId, ids, template, d, { concurrency = 3 } = {}) {
  const results = new Array(ids.length);
  let next = 0;
  let broke = false;
  const worker = async () => {
    while (next < ids.length) {
      const at = next++;
      if (broke) { results[at] = { id: ids[at], title: null, status: 'no_credits', reason: 'Not enough credits.', creditsUsed: 0 }; continue; }
      try { results[at] = await beautifyLiveDescription(userId, ids[at], template, d); } catch (err) {
        results[at] = { id: ids[at], title: null, status: 'failed', reason: err.message || 'Could not beautify.', creditsUsed: 0 };
      }
      if (results[at].status === 'no_credits') broke = true;
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, ids.length)) }, worker));
  return results;
}

module.exports = { beautifyEbayDescription, beautifyDraftDescription, beautifyManyDraftDescriptions, beautifyLiveDescription, beautifyManyLiveDescriptions };
