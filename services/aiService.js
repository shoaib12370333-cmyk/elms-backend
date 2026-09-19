const axios = require('axios');
const { getAiSettings } = require('../models/settingsModel');

function aiConfigured() {
  return !!process.env.ANTHROPIC_API_KEY;
}

/**
 * One call to the Anthropic Messages API using the model the admin chose in the Admin Panel.
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
  return {
    text: String(response.data?.content?.[0]?.text || ''),
    model: aiModel,
    inputTokens: response.data?.usage?.input_tokens || 0,
    outputTokens: response.data?.usage?.output_tokens || 0,
  };
}

module.exports = { askClaude, aiConfigured };
