/**
 * Affiliate programme rules that do not touch the database: payout networks and address checks, the admin settings, money maths.
 *
 * An affiliate is an ELMS user the admin approved. People who sign up through their link (?aff=CODE) are theirs for life: the
 * affiliate earns a percentage of every payment those people make. Commissions wait in a hold (refund protection), then can be
 * paid out in USDT or USDC once the balance reaches the minimum; the admin sends it and marks it paid (24-48 hours).
 */
const DEFAULTS = { enabled: true, defaultPercent: 20, holdDays: 7, minPayoutUsd: 20 };

const NETWORKS = {
  USDT_TRC20: { label: 'USDT on TRON (TRC20)', coin: 'USDT', re: /^T[1-9A-HJ-NP-Za-km-z]{33}$/ },
  USDT_ERC20: { label: 'USDT on Ethereum (ERC20)', coin: 'USDT', re: /^0x[a-fA-F0-9]{40}$/ },
  USDT_BEP20: { label: 'USDT on BNB Smart Chain (BEP20)', coin: 'USDT', re: /^0x[a-fA-F0-9]{40}$/ },
  USDC_ERC20: { label: 'USDC on Ethereum (ERC20)', coin: 'USDC', re: /^0x[a-fA-F0-9]{40}$/ },
  USDC_BASE: { label: 'USDC on Base', coin: 'USDC', re: /^0x[a-fA-F0-9]{40}$/ },
  USDC_SOL: { label: 'USDC on Solana', coin: 'USDC', re: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ },
};

const fail = (message, statusCode = 400) => Object.assign(new Error(message), { userFacing: true, statusCode });
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function networkList() {
  return Object.entries(NETWORKS).map(([id, n]) => ({ id, label: n.label, coin: n.coin }));
}

/** A payout network and address, checked so a typo or the wrong chain is caught before any money is sent. */
function checkPayout(network, address) {
  const n = NETWORKS[String(network || '')];
  if (!n) throw fail('Choose USDT or USDC and its network.');
  const a = String(address || '').trim();
  if (!n.re.test(a)) throw fail('That is not a valid ' + n.label + ' address. Check it and the network you chose.');
  return { network: String(network), address: a };
}

function normalizeSettings(input = {}) {
  const num = (v, d) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
  const s = {
    enabled: input.enabled === undefined || input.enabled === null ? DEFAULTS.enabled : !!input.enabled,
    defaultPercent: round2(num(input.defaultPercent, DEFAULTS.defaultPercent)),
    holdDays: Math.round(num(input.holdDays, DEFAULTS.holdDays)),
    minPayoutUsd: round2(num(input.minPayoutUsd, DEFAULTS.minPayoutUsd)),
  };
  if (s.defaultPercent < 0 || s.defaultPercent > 90) throw fail('The commission must be between 0 and 90 percent.');
  if (s.holdDays < 0 || s.holdDays > 90) throw fail('The hold must be between 0 and 90 days.');
  if (s.minPayoutUsd < 1 || s.minPayoutUsd > 100000) throw fail('The minimum payout must be at least $1.');
  return s;
}

/** The commission for one payment. `percent` is the affiliate's own rate or the default. */
function commissionFor(paidUsd, percent) {
  return round2((Number(paidUsd) || 0) * (Number(percent) || 0) / 100);
}

function percentFor(affiliate, settings) {
  return affiliate && affiliate.commissionPercent != null ? Number(affiliate.commissionPercent) : Number(settings.defaultPercent);
}

/** When a commission made now can be paid out. */
function availableAt(from, holdDays) {
  return new Date(new Date(from).getTime() + Math.max(0, Number(holdDays) || 0) * 86400000);
}

// 10 characters (referral codes are 8, or a custom word): an affiliate code never looks like or equals a referral code.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode(random = Math.random) {
  let out = '';
  for (let i = 0; i < 10; i += 1) out += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)];
  return out;
}
const cleanCode = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 24);

/** a***@gmail.com : enough for the affiliate to recognise a customer, not enough to contact them. */
function maskEmail(email) {
  const [name, domain] = String(email || '').split('@');
  if (!domain) return '';
  return (name[0] || '') + '***@' + domain;
}

module.exports = { DEFAULTS, NETWORKS, networkList, checkPayout, normalizeSettings, commissionFor, percentFor, availableAt, newCode, cleanCode, maskEmail, round2, fail };
