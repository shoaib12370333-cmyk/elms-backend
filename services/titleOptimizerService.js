const axios = require('axios');

const MODEL = process.env.TITLE_OPTIMIZER_MODEL || 'claude-haiku-4-5-20251001';
const EBAY_TITLE_MAX = 80;

/**
 * Rewrites a product title for eBay search: keeps every fact from the original
 * (brand, model, size, colour, quantity), removes filler/promotional words and
 * stays within eBay's 80 character limit. Never invents specifications.
 */
async function optimizeEbayTitle({ title, categoryName, description }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    const err = new Error('AI title optimization is not configured on the server (ANTHROPIC_API_KEY is missing).');
    err.statusCode = 503;
    throw err;
  }

  const prompt = [
    'Rewrite this product title as an eBay listing title.',
    `Hard limit: ${EBAY_TITLE_MAX} characters. Use as many of them as sensible.`,
    'Rules: keep brand, model, size, colour, material and quantity exactly as given; put the most searchable words first;',
    'remove promotional words (best, amazing, hot sale, free shipping), emojis and repeated words; do not invent any specification;',
    'use normal Title Case and no trailing punctuation. Reply with ONLY the title text.',
    '',
    `Title: ${title}`,
    categoryName ? `Category: ${categoryName}` : '',
    description ? `Description (context only): ${description}` : '',
  ].filter(Boolean).join('\n');

  let response;
  try {
    response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      { model: MODEL, max_tokens: 120, messages: [{ role: 'user', content: prompt }] },
      { headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, timeout: 20000 }
    );
  } catch (err) {
    const wrapped = new Error(err.response?.data?.error?.message || 'The AI service could not be reached.');
    wrapped.statusCode = 502;
    throw wrapped;
  }

  let optimized = String(response.data?.content?.[0]?.text || '').replace(/^["'\s]+|["'\s]+$/g, '').replace(/\s+/g, ' ');
  if (!optimized) {
    const err = new Error('The AI service returned an empty title.');
    err.statusCode = 502;
    throw err;
  }
  if (optimized.length > EBAY_TITLE_MAX) {
    optimized = optimized.slice(0, EBAY_TITLE_MAX).replace(/\s+\S*$/, '').trim();
  }
  return optimized;
}

module.exports = { optimizeEbayTitle };
