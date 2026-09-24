const { askClaude } = require('./aiService');
const { createMatcher } = require('./veroService');

const asBullets = (v) => (Array.isArray(v) ? v.map((b) => String(b ?? '')) : []);

/**
 * Rewrites a listing so it contains none of the user's VeRO words.
 * The AI rewrites the running text (title, description, bullet points) so it still reads well; the
 * specification rows and item specifics are cleaned by rules (a VeRO brand becomes "Unbranded").
 * Whatever the AI leaves behind is cut out afterwards, so the result is guaranteed free of the user's words.
 *
 * @param {{ title?, description?, bulletPoints?, specifications?, aspects?, brand?, categoryName? }} input
 * @param {string[]} words the user's VeRO words (Settings -> VeRO)
 * @returns {Promise<{ text: string, data: object, usage: object|null }>}
 */
async function cleanVeroTerms(input, words) {
  const vero = createMatcher(words);
  const title = String(input.title || '');
  const description = String(input.description || '');
  const bulletPoints = asBullets(input.bulletPoints);
  const scan = vero.scanListing({ title, description, bulletPoints, brand: input.brand });

  const toRewrite = {};
  if (scan.fields.title) toRewrite.title = title;
  // A description longer than the AI can answer in one go is cleaned by rule instead of being cut short.
  if (scan.fields.description && description.length <= 8000) toRewrite.description = description;
  if (scan.fields.bulletPoints) toRewrite.bulletPoints = bulletPoints;

  const result = { title, description, bulletPoints };
  let usage = null;

  if (Object.keys(toRewrite).length) {
    const prompt = [
      'You edit eBay listings so they contain none of these words (the seller marked them as protected brand, character or trademark words, eBay VeRO): ' + scan.terms.join(', ') + '.',
      'Rewrite ONLY the fields given below. Remove each of those words, or replace it with a plain generic description of the item',
      '(for example "Nike running shoes" -> "running shoes"; "fits iPhone 14" -> "fits select smartphone models").',
      'Never invent facts, sizes, materials, claims or features that are not in the text. Keep everything else exactly as it is:',
      'same language, same order, same line breaks and paragraphs. The title must stay at most 80 characters.',
      'Bullet points: return the same number of bullet points in the same order.',
      'Reply with ONLY a JSON object that has exactly the keys you were given, for example {"title":"...","description":"...","bulletPoints":["..."]}. No commentary.',
      '',
      'Fields to rewrite:',
      JSON.stringify(toRewrite),
    ].join('\n');

    const answer = await askClaude({ prompt, maxTokens: 3500 });
    usage = answer;
    const start = answer.text.indexOf('{');
    const end = answer.text.lastIndexOf('}');
    let parsed;
    try { parsed = JSON.parse(answer.text.slice(start, end + 1)); } catch (_) {
      const err = new Error('The AI answer could not be read. Please try again.');
      err.statusCode = 502;
      throw err;
    }
    if (typeof parsed.title === 'string' && parsed.title.trim()) result.title = parsed.title.trim();
    if (typeof parsed.description === 'string' && parsed.description.trim()) result.description = parsed.description;
    if (Array.isArray(parsed.bulletPoints) && parsed.bulletPoints.length === bulletPoints.length) result.bulletPoints = parsed.bulletPoints.map((b) => String(b ?? ''));
  }

  // Guarantee: every word of the user's list that is still there (the AI missed one, or was not asked) is cut out by rule.
  const finalTitle = vero.stripVeroTerms(result.title).slice(0, 80).trim();
  const finalDescription = vero.stripVeroTerms(result.description);
  const finalBullets = result.bulletPoints.map((b) => vero.stripVeroTerms(b)).filter((b) => b.trim());
  const rules = vero.cleanSpecificsAndAspects({ specifications: input.specifications, aspects: input.aspects });

  // A VeRO brand on the product itself must not come back through the Brand item specific.
  const aspects = { ...rules.aspects };
  if (vero.findVeroTerms(input.brand).length) aspects.Brand = ['Unbranded'];

  const data = {
    title: finalTitle,
    description: finalDescription,
    bulletPoints: finalBullets,
    specifications: rules.specifications,
    aspects,
    removed: [...new Set([...scan.terms, ...rules.removed])],
    kept: [],
    unchanged: false,
  };
  return { text: JSON.stringify({ removed: data.removed }), data, usage };
}

module.exports = { cleanVeroTerms };
