// Affiliate programme: applying (payout address checked), approval, attaching a sign-up, commissions with a hold, payout requests, admin paying.
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
const rules = require('../services/affiliateRules');

// ---- rules
assert.strictEqual(rules.checkPayout('USDT_TRC20', ' TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE ').network, 'USDT_TRC20');
assert.strictEqual(rules.checkPayout('USDC_ERC20', '0x52908400098527886E0F7030069857D2E4169EE7').address, '0x52908400098527886E0F7030069857D2E4169EE7');
assert.strictEqual(rules.checkPayout('USDC_SOL', '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV').network, 'USDC_SOL');
assert.throws(() => rules.checkPayout('USDT_TRC20', '0x52908400098527886E0F7030069857D2E4169EE7'), /valid USDT on TRON/, 'an Ethereum address on the TRON network');
assert.throws(() => rules.checkPayout('USDT_ERC20', 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE'), /valid USDT on Ethereum/);
assert.throws(() => rules.checkPayout('BTC', 'x'), /Choose USDT or USDC/);
assert.throws(() => rules.checkPayout('USDT_TRC20', ''), /valid/);
assert.deepStrictEqual(rules.normalizeSettings({}), rules.DEFAULTS);
assert.throws(() => rules.normalizeSettings({ defaultPercent: 95 }), /between 0 and 90/);
assert.throws(() => rules.normalizeSettings({ holdDays: -1 }), /hold/);
assert.throws(() => rules.normalizeSettings({ minPayoutUsd: 0 }), /minimum payout/);
assert.strictEqual(rules.commissionFor(120, 20), 24);
assert.strictEqual(rules.commissionFor(33.33, 15), 5);
assert.strictEqual(rules.percentFor({ commissionPercent: 30 }, { defaultPercent: 20 }), 30);
assert.strictEqual(rules.percentFor({ commissionPercent: null }, { defaultPercent: 20 }), 20);
assert.strictEqual(rules.percentFor({ commissionPercent: 0 }, { defaultPercent: 20 }), 0, '0 percent is a real rate');
assert.strictEqual(rules.maskEmail('ali.khan@gmail.com'), 'a***@gmail.com');
assert.ok(/^[A-Z2-9]{8}$/.test(rules.newCode()));
assert.strictEqual(rules.cleanCode(' ab-12 x '), 'AB12X');

// ---- in-memory model
const now = () => new Date();
const store = { affs: [], comms: [], payouts: [], users: new Map(), attached: new Map() };
let n = 0;
const oid = () => String(++n).padStart(24, '0');
const model = {
  // copies, like the database returns (the code compares the state before and after an update)
  getByUserId: async (uid) => { const a = store.affs.find((x) => x.userId === uid); return a ? { ...a } : null; },
  getById: async (id) => { const a = store.affs.find((x) => x.id === id); return a ? { ...a } : null; },
  getByCode: async (c) => { const a = store.affs.find((x) => x.code === c); return a ? { ...a } : null; },
  create: async (row) => { if (store.affs.some((a) => a.code === row.code)) throw Object.assign(new Error('dup'), { code: 11000 }); const a = { id: oid(), status: 'pending', commissionPercent: null, adminNote: '', approvedAt: null, ...row }; store.affs.push(a); return a; },
  update: async (id, set) => { const a = store.affs.find((x) => x.id === id); Object.assign(a, set); return { ...a }; },
  attachUser: async (uid, aid) => { if (store.attached.has(uid)) return false; store.attached.set(uid, aid); return true; },
  affiliateIdOfUser: async (uid) => (store.attached.has(uid) ? { affiliateId: store.attached.get(uid), email: 'x' } : { affiliateId: null }),
  signups: async (aid) => [...store.attached.values()].filter((v) => v === aid).length,
  createCommission: async (row) => { if (store.comms.some((c) => c.purchaseId === row.purchaseId)) return null; const c = { id: oid(), status: 'active', payoutId: null, createdAt: now(), ...row }; store.comms.push(c); return c; },
  commissionsFor: async (aid) => store.comms.filter((c) => c.affiliateId === aid),
  totals: async (aid) => {
    const out = { earned: 0, hold: 0, available: 0, requested: 0, paid: 0, customers: 0, payments: 0 }; const seen = new Set();
    for (const c of store.comms.filter((x) => x.affiliateId === aid && x.status !== 'void')) {
      out.earned += c.commissionUsd; out.payments += 1; seen.add(c.referredUserId);
      if (c.status === 'paid') out.paid += c.commissionUsd; else if (c.payoutId) out.requested += c.commissionUsd; else if (c.availableAt > now()) out.hold += c.commissionUsd; else out.available += c.commissionUsd;
    }
    out.customers = seen.size; return out;
  },
  createPayout: async (row) => { const p = { id: oid(), status: 'requested', txHash: '', adminNote: '', ...row }; store.payouts.push(p); return p; },
  getPayout: async (id) => store.payouts.find((p) => p.id === id) || null,
  openPayout: async (aid) => store.payouts.find((p) => p.affiliateId === aid && p.status === 'requested') || null,
  payoutsFor: async (aid) => store.payouts.filter((p) => p.affiliateId === aid),
  updatePayout: async (id, set, only) => { const p = store.payouts.find((x) => x.id === id && (!only || x.status === only)); if (!p) return null; Object.assign(p, set); return p; },
  deletePayout: async (id) => { store.payouts = store.payouts.filter((p) => p.id !== id); },
  claimAvailable: async (aid, pid) => { store.comms.filter((c) => c.affiliateId === aid && c.status === 'active' && !c.payoutId && c.availableAt <= now()).forEach((c) => { c.payoutId = pid; }); return Math.round(store.comms.filter((c) => c.payoutId === pid).reduce((t, c) => t + c.commissionUsd, 0) * 100) / 100; },
  releasePayout: async (pid) => { store.comms.filter((c) => c.payoutId === pid && c.status !== 'paid').forEach((c) => { c.payoutId = null; }); },
  markPayoutPaid: async (pid) => { store.comms.filter((c) => c.payoutId === pid).forEach((c) => { c.status = 'paid'; }); },
};
const mails = [];
let cfg = { enabled: true, defaultPercent: 20, holdDays: 7, minPayoutUsd: 20 };
stub('models/affiliatesModel', model);
stub('models/settingsModel', { getAffiliateSettings: async () => ({ ...cfg }) });
stub('models/usersModel', { getUserById: async (id) => store.users.get(id) || null });
stub('models/schemas/User', { find: () => ({ lean: async () => [...store.users.values()].map((u) => ({ _id: u.id, email: u.email })) }) });
const em = (k) => async (m) => { mails.push({ k, ...m }); };
stub('services/emailService', { sendAdminAlert: em('admin'), sendSecurityEmail: em('security'), sendAffiliateDecisionEmail: em('decision'), sendAffiliatePaidEmail: em('paid') });
const svc = require('../services/affiliateService');
const flush = () => new Promise((r) => setImmediate(r));

const user = (id, email) => { const u = { id, email, name: id }; store.users.set(id, u); return u; };
const boss = user('u_aff', 'aff@x.com');
const friend = user('u_friend', 'friend@x.com');
const OK_ADDR = 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE';
const purchase = (o) => ({ id: oid(), userId: 'u_friend', provider: 'cashtap', priceUsd: 120, ...o });

(async () => {
  // apply: a bad address is refused, a good one makes a pending application with a code and tells the admin
  await assert.rejects(() => svc.apply(boss, { network: 'USDT_TRC20', address: '0xabc' }), /valid USDT on TRON/);
  let row = await svc.apply(boss, { network: 'USDT_TRC20', address: OK_ADDR, promo: 'YouTube channel' });
  assert.strictEqual(row.status, 'pending');
  assert.ok(/^[A-Z2-9]{8}$/.test(row.code));
  await flush();
  assert.ok(mails.some((m) => m.k === 'admin' && /application/.test(m.subject)));
  await assert.rejects(() => svc.apply(boss, { network: 'USDT_TRC20', address: OK_ADDR }), /already applied/);
  let dash = await svc.dashboard(boss);
  assert.strictEqual(dash.status, 'pending');

  // nobody earns before approval: a link of a pending affiliate is not valid
  assert.strictEqual((await svc.attachAtSignup(friend, row.code)).applied, false);

  // approve (own rate 25) -> the link works; self and unknown codes do not
  row = await svc.decide(row.id, 'approve', { percent: 25 });
  await flush();
  assert.strictEqual(row.status, 'approved');
  assert.strictEqual(row.commissionPercent, 25);
  assert.ok(mails.some((m) => m.k === 'decision' && m.approved === true && m.to === 'aff@x.com'));
  assert.strictEqual((await svc.attachAtSignup(boss, row.code)).reason, 'self');
  assert.strictEqual((await svc.attachAtSignup(friend, 'NOSUCHCD')).applied, false);
  assert.strictEqual((await svc.attachAtSignup(friend, row.code)).applied, true);
  assert.strictEqual((await svc.attachAtSignup(friend, row.code)).applied, false, 'a person belongs to one affiliate, once');

  // commissions: a percentage of what was paid; none on a voucher plan, a zero payment, an unattached buyer, or the affiliate themselves
  const p1 = purchase({ priceUsd: 120 });
  const c1 = await svc.recordCommission(p1);
  assert.deepStrictEqual([c1.commissionUsd, c1.percent, c1.paidUsd], [30, 25, 120]);
  assert.ok(c1.availableAt > new Date(Date.now() + 6 * 86400000), 'held for about 7 days');
  assert.strictEqual(await svc.recordCommission(p1), null, 'the same purchase never earns twice');
  assert.strictEqual(await svc.recordCommission(purchase({ provider: 'voucher', priceUsd: 0 })), null);
  assert.strictEqual(await svc.recordCommission(purchase({ priceUsd: 0 })), null);
  assert.strictEqual(await svc.recordCommission(purchase({ userId: 'somebody' })), null);
  store.attached.set('u_aff', row.id);
  assert.strictEqual(await svc.recordCommission(purchase({ userId: 'u_aff' })), null, 'not on their own purchase');
  store.attached.delete('u_aff');
  // a second payment of the same customer earns again (recurring)
  await svc.recordCommission(purchase({ priceUsd: 80 }));
  dash = await svc.dashboard(boss);
  assert.strictEqual(dash.totals.earned, 50);
  assert.strictEqual(dash.totals.hold, 50);
  assert.strictEqual(dash.totals.available, 0);
  assert.strictEqual(dash.totals.signups, 1);
  assert.strictEqual(dash.canRequest, false);
  assert.strictEqual(dash.commissions[0].customer, 'f***@x.com', 'the customer is masked');
  assert.ok(dash.link.endsWith('/?aff=' + row.code));

  // the hold ends -> ready; the minimum is 20
  store.comms.forEach((c) => { c.availableAt = new Date(Date.now() - 1000); });
  dash = await svc.dashboard(boss);
  assert.strictEqual(dash.totals.available, 50);
  assert.strictEqual(dash.canRequest, true);
  cfg = { ...cfg, minPayoutUsd: 100 };
  await assert.rejects(() => svc.requestPayout(boss), /minimum payout is \$100/);
  assert.strictEqual(store.payouts.length, 0, 'a refused request leaves nothing behind');
  assert.ok(store.comms.every((c) => c.payoutId === null));
  cfg = { ...cfg, minPayoutUsd: 20 };
  const req = await svc.requestPayout(boss);
  await flush();
  assert.strictEqual(req.amountUsd, 50);
  assert.strictEqual(req.address, OK_ADDR);
  assert.ok(mails.some((m) => m.k === 'admin' && /payout request: \$50.00/.test(m.subject) && m.lines.some((l) => l.includes(OK_ADDR))), 'the admin sees network and address');
  await assert.rejects(() => svc.requestPayout(boss), /already have a payout request/);
  await assert.rejects(() => svc.updatePayoutDetails(boss, { network: 'USDT_TRC20', address: OK_ADDR }), /waiting/, 'no address change while a request waits');

  // the admin rejects: the money is ready again; asks again; pays
  await svc.processPayout(req.id, { action: 'reject', note: 'wrong network?' });
  assert.ok(store.comms.every((c) => c.payoutId === null));
  const req2 = await svc.requestPayout(boss);
  await assert.rejects(() => svc.processPayout(req2.id, { action: 'paid', txHash: '' }), /transaction hash/);
  const paid = await svc.processPayout(req2.id, { action: 'paid', txHash: '0xabc123def456', note: 'sent' });
  await flush();
  assert.strictEqual(paid.status, 'paid');
  assert.ok(store.comms.every((c) => c.status === 'paid'));
  assert.ok(mails.some((m) => m.k === 'paid' && m.txHash === '0xabc123def456' && m.amountUsd === 50));
  await assert.rejects(() => svc.processPayout(req2.id, { action: 'paid', txHash: '0xabc123def456' }), /already handled/);
  dash = await svc.dashboard(boss);
  assert.strictEqual(dash.totals.paid, 50);
  assert.strictEqual(dash.totals.available, 0);

  // a suspended affiliate earns nothing new and cannot ask for money
  await svc.decide(row.id, 'suspend');
  assert.strictEqual(await svc.recordCommission(purchase({ priceUsd: 100 })), null);
  await assert.rejects(() => svc.requestPayout(boss), /not active/);
  await svc.decide(row.id, 'reactivate');
  assert.ok(await svc.recordCommission(purchase({ priceUsd: 100 })));

  // the programme switched off: nothing is earned, nobody applies
  cfg = { ...cfg, enabled: false };
  assert.strictEqual(await svc.recordCommission(purchase({ priceUsd: 100 })), null);
  await assert.rejects(() => svc.apply(friend, { network: 'USDT_TRC20', address: OK_ADDR }), /not open/);
  cfg = { ...cfg, enabled: true };

  // a rejected applicant can apply again; the default rate is used when the affiliate has none
  const other = user('u_two', 'two@x.com');
  const app = await svc.apply(other, { network: 'USDC_SOL', address: '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV' });
  await svc.decide(app.id, 'reject', { note: 'not a fit' });
  const again = await svc.apply(other, { network: 'USDC_SOL', address: '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV' });
  assert.strictEqual(again.status, 'pending');
  const approved = await svc.decide(app.id, 'approve');
  assert.strictEqual((await svc.dashboard(other)).percent, 20);
  await assert.rejects(() => svc.decide(app.id, 'save', { percent: 95 }), /between 0 and 90/);

  console.log('affiliate tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
