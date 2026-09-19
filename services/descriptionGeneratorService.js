const { askClaude } = require('./aiService');
const { getAiSettings } = require('../models/settingsModel');

const LENGTHS = {
  short: { words: '60 to 90 words', tokens: 400 },
  standard: { words: '120 to 180 words', tokens: 700 },
  detailed: { words: '220 to 320 words', tokens: 1100 },
};

/**
 * Writes an eBay listing description from the facts we already have.
 * Plain text only (short paragraphs and "- " bullet lines) so it reads well in the editor and on eBay.
 * It never invents specifications, materials, sizes, warranties or shipping promises.
 */
async function generateEbayDescription({ title, description, bulletPoints, specifications, categoryName }) {
  const settings = await getAiSettings();
  const len = LENGTHS[settings.aiDescriptionLength] || LENGTHS.standard;
  const bullets = (Array.isArray(bulletPoints) ? bulletPoints : []).map((b) => String(b).trim()).filter(Boolean).slice(0, 12);
  const specs = (Array.isArray(specifications) ? specifications : [])
    .map((sp) => (sp && (sp.name || sp.label) ? `${sp.name || sp.label}: ${sp.value ?? ''}` : ''))
    .filter(Boolean)
    .slice(0, 25);

  const prompt = [
    'Write the description for an eBay listing.',
    `Length: about ${len.words}. Plain text only: no markdown, no HTML, no emojis, no ALL CAPS shouting.`,
    'Structure: one short opening paragraph that says what the item is and who it suits; then a "Key features" list with one "- " line per feature; then one closing line about what is included ONLY if the facts say so.',
    'Rules: use only the facts below; never invent specifications, materials, sizes, compatibility, warranty, brand claims, delivery times or return promises; do not mention Amazon or other sellers; do not repeat the title word for word more than once.',
    settings.aiCustomInstructions ? `Extra instructions from the store owner: ${settings.aiCustomInstructions}` : '',
    'Reply with ONLY the description text.',
    '',
    `Title: ${title}`,
    categoryName ? `Category: ${categoryName}` : '',
    bullets.length ? `Feature bullets:\n${bullets.map((b) => `- ${b}`).join('\n')}` : '',
    specs.length ? `Specifications:\n${specs.join('\n')}` : '',
    description ? `Current description (source facts):\n${String(description).slice(0, 2500)}` : '',
  ].filter(Boolean).join('\n');

  const result = await askClaude({ prompt, maxTokens: len.tokens });
  const text = result.text.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  if (text.length < 20) {
    const err = new Error('The AI service returned an empty description.');
    err.statusCode = 502;
    throw err;
  }
  return { text, usage: result };
}

module.exports = { generateEbayDescription };
