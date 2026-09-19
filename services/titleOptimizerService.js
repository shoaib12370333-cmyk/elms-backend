const { askClaude } = require('./aiService');
const { getAiSettings } = require('../models/settingsModel');

const EBAY_TITLE_MAX = 80;

/**
 * Rewrites a product title for eBay search: keeps every fact from the original
 * (brand, model, size, colour, quantity), removes filler/promotional words and
 * stays within eBay's 80 character limit. Never invents specifications.
 */
async function optimizeEbayTitle({ title, categoryName, description }) {
  const settings = await getAiSettings();
  const prompt = [
    'Rewrite this product title as an eBay listing title.',
    `Hard limit: ${EBAY_TITLE_MAX} characters. Use as many of them as sensible.`,
    'Rules: keep brand, model, size, colour, material and quantity exactly as given; put the most searchable words first;',
    'remove promotional words (best, amazing, hot sale, free shipping), emojis and repeated words; do not invent any specification;',
    'use normal Title Case and no trailing punctuation. Reply with ONLY the title text.',
    settings.aiCustomInstructions ? `Extra instructions from the store owner: ${settings.aiCustomInstructions}` : '',
    '',
    `Title: ${title}`,
    categoryName ? `Category: ${categoryName}` : '',
    description ? `Description (context only): ${description}` : '',
  ].filter(Boolean).join('\n');

  const result = await askClaude({ prompt, maxTokens: 120 });
  let optimized = result.text.replace(/^["'\s]+|["'\s]+$/g, '').replace(/\s+/g, ' ');
  if (!optimized) {
    const err = new Error('The AI service returned an empty title.');
    err.statusCode = 502;
    throw err;
  }
  if (optimized.length > EBAY_TITLE_MAX) optimized = optimized.slice(0, EBAY_TITLE_MAX).replace(/\s+\S*$/, '').trim();
  return { text: optimized, usage: result };
}

module.exports = { optimizeEbayTitle };
