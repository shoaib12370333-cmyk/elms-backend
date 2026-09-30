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

/** Best-effort textual "is this block probably in the AI's raw answer" checks for the 'ai' kind blocks that have a
 * recognizable instructed heading or markup - content wording varies, so this only catches a block the AI dropped
 * outright, not one it reworded. 'intro' and 'trust_badges' have no instructed heading, so they are never checked. */
const AI_BLOCK_PRESENT = {
  bullets: (html) => /key features/i.test(html) || /<li[\s>]/i.test(html),
  specs: (html) => /specifications/i.test(html) || /<table[\s>]/i.test(html),
  shipping: (html) => /shipping/i.test(html),
  returns: (html) => /returns/i.test(html),
  faq: (html) => /\bfaq\b/i.test(html) || /frequently asked/i.test(html),
};

/** Best-effort check that every block the prompt instructed actually shows up in the AI's raw answer, so a block
 * the AI silently dropped - skipped an instructed 'ai' section, or paraphrased away a literal data-block placeholder
 * so split/join finds nothing to splice - surfaces as a warning instead of just shipping a shorter description than
 * the seller configured, with no error anywhere. Never a hard failure, and never certain: a block that IS there can
 * still be flagged if the AI's wording doesn't match the heuristic. */
function findMissingBlocks(rawHtml, template, hasSpecs) {
  const missingBlocks = [];
  const warnings = [];
  for (const key of template.blocks) {
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
    const isPresent = AI_BLOCK_PRESENT[key];
    if (isPresent && !isPresent(rawHtml)) {
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

module.exports = { beautifyEbayDescription, beautifyDraftDescription, beautifyManyDraftDescriptions };
