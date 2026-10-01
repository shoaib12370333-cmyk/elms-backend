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
 * @returns {Promise<{ text: string, model: string, inputTokens: number, outputTokens: number }>}
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
  if (cached) return { ...cached, inputTokens: 0, outputTokens: 0 };

  let response;
  try {
    response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      { model: aiModel, max_tokens: maxTokens, ...(system ? { system } : {}), messages: [{ role: 'user', content: prompt }] },
      { headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, timeout: 30000 }
    );
  } catch (err) {
    const wrapped = new Error(err.response?.data?.error?.message || 'The AI service could not be reached.');
    wrapped.statusCode = 502;
    throw wrapped;
  }
  const result = {
    text: String(response.data?.content?.[0]?.text || ''),
    model: aiModel,
    inputTokens: response.data?.usage?.input_tokens || 0,
    outputTokens: response.data?.usage?.output_tokens || 0,
  };
  responseCache.set(cacheKey, { text: result.text, model: result.model });
  return result;
}

module.exports = { askClaude, aiConfigured, _responseCache: responseCache };
