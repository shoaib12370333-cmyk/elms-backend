/**
 * Which currency an Amazon site shows its prices in. Amazon always shows its own local currency, so the site a link points to
 * is the most reliable answer to "what currency is this price in?" - more reliable than a page's language or a default of USD
 * (a product from amazon.com.au read as USD would be converted to AUD a second time when published to an AU store).
 */
const SUFFIX_CURRENCY = Object.freeze({
  com: 'USD', 'co.uk': 'GBP', ca: 'CAD', 'com.au': 'AUD',
  de: 'EUR', fr: 'EUR', it: 'EUR', es: 'EUR', nl: 'EUR', be: 'EUR', ie: 'EUR',
  pl: 'PLN', se: 'SEK', in: 'INR', 'co.jp': 'JPY', 'com.mx': 'MXN', 'com.br': 'BRL',
  sg: 'SGD', ae: 'AED', sa: 'SAR', 'com.tr': 'TRY', eg: 'EGP',
});

/** The currency of the Amazon site a URL (or bare host name) belongs to, or null when it is not an Amazon site we know. */
function currencyForAmazonUrl(url) {
  let host;
  try { host = new URL(/^https?:\/\//i.test(String(url)) ? String(url) : 'https://' + String(url)).hostname.toLowerCase(); } catch (_) { return null; }
  const m = host.match(/(?:^|\.)amazon\.([a-z.]+)$/);
  return (m && SUFFIX_CURRENCY[m[1]]) || null;
}

/** The currency of an Amazon domain suffix as Easyparser writes it (".co.uk", ".com", ...), or null when it is not one we know. */
function currencyForSuffix(suffix) {
  const key = String(suffix || '').trim().toLowerCase().replace(/^\./, '');
  return SUFFIX_CURRENCY[key] || null;
}

/**
 * The currency a product's Amazon price is in: what the Amazon site it came from says, else what was saved with it.
 * (Drafts saved with a wrong default of USD exist; the site is the truth.)
 */
function sourceCurrency(amazonUrl, savedCurrency) {
  const c = currencyForAmazonUrl(amazonUrl) || (savedCurrency ? String(savedCurrency).toUpperCase() : null);
  return c || null;
}

module.exports = { currencyForAmazonUrl, currencyForSuffix, sourceCurrency, SUFFIX_CURRENCY };
