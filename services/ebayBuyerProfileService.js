const axios = require('axios');
const { getAccessToken } = require('./ebayAuthService');
const { EBAY_API_BASE_URL } = require('../config/ebayEnvironment');
const { SITE_IDS } = require('./ebayStatsService');
const { record } = require('./ebayCallBudget');

const PROFILE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 24 * 60 * 60 * 1000;

const SITE_NAMES = Object.freeze({
  US: 'United States', UK: 'United Kingdom', Canada: 'Canada', CanadaFrench: 'Canada', Australia: 'Australia',
  Germany: 'Germany', France: 'France', Italy: 'Italy', Spain: 'Spain', Netherlands: 'Netherlands', Austria: 'Austria',
  Switzerland: 'Switzerland', Ireland: 'Ireland', HongKong: 'Hong Kong', Singapore: 'Singapore', Malaysia: 'Malaysia',
  Philippines: 'Philippines', Poland: 'Poland', India: 'India', Belgium_French: 'Belgium', Belgium_Dutch: 'Belgium',
});

function pick(xml, tag) {
  const m = String(xml).match(new RegExp(String.raw`<${tag}>\s*([^<]*?)\s*</${tag}>`));
  return m ? m[1] : null;
}

/** Pulls the public profile fields out of a Trading API GetUser response. */
function parseBuyerProfile(xml) {
  const score = pick(xml, 'FeedbackScore');
  const registered = pick(xml, 'RegistrationDate');
  const site = pick(xml, 'Site');
  const parsedDate = registered ? new Date(registered) : null;
  return {
    feedbackScore: score !== null && Number.isFinite(Number(score)) ? Number(score) : null,
    starColor: pick(xml, 'FeedbackRatingStar') || null,
    memberSince: parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate : null,
    site: site ? (SITE_NAMES[site] || site.replace(/_/g, ' ')) : null,
  };
}

async function fetchBuyerProfile(refreshToken, username, marketplaceId) {
  const accessToken = await getAccessToken(refreshToken);
  record('core'); // counted against eBay's daily Trading allowance (services/ebayCallBudget.js)
  const safeUser = String(username).replace(/[<>&"']/g, '');
  const body = `<?xml version="1.0" encoding="utf-8"?>
<GetUserRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <UserID>${safeUser}</UserID>
  <DetailLevel>ReturnAll</DetailLevel>
</GetUserRequest>`;
  const response = await axios.post(`${EBAY_API_BASE_URL}/ws/api.dll`, body, {
    headers: {
      'Content-Type': 'text/xml',
      'X-EBAY-API-CALL-NAME': 'GetUser',
      'X-EBAY-API-COMPATIBILITY-LEVEL': '1193',
      'X-EBAY-API-SITEID': String(SITE_IDS[marketplaceId] ?? 0),
      'X-EBAY-API-IAF-TOKEN': accessToken,
    },
    timeout: 15000,
    responseType: 'text',
    transformResponse: (r) => r,
  });
  const xml = String(response.data || '');
  if (/<Ack>\s*Failure\s*<\/Ack>/i.test(xml)) {
    throw new Error((xml.match(/<ShortMessage>([\s\S]*?)<\/ShortMessage>/) || [])[1] || 'eBay rejected the profile request.');
  }
  return parseBuyerProfile(xml);
}

/**
 * Returns the buyer's cached profile for a conversation, refreshing it from eBay when
 * missing or older than 7 days. Never throws: the profile is decoration, so a failed
 * lookup (missing scope, unknown user) just leaves it empty and retries after a day.
 */
async function ensureBuyerProfile({ userId, conversationId, refreshToken, username, marketplaceId, existing }) {
  if (!username) return existing || null;
  const fetchedAt = existing?.fetchedAt ? new Date(existing.fetchedAt).getTime() : 0;
  if (fetchedAt && Date.now() - fetchedAt < PROFILE_TTL_MS) return existing;

  const Conversation = require('../models/schemas/Conversation');
  try {
    const profile = await fetchBuyerProfile(refreshToken, username, marketplaceId);
    const saved = { ...profile, fetchedAt: new Date() };
    await Conversation.updateOne({ _id: conversationId, userId }, { $set: { buyerProfile: saved } });
    return saved;
  } catch (err) {
    console.warn(`[buyer-profile] ${username}: ${err.message}`);
    const failed = { ...(existing || {}), fetchedAt: new Date(Date.now() - (PROFILE_TTL_MS - RETRY_AFTER_FAILURE_MS)) };
    await Conversation.updateOne({ _id: conversationId, userId }, { $set: { buyerProfile: failed } }).catch(() => {});
    return existing || null;
  }
}

module.exports = { parseBuyerProfile, fetchBuyerProfile, ensureBuyerProfile, PROFILE_TTL_MS };
