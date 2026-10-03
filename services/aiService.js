const axios = require('axios');
const { getAiSettings } = require('../models/settingsModel');
const { makeCache, hashKey } = require('./aiResponseCache');

function aiConfigured() {
  return !!process.env.ANTHROPIC_API_KEY;
}

// Every AI feature in this codebase (category pick, item specifics, VeRO clean, title/description, support
// replies...) calls through askClaude below, so caching HERE covers all of them at once - the exact same
// {system, prompt, maxTokens, model} sent to Claude will always get the exact same answer, so there is nothing lost
// by reusing it instead of paying for (and waiting on) another identical call. 24h matches the TTL
// aiCategoryService.js's own cache already uses; 2000 entries is a deliberately modest cap given these answers
// (full prompts, up to ~3500-token replies) are bigger than that service's own small {id,path,name} cache entries.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 2000;
const responseCache = makeCache({ ttlMs: CACHE_TTL_MS, max: CACHE_MAX });

/**
 * One call to the Anthropic Messages API using the model the admin chose in the Admin Panel. Identical calls (same
 * system/prompt/maxTokens/model) within CACHE_TTL_MS are answered from cache - no network call, no tokens billed -
 * instead of asking Claude the same thing again (returned inputTokens/outputTokens are 0 on a cache hit, since none
 * were actually spent; callers that log AiUsage from these fields already treat 0 as "nothing new to report").
 *
 * An answer the caller cannot use (unreadable JSON, an empty text) must not stay in that cache, or every "try again" would replay it for 24 hours
 * (seen live 2026-10-03): the answer carries a non-enumerable `discard()` that forgets it, and an empty answer is never kept in the first place.
 * A busy Anthropic API (429 "rate limit", 529 "overloaded", 500 / 503) is asked again up to twice, after the wait it names (Retry-After) plus up to 25%
 * so that 8 parallel calls do not all come back in the same instant - but only when that wait is 5 s or less: a longer one fails at once (waiting it out
 * would hold the whole bulk request). The bulk features now run 8 calls at once.
 * @returns {Promise<{ text: string, model: string, inputTokens: number, outputTokens: number, discard: () => void }>}
 */
async function askClaude({ prompt, maxTokens = 300, system = null }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    const err = new Error('AI is not configured on the server (ANTHROPIC_API_KEY is missing).');
    err.statusCode = 503;
    throw err;
  }
  const { aiModel } = await getAiSettings();
  const cacheKey = hashKey({ prompt, maxTokens, system, model: aiModel });
  const cached = responseCache.get(cacheKey);
  if (cached) return withDiscard({ ...cached, inputTokens: 0, outputTokens: 0 }, cacheKey);

  let response;
  for (let attempt = 0; ; attempt += 1) {
    try {
      response = await axios.post(
        'https://api.anthropic.com/v1/messages',
        { model: aiModel, max_tokens: maxTokens, ...(system ? { system } : {}), messages: [{ role: 'user', content: prompt }] },
        { headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, timeout: 30000 }
      );
      break;
    } catch (err) {
      if (attempt < RETRIES && RETRY_STATUSES.has(err.response?.status)) {
        const wait = retryWaitMs(err.response, attempt);
        if (wait !== null) {
          await deps.sleep(wait);
          continue;
        }
      }
      const wrapped = new Error(err.response?.data?.error?.message || 'The AI service could not be reached.');
      wrapped.statusCode = 502;
      throw wrapped;
    }
  }
  const result = {
    text: String(response.data?.content?.[0]?.text || ''),
    model: aiModel,
    inputTokens: response.data?.usage?.input_tokens || 0,
    outputTokens: response.data?.usage?.output_tokens || 0,
  };
  if (result.text.trim()) responseCache.set(cacheKey, { text: result.text, model: result.model }); // an empty answer is never kept
  return withDiscard(result, cacheKey);
}

/** The answer, plus a `discard()` that removes it from the cache (not listed when the answer is spread or compared). */
function withDiscard(answer, cacheKey) {
  Object.defineProperty(answer, 'discard', { value: () => { responseCache.delete(cacheKey); }, enumerable: false });
  return answer;
}

const RETRIES = 2;
const RETRY_STATUSES = new Set([429, 500, 503, 529]);
const MAX_RETRY_WAIT_MS = 5000;
// Replaceable for tests.
const deps = { sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), random: Math.random };
const RETRY_JITTER = 0.25;

/**
 * How long to wait before asking again: what the API asked for (Retry-After, seconds), else 1 s then 2 s, plus up to 25% (never more than 5 s in all).
 * null = the API asked for more than 5 s: do not wait that out, fail now.
 */
function retryWaitMs(response, attempt) {
  const asked = Number(response?.headers?.['retry-after']);
  const base = Number.isFinite(asked) && asked > 0 ? asked * 1000 : 1000 * (attempt + 1);
  if (base > MAX_RETRY_WAIT_MS) return null;
  return Math.min(Math.round(base * (1 + RETRY_JITTER * deps.random())), MAX_RETRY_WAIT_MS);
}

module.exports = { askClaude, aiConfigured, deps, _responseCache: responseCache };
