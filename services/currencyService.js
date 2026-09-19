const axios = require('axios');

const TTL_MS = 12 * 60 * 60 * 1000;
let cache = null; // { at, rates } - rates are per 1 USD

async function getRates() {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.rates;
  const res = await axios.get('https://open.er-api.com/v6/latest/USD', { timeout: 8000 });
  const rates = res.data?.rates;
  if (!rates || res.data?.result === 'error') throw new Error('Exchange rates are unavailable right now.');
  cache = { at: Date.now(), rates };
  return rates;
}

/**
 * Converts an amount between currencies with a daily exchange rate.
 * A listing priced in USD (Amazon US) published to a GBP store must not go live as "GBP 25" when it meant "USD 25".
 */
async function convertAmount(amount, from, to) {
  const a = String(from || '').toUpperCase();
  const b = String(to || '').toUpperCase();
  if (!a || !b || a === b) return { amount: Number(amount), rate: 1, converted: false };
  const rates = await getRates();
  if (!rates[a] || !rates[b]) throw new Error(`No exchange rate for ${a} to ${b}.`);
  const rate = rates[b] / rates[a];
  return { amount: Number((Number(amount) * rate).toFixed(2)), rate: Number(rate.toFixed(6)), converted: true };
}

module.exports = { convertAmount };
