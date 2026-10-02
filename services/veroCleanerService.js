const { askClaude } = require('./aiService');
const { createMatcher } = require('./veroService');
const { stripInvisible } = require('./textCleanService');

const asBullets = (v) => (Array.isArray(v) ? v.map((b) => String(b ?? '')) : []);

// How much of a description may go to the AI in one call. Only the sentences that HOLD a VeRO word are sent (see
// splitForRewrite), so these limits are about odd listings (a brand in every sentence, one 3000-character "sentence"): whatever
// is over a limit is not sent, it is cut out by rule instead - never left in, never makes the call bigger.
const MAX_SNIPPETS = 60;
const MAX_SNIPPET_CHARS = 600;
const MAX_SNIPPET_TOTAL_CHARS = 6000; // together: keeps the AI's answer well inside the token budget it is given (see cleanVeroTerms)

/**
 * Splits a description (HTML or plain text) into the parts that stay exactly as they are and the SENTENCES that hold a VeRO word.
 * Joining the parts back with each sentence's replacement gives the description with everything else untouched, byte for byte
 * (tags, attributes, spacing, line breaks). Only text between tags is looked at: a tag is never sent to the AI.
 *
 * Why: an AI call is slow in proportion to the text it WRITES, not the text it reads. Asking it to rewrite a whole 7000-character
 * description to change two sentences made it write ~1700 tokens (10-30 seconds) for ~60 that actually changed. Measured
 * 2026-10-03: everything else in cleaning a listing (matching, cutting, tidying) takes about 6 ms.
 *
 * @returns {{ parts: Array<string | { id: number }>, snippets: Array<{ id: number, core: string }> }}
 */
function splitForRewrite(text, vero) {
  const parts = [];
  const snippets = [];
  let totalChars = 0;
  const keep = (s) => {
    if (!s) return;
    if (typeof parts[parts.length - 1] === 'string') parts[parts.length - 1] += s;
    else parts.push(s);
  };
  // Same view of the text as scanListing (invisible direction/zero-width marks removed), so a word the scan flagged is found here too.
  const holdsWord = (t) => vero.findVeroTerms(stripInvisible(t)).length > 0;
  // [^<>] (not [^>]): a "<" with no ">" after it is plain text, not the start of a tag. With [^>]* a long run of "<" made this split
  // quadratic (80,000 of them blocked the server for ~9 s) and a stray "<" swallowed the text after it into a fake tag.
  String(text ?? '').split(/(<[^<>]*>)/).forEach((piece, i) => {
    if (!piece) return;
    if (i % 2 === 1 || !holdsWord(piece)) { keep(piece); return; } // a tag, or text with nothing to change
    // A text run with a VeRO word: split it into sentences / lines (the separators are kept) and send only the ones that hold one.
    piece.split(/((?<=[.!?])\s+|\n+)/).forEach((sentence, j) => {
      if (!sentence) return;
      if (j % 2 === 1 || !holdsWord(sentence)) { keep(sentence); return; }
      const lead = sentence.match(/^\s*/)[0];
      const trail = sentence.match(/\s*$/)[0];
      const core = sentence.slice(lead.length, sentence.length - trail.length);
      if (!core || core.length > MAX_SNIPPET_CHARS || snippets.length >= MAX_SNIPPETS || totalChars + core.length > MAX_SNIPPET_TOTAL_CHARS) { keep(sentence); return; } // left for the rule sweep
      totalChars += core.length;
      keep(lead);
      parts.push({ id: snippets.length });
      snippets.push({ id: snippets.length, core });
      keep(trail);
    });
  });
  return { parts, snippets };
}

/** The AI's rewrite of one sentence, or null when it cannot be trusted (not text, markup or line breaks the original did not have, much longer than the original). */
function usableRewrite(original, rewritten) {
  if (typeof rewritten !== 'string') return null;
  const out = rewritten.trim();
  if (/[<>]/.test(out) && !/[<>]/.test(original)) return null;
  if (/[\r\n]/.test(out) && !/[\r\n]/.test(original)) return null;
  if (out.length > original.length * 1.5 + 40) return null;
  return out;
}

/**
 * Rewrites a listing so it contains none of the user's VeRO words.
 * The AI is asked to rewrite ONLY what holds a word, so it still reads well: the title, the bullet points that hold one, and the
 * individual sentences of the description that hold one (everything else is left exactly as it was). The specification rows and
 * item specifics are cleaned by rules (a VeRO brand becomes "Unbranded").
 * Whatever the AI leaves behind - or could not be asked about - is cut out afterwards, so the result is guaranteed free of the user's words.
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
  const bulletsToRewrite = scan.fields.bulletPoints
    ? bulletPoints.map((t, i) => ({ i, t })).filter((b) => vero.findVeroTerms(stripInvisible(b.t)).length)
    : [];
  if (bulletsToRewrite.length) toRewrite.bullets = bulletsToRewrite;
  const split = scan.fields.description ? splitForRewrite(description, vero) : { parts: [description], snippets: [] };
  if (split.snippets.length) toRewrite.snippets = split.snippets.map((s) => ({ id: s.id, t: s.core }));

  const result = { title, description, bulletPoints: bulletPoints.slice() };
  const rewrittenSnippets = new Map();
  let usage = null;

  if (Object.keys(toRewrite).length) {
    const prompt = [
      'You edit eBay listings so they contain none of these words (the seller marked them as protected brand, character or trademark words, eBay VeRO): ' + scan.terms.join(', ') + '.',
      'You are given short pieces of ONE listing: a title, some bullet points ("bullets", each with its index "i") and some sentences of the description ("snippets", each with its "id").',
      'Rewrite EACH piece so none of those words remain: remove the word, or replace it with a plain generic description of the item',
      '(for example "Nike running shoes" -> "running shoes"; "fits iPhone 14" -> "fits select smartphone models").',
      'Change as little as possible. Never invent facts, sizes, materials, claims or features that are not in the text. Keep the same language, tone and punctuation.',
      'A piece must stay one short fragment that fits where it was: do not add sentences, headings, line breaks or any HTML. The title must stay at most 80 characters.',
      'Reply with ONLY a JSON object that has exactly the keys you were given, each with every piece once, for example',
      '{"title":"...","bullets":[{"i":0,"t":"..."}],"snippets":[{"id":0,"t":"..."}]}. No commentary.',
      '',
      'Pieces to rewrite:',
      JSON.stringify(toRewrite),
    ].join('\n');

    // max_tokens is only a ceiling - the model stops when it has answered, so a high one costs no time - and an answer cut short has no
    // closing "}" and fails. Many short pieces cost far more tokens in JSON overhead than in text, so no budget worked out from the
    // text length is safe; the pieces are limited instead (MAX_SNIPPETS / MAX_SNIPPET_TOTAL_CHARS) so a full answer fits in this.
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
    // Only if the title was sent: a model that copies the three-key example must not overwrite a title that had nothing to change.
    if (toRewrite.title !== undefined && typeof parsed.title === 'string' && parsed.title.trim()) result.title = parsed.title.trim();
    for (const item of Array.isArray(parsed.bullets) ? parsed.bullets : []) {
      const wanted = item && bulletsToRewrite.find((b) => b.i === item.i);
      const text = wanted ? usableRewrite(wanted.t, item.t) : null;
      if (text !== null) result.bulletPoints[wanted.i] = text; // a bullet it did not answer for keeps its original (the sweep below cuts the word)
    }
    for (const item of Array.isArray(parsed.snippets) ? parsed.snippets : []) {
      const wanted = item && split.snippets.find((s) => s.id === item.id);
      const text = wanted ? usableRewrite(wanted.core, item.t) : null;
      if (text !== null) rewrittenSnippets.set(wanted.id, text);
    }
  }

  // A sentence the AI did not answer for (or answered unusably) is cut by rule right here, so the rest of the description is never touched.
  result.description = split.parts
    .map((p) => (typeof p === 'string' ? p : (rewrittenSnippets.has(p.id) ? rewrittenSnippets.get(p.id) : vero.stripVeroTerms(split.snippets[p.id].core))))
    .join('');

  // Guarantee: every word of the user's list that is still there (the AI missed one, or was not asked) is cut out by rule. Cutting a
  // word can JOIN its neighbours into another one ("Air Nike Max" -> "Air Max", itself a listed word), so it is repeated until the
  // text stops changing (a few passes at most) - one pass left such a word behind.
  const sweep = (text) => {
    let current = text;
    for (let pass = 0; pass < 4; pass += 1) {
      const next = vero.stripVeroTerms(current);
      if (next === current) break;
      current = next;
    }
    return current;
  };
  const finalTitle = sweep(result.title).slice(0, 80).trim();
  const finalDescription = sweep(result.description);
  const finalBullets = result.bulletPoints.map((b) => sweep(b)).filter((b) => b.trim());
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

module.exports = { cleanVeroTerms, splitForRewrite, usableRewrite, MAX_SNIPPETS, MAX_SNIPPET_CHARS, MAX_SNIPPET_TOTAL_CHARS };
