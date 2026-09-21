const axios = require('axios');

/** Small, dependency-free user-agent reader: browser, operating system and device type. */
function parseUserAgent(ua) {
  const s = String(ua || '');
  let browser = 'Unknown browser';
  const pick = (re, name) => { const m = s.match(re); return m ? name + (m[1] ? ' ' + m[1].split('.')[0] : '') : null; };
  browser = pick(/Edg(?:e|A|iOS)?\/([\d.]+)/, 'Edge') || pick(/OPR\/([\d.]+)/, 'Opera') || pick(/SamsungBrowser\/([\d.]+)/, 'Samsung Internet')
    || pick(/(?:Chrome|CriOS)\/([\d.]+)/, 'Chrome') || pick(/(?:Firefox|FxiOS)\/([\d.]+)/, 'Firefox')
    || (/Safari\//.test(s) ? pick(/Version\/([\d.]+)/, 'Safari') || 'Safari' : null) || (/curl|node|axios|postman/i.test(s) ? 'API client' : browser);

  let os = 'Unknown system';
  if (/Windows NT 10/.test(s)) os = 'Windows 10/11'; else if (/Windows NT/.test(s)) os = 'Windows';
  else if (/Android ([\d.]+)/.test(s)) os = 'Android ' + s.match(/Android ([\d.]+)/)[1].split('.')[0];
  else if (/iPhone|iPad|iPod/.test(s)) os = 'iOS';
  else if (/Mac OS X/.test(s)) os = 'macOS';
  else if (/CrOS/.test(s)) os = 'ChromeOS';
  else if (/Linux/.test(s)) os = 'Linux';

  let deviceType = 'desktop';
  if (/iPad|Tablet/i.test(s)) deviceType = 'tablet';
  else if (/Mobile|iPhone|Android/i.test(s)) deviceType = /Android/i.test(s) && !/Mobile/i.test(s) ? 'tablet' : 'mobile';
  if (browser === 'Unknown browser' && os === 'Unknown system') deviceType = 'unknown';
  return { browser, os, deviceType };
}

function clientIp(req) {
  const raw = String(req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  return raw || null;
}

const PRIVATE = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fc|fd|169\.254\.)/i;
const geoCache = new Map();

/**
 * Approximate place for an IP address (city, region, country) from a public geolocation service.
 * Best effort: a failure just means the place is unknown. Results are cached for 6 hours.
 */
async function lookupLocation(ip) {
  if (!ip) return { city: null, region: null, country: null };
  if (PRIVATE.test(ip)) return { city: null, region: null, country: 'Local network' };
  const hit = geoCache.get(ip);
  if (hit && Date.now() - hit.at < 6 * 60 * 60 * 1000) return hit.value;
  let value = { city: null, region: null, country: null };
  try {
    const res = await axios.get('https://ipwho.is/' + encodeURIComponent(ip) + '?fields=success,city,region,country', { timeout: 2500 });
    if (res.data?.success) value = { city: res.data.city || null, region: res.data.region || null, country: res.data.country || null };
  } catch (_) { /* unknown place */ }
  geoCache.set(ip, { at: Date.now(), value });
  if (geoCache.size > 2000) geoCache.clear();
  return value;
}

module.exports = { parseUserAgent, clientIp, lookupLocation };
