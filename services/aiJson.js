/**
 * Asks the AI for a JSON object and reads it - for the features whose prompt says "Reply with ONLY a JSON object" (VeRO clean, item specifics).
 *
 * An answer that cannot be read is
 *   - FORGOTTEN: askClaude (services/aiService.js) keeps every answer for 24 hours, so without this the unreadable one would be replayed,
 *     instantly, to every "Please try again" (seen live 2026-10-03: two listings of a 50-listing VeRO clean failed, and a retry failed again in 0.8 s);
 *   - LOGGED (its start and its end, so a cut-off answer or one with prose around it can be told apart), because the person only sees "could not be read";
 *   - ASKED AGAIN, once: the model does not answer the same way twice (the cache was the only reason it seemed to).
 * Only when every try is unreadable does it throw, with the message the screens already show.
 *
 * `askClaude` is passed in (not required here) so a test can replace it, as the callers' own tests do.
 *
 * @returns {Promise<{ parsed: object, answer: object, usage: { text, model, inputTokens, outputTokens } }>} usage adds up every try
 */
async function askForJsonObject(askClaude, request, { label = 'ai', attempts = 2 } = {}) {
  const usage = { text: '', model: null, inputTokens: 0, outputTokens: 0 };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const answer = await askClaude(request);
    usage.text = answer.text;
    usage.model = answer.model || usage.model;
    usage.inputTokens += answer.inputTokens || 0;
    usage.outputTokens += answer.outputTokens || 0;
    const parsed = readJsonObject(answer.text);
    if (parsed) return { parsed, answer, usage };
    if (typeof answer.discard === 'function') answer.discard();
    const text = String(answer.text || '');
    console.warn(`[${label}] the AI answer could not be read (try ${attempt}/${attempts}), ${text.length} characters: ${JSON.stringify(text.slice(0, 160))} ... ${JSON.stringify(text.slice(-120))}`);
  }
  const err = new Error('The AI answer could not be read. Please try again.');
  err.statusCode = 502;
  throw err;
}

const parseObject = (json) => {
  try {
    const value = JSON.parse(json);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch (_) {
    return null;
  }
};

/**
 * The first complete {...} that starts at `start`, found by walking the text (braces inside strings do not count), with a raw line break / tab / control
 * character INSIDE a string written as the escape JSON requires (a model often puts a real newline in a string; JSON.parse refuses it). null when it never closes.
 */
function balancedObject(s, start) {
  let out = '';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i += 1) {
    const ch = s[i];
    if (inString) {
      if (escaped) { escaped = false; out += ch; continue; }
      if (ch === '\\') { escaped = true; out += ch; continue; }
      if (ch === '"') { inString = false; out += ch; continue; }
      const code = ch.charCodeAt(0);
      out += code < 0x20 ? (ch === '\n' ? '\\n' : ch === '\r' ? '\\r' : ch === '\t' ? '\\t' : '\\u' + code.toString(16).padStart(4, '0')) : ch;
      continue;
    }
    out += ch;
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return { json: out, rest: s.slice(i + 1) };
    }
  }
  return null;
}

/**
 * The JSON object inside an answer, or null. Prose around it is ignored: first the text from the first { to the last } as it is; else the first complete
 * object (a stray } in the prose after it, or raw line breaks inside its strings). When more text follows that holds another {, there is no telling which
 * object is the answer, so it is NOT guessed.
 */
function readJsonObject(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  if (start < 0) return null;
  const end = s.lastIndexOf('}');
  const whole = end > start ? parseObject(s.slice(start, end + 1)) : null;
  if (whole) return whole;
  const first = balancedObject(s, start);
  if (!first || first.rest.includes('{')) return null;
  return parseObject(first.json);
}

module.exports = { askForJsonObject, readJsonObject };
