/**
 * Normalizes common carrier names/codes into eBay Fulfillment API carrier codes.
 * This is intentionally deterministic and does not call a third-party tracking
 * service. It converts the supplier/source carrier representation into the
 * code eBay accepts for shipping fulfillment.
 */
const CARRIER_ALIASES = new Map([
  ['usps', 'USPS'], ['u.s.p.s.', 'USPS'], ['united states postal service', 'USPS'],
  ['ups', 'UPS'], ['united parcel service', 'UPS'],
  ['fedex', 'FEDEX'], ['fed ex', 'FEDEX'], ['federal express', 'FEDEX'],
  ['dhl', 'DHL'], ['dhl express', 'DHL'],
  ['ontrac', 'ONTRAC'],
  ['lasership', 'LASERSHIP'],
  ['royal mail', 'ROYAL_MAIL'],
  ['canada post', 'CANADA_POST'],
  ['australia post', 'AUSTRALIA_POST'],
  ['evri', 'EVRI'],
  ['hermes', 'HERMES'],
  ['dpd', 'DPD'],
  ['gls', 'GLS'],
  ['amazon', 'AMAZON'], ['amazon logistics', 'AMAZON'], ['amzl', 'AMAZON'],
]);

function normalizeCarrier(value) {
  const raw = String(value || '').trim();
  if (!raw) return { carrierCode: 'OTHER', confidence: 'low', input: raw };
  const key = raw.toLowerCase().replace(/\s+/g, ' ');
  if (CARRIER_ALIASES.has(key)) {
    return { carrierCode: CARRIER_ALIASES.get(key), confidence: 'high', input: raw };
  }
  const compact = key.replace(/[^a-z0-9]/g, '');
  for (const [alias, code] of CARRIER_ALIASES.entries()) {
    if (alias.replace(/[^a-z0-9]/g, '') === compact) {
      return { carrierCode: code, confidence: 'medium', input: raw };
    }
  }
  return { carrierCode: 'OTHER', confidence: 'low', input: raw };
}

function convertTracking({ trackingNumber, carrier }) {
  const tracking = String(trackingNumber || '').trim();
  if (!tracking) throw new Error('A tracking number is required.');
  const result = normalizeCarrier(carrier);
  return {
    trackingNumber: tracking,
    shippingCarrierCode: result.carrierCode,
    confidence: result.confidence,
    sourceCarrier: result.input || null,
  };
}

module.exports = { normalizeCarrier, convertTracking };
