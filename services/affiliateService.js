/**
 * The affiliate programme. See services/affiliateRules.js for the rules in words.
 *
 *  apply / decide         a user applies (with a payout address), the admin approves or rejects
 *  attachAtSignup         a new account that came through ?aff=CODE belongs to that affiliate for life
 *  recordCommission       every payment of such an account earns the affiliate a percentage (held for `holdDays` first)
 *  dashboard              what the affiliate sees
 *  requestPayout          all ready commissions become one payout request (USDT / USDC)
 *  processPayout          the admin marks it paid (with the transaction hash) or rejects it
 */
const rules = require('./affiliateRules');
const model = require('../models/affiliatesModel');

const frontendUrl = () => String(process.env.FRONTEND_URL || 'https://elmstool.com').replace(/\/+$/, '');
// The link carries only the code (?via=CODE), nothing that says "affiliate". Old ?aff= links still work in the site.
const linkFor = (code) => frontendUrl() + '/?via=' + encodeURIComponent(code);
const fail = rules.fail;

async function settings() {
  return require('../models/settingsModel').getAffiliateSettings();
}

async function mail(kind, args) {
  try { await require('./emailService')[kind](args); } catch (err) { console.warn('affiliate mail ' + kind + ' failed:', err.message); }
}

/** A user applies. One application per user; a rejected one can apply again. */
async function apply(user, { network, address, promo }) {
  const s = await settings();
  if (!s.enabled) throw fail('The affiliate programme is not open right now.');
  const payout = rules.checkPayout(network, address);
  const existing = await model.getByUserId(user.id);
  if (existing && existing.status !== 'rejected') throw fail('You have already applied.');
  const text = String(promo || '').trim().slice(0, 600);
  let row;
  if (existing) {
    row = await model.update(existing.id, { status: 'pending', payoutNetwork: payout.network, payoutAddress: payout.address, promo: text, adminNote: '' });
  } else {
    for (let i = 0; i < 6 && !row; i += 1) {
      const code = rules.newCode();
      if (await model.referralCodeTaken(code)) continue;
      try { row = await model.create({ userId: user.id, code, payoutNetwork: payout.network, payoutAddress: payout.address, promo: text }); } catch (err) { if (!(err && err.code === 11000)) throw err; }
    }
    if (!row) throw fail('Could not create your affiliate code. Please try again.', 500);
  }
  mail('sendAdminAlert', { subject: 'New affiliate application', lines: ['User: ' + user.email, 'Payout: ' + rules.NETWORKS[payout.network].label, 'Plan: ' + (text || '(nothing written)'), 'Open Admin -> Affiliates to approve or reject.'] });
  return row;
}

/** An approved affiliate changes where they are paid. Not while a payout request is waiting. */
async function updatePayoutDetails(user, { network, address }) {
  const aff = await model.getByUserId(user.id);
  if (!aff) throw fail('You are not an affiliate.', 404);
  if (await model.openPayout(aff.id)) throw fail('A payout request is waiting. Change the address after it is paid.');
  const payout = rules.checkPayout(network, address);
  const row = await model.update(aff.id, { payoutNetwork: payout.network, payoutAddress: payout.address });
  mail('sendSecurityEmail', { to: user.email, subject: 'Your ELMS affiliate payout address changed', title: 'Your affiliate payout address was changed', paragraphs: ['New payout: ' + rules.NETWORKS[payout.network].label, 'If you made this change, nothing else is needed.', 'If you did not, change your password now and contact support before you request a payout.'] });
  return row;
}

/** The admin decides on an application (or changes an affiliate). action: approve | reject | suspend | reactivate */
async function decide(affId, action, { percent, note } = {}) {
  const aff = await model.getById(affId);
  if (!aff) throw fail('Affiliate not found.', 404);
  const set = { adminNote: String(note || '').slice(0, 600) };
  if (percent !== undefined) {
    if (percent === null || percent === '') set.commissionPercent = null;
    else {
      const p = Number(percent);
      if (!Number.isFinite(p) || p < 0 || p > 90) throw fail('The commission must be between 0 and 90 percent.');
      set.commissionPercent = rules.round2(p);
    }
  }
  if (action === 'approve' || action === 'reactivate') { set.status = 'approved'; if (!aff.approvedAt) set.approvedAt = new Date(); }
  else if (action === 'reject') set.status = 'rejected';
  else if (action === 'suspend') set.status = 'suspended';
  else if (action !== 'save') throw fail('Unknown action.');
  const row = await model.update(aff.id, set);
  if (action === 'approve' && aff.status !== 'approved') {
    const owner = await require('../models/usersModel').getUserById(aff.userId);
    if (owner && owner.email) mail('sendAffiliateDecisionEmail', { to: owner.email, approved: true, link: linkFor(aff.code), percent: rules.percentFor(row, await settings()), note: set.adminNote });
  } else if (action === 'reject') {
    const owner = await require('../models/usersModel').getUserById(aff.userId);
    if (owner && owner.email) mail('sendAffiliateDecisionEmail', { to: owner.email, approved: false, note: set.adminNote });
  }
  return row;
}

/** A new account came through an affiliate link. Returns { applied } (never throws: a bad link must not stop a sign-up). */
async function attachAtSignup(user, rawCode) {
  try {
    const code = rules.cleanCode(rawCode);
    if (!code) return { applied: false };
    const aff = await model.getByCode(code);
    if (!aff || aff.status !== 'approved') return { applied: false, reason: 'invalid_code' };
    if (String(aff.userId) === String(user.id)) return { applied: false, reason: 'self' };
    const owner = await require('../models/usersModel').getUserById(aff.userId);
    if (owner && owner.email && String(owner.email).toLowerCase() === String(user.email || '').toLowerCase()) return { applied: false, reason: 'self' };
    return { applied: await model.attachUser(user.id, aff.id) };
  } catch (err) {
    console.error('affiliate attach error:', err.message);
    return { applied: false, reason: 'error' };
  }
}

/** A payment was made: if the buyer belongs to an affiliate, the affiliate earns their percentage. Never throws. */
async function recordCommission(purchase) {
  try {
    if (!purchase || purchase.provider === 'voucher' || !(Number(purchase.priceUsd) > 0)) return null;
    const s = await settings();
    if (!s.enabled) return null;
    const link = await model.affiliateIdOfUser(purchase.userId);
    if (!link || !link.affiliateId) return null;
    const aff = await model.getById(link.affiliateId);
    if (!aff || aff.status !== 'approved') return null;
    if (String(aff.userId) === String(purchase.userId)) return null; // never on their own purchases
    const percent = rules.percentFor(aff, s);
    const commissionUsd = rules.commissionFor(purchase.priceUsd, percent);
    if (!(commissionUsd > 0)) return null;
    return await model.createCommission({
      affiliateId: aff.id, referredUserId: purchase.userId, purchaseId: purchase.id,
      paidUsd: Number(purchase.priceUsd), percent, commissionUsd, availableAt: rules.availableAt(new Date(), s.holdDays),
    });
  } catch (err) {
    console.error('affiliate commission error:', err.message);
    return null;
  }
}

/** What the signed-in user sees on the Affiliate page. */
async function dashboard(user) {
  const s = await settings();
  const aff = await model.getByUserId(user.id);
  const base = { enabled: s.enabled, networks: rules.networkList(), defaultPercent: s.defaultPercent, holdDays: s.holdDays, minPayoutUsd: s.minPayoutUsd };
  if (!aff) return { ...base, status: 'none' };
  if (aff.status !== 'approved' && aff.status !== 'suspended') return { ...base, status: aff.status, note: aff.adminNote, network: aff.payoutNetwork, address: aff.payoutAddress };
  const [totals, signups, commissions, payouts, open] = await Promise.all([model.totals(aff.id), model.signups(aff.id), model.commissionsFor(aff.id), model.payoutsFor(aff.id), model.openPayout(aff.id)]);
  const customerEmails = new Map();
  const User = require('../models/schemas/User');
  const users = await User.find({ _id: { $in: [...new Set(commissions.map((c) => c.referredUserId))] } }, { email: 1 }).lean();
  users.forEach((u) => customerEmails.set(String(u._id), rules.maskEmail(u.email)));
  const now = Date.now();
  return {
    ...base,
    status: aff.status,
    code: aff.code,
    link: linkFor(aff.code),
    percent: rules.percentFor(aff, s),
    network: aff.payoutNetwork,
    address: aff.payoutAddress,
    totals: { ...totals, signups },
    canRequest: aff.status === 'approved' && !open && totals.available >= s.minPayoutUsd,
    openPayout: open,
    commissions: commissions.map((c) => ({ id: c.id, customer: customerEmails.get(c.referredUserId) || '', paidUsd: c.paidUsd, percent: c.percent, commissionUsd: c.commissionUsd, state: c.status === 'void' ? 'void' : c.status === 'paid' ? 'paid' : c.payoutId ? 'requested' : new Date(c.availableAt).getTime() > now ? 'hold' : 'available', availableAt: c.availableAt, createdAt: c.createdAt })),
    payouts,
  };
}

/** The affiliate asks for their ready commissions. */
async function requestPayout(user) {
  const aff = await model.getByUserId(user.id);
  if (!aff || aff.status !== 'approved') throw fail('Your affiliate account is not active.', 403);
  if (!aff.payoutAddress || !aff.payoutNetwork) throw fail('Add your payout address first.');
  if (await model.openPayout(aff.id)) throw fail('You already have a payout request waiting.');
  const s = await settings();
  const p = await model.createPayout({ affiliateId: aff.id, amountUsd: 0, network: aff.payoutNetwork, address: aff.payoutAddress });
  const amount = await model.claimAvailable(aff.id, p.id);
  if (amount < s.minPayoutUsd) {
    await model.releasePayout(p.id);
    await model.deletePayout(p.id);
    throw fail('The minimum payout is $' + s.minPayoutUsd + '. You have $' + amount.toFixed(2) + ' ready.');
  }
  const done = await model.updatePayout(p.id, { amountUsd: amount });
  mail('sendAdminAlert', { subject: 'Affiliate payout request: $' + amount.toFixed(2), lines: ['Affiliate: ' + user.email, 'Amount: $' + amount.toFixed(2), 'Send ' + rules.NETWORKS[aff.payoutNetwork].label, 'Address: ' + aff.payoutAddress, 'Open Admin -> Affiliates -> Payouts. It should be paid within 24-48 hours.'] });
  return done;
}

/** The admin sends the money and marks it paid (txHash), or rejects the request (the commissions become ready again). */
async function processPayout(payoutId, { action, txHash, note } = {}) {
  const p = await model.getPayout(payoutId);
  if (!p) throw fail('Payout not found.', 404);
  if (p.status !== 'requested') throw fail('This payout was already handled.');
  const aff = await model.getById(p.affiliateId);
  const owner = aff && await require('../models/usersModel').getUserById(aff.userId);
  if (action === 'paid') {
    const hash = String(txHash || '').trim().slice(0, 200);
    if (hash.length < 6) throw fail('Paste the transaction hash of the payment.');
    const row = await model.updatePayout(p.id, { status: 'paid', txHash: hash, adminNote: String(note || '').slice(0, 600), processedAt: new Date() }, 'requested');
    if (!row) throw fail('This payout was already handled.');
    await model.markPayoutPaid(p.id);
    if (owner && owner.email) mail('sendAffiliatePaidEmail', { to: owner.email, amountUsd: p.amountUsd, network: rules.NETWORKS[p.network] ? rules.NETWORKS[p.network].label : p.network, address: p.address, txHash: hash });
    return row;
  }
  if (action === 'reject') {
    const row = await model.updatePayout(p.id, { status: 'rejected', adminNote: String(note || '').slice(0, 600), processedAt: new Date() }, 'requested');
    if (!row) throw fail('This payout was already handled.');
    await model.releasePayout(p.id);
    return row;
  }
  throw fail('Unknown action.');
}

module.exports = { apply, updatePayoutDetails, decide, attachAtSignup, recordCommission, dashboard, requestPayout, processPayout, linkFor, settings };
