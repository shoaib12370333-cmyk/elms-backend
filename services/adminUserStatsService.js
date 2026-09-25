const Session = require('../models/schemas/Session');
const Purchase = require('../models/schemas/Purchase');
const LoginEvent = require('../models/schemas/LoginEvent');
const EbayAccount = require('../models/schemas/EbayAccount');

// The site pings every minute while it is open, so a user is "online" if the last ping is younger than this.
const ONLINE_WINDOW_MS = 150 * 1000;

const place = (e) => [e.city, e.country].filter(Boolean).join(', ') || null;

/**
 * Adds to each user what the admin wants to see at a glance: online now / minutes since they left,
 * whether they bought a plan (paid) or use the free plan, the IP + place of their last sign-in, and whether they have
 * connected an eBay store (and how many).
 * @param {Array<{id: string}>} users serialised users
 * @returns {Promise<{ users: Array, summary: { total, online, paid, free, suspended, ebayConnected, ebayNotConnected } }>}
 */
async function enrichUsers(users) {
  const [seen, bought, logins, stores] = await Promise.all([
    Session.aggregate([{ $group: { _id: '$userId', lastSeenAt: { $max: '$lastSeenAt' } } }]),
    Purchase.aggregate([
      { $match: { status: 'completed' } },
      { $group: { _id: '$userId', totalUsd: { $sum: '$priceUsd' }, purchases: { $sum: 1 }, credits: { $sum: '$creditsGranted' }, lastAt: { $max: '$createdAt' } } },
    ]),
    LoginEvent.aggregate([
      { $match: { success: true } },
      { $sort: { createdAt: -1 } },
      { $group: { _id: '$userId', ip: { $first: '$ip' }, city: { $first: '$city' }, country: { $first: '$country' }, at: { $first: '$createdAt' } } },
    ]),
    EbayAccount.aggregate([{ $group: { _id: '$userId', stores: { $sum: 1 }, marketplaces: { $addToSet: '$marketplaceId' } } }]),
  ]);
  const seenBy = new Map(seen.map((r) => [String(r._id), r]));
  const boughtBy = new Map(bought.map((r) => [String(r._id), r]));
  const loginBy = new Map(logins.map((r) => [String(r._id), r]));
  const storesBy = new Map(stores.map((r) => [String(r._id), r]));

  const now = Date.now();
  const summary = { total: users.length, online: 0, paid: 0, free: 0, suspended: 0, ebayConnected: 0, ebayNotConnected: 0 };
  const out = users.map((u) => {
    const s = seenBy.get(String(u.id));
    const l = loginBy.get(String(u.id));
    const b = boughtBy.get(String(u.id));
    const e = storesBy.get(String(u.id));
    const lastSeen = Math.max(s && s.lastSeenAt ? new Date(s.lastSeenAt).getTime() : 0, l && l.at ? new Date(l.at).getTime() : 0) || null;
    const online = !!lastSeen && now - lastSeen <= ONLINE_WINDOW_MS;
    const paid = !!b;
    if (online) summary.online += 1;
    if (paid) summary.paid += 1; else summary.free += 1;
    if (u.suspendedAt) summary.suspended += 1;
    if (e) summary.ebayConnected += 1; else summary.ebayNotConnected += 1;
    return {
      ...u,
      online,
      lastSeenAt: lastSeen ? new Date(lastSeen).toISOString() : null,
      minutesAgo: lastSeen ? Math.max(0, Math.round((now - lastSeen) / 60000)) : null,
      plan: paid
        ? { paid: true, totalUsd: Number((b.totalUsd || 0).toFixed(2)), purchases: b.purchases, credits: b.credits, lastPurchaseAt: b.lastAt }
        : { paid: false },
      lastLogin: l ? { ip: l.ip || null, place: place(l), at: l.at } : null,
      suspended: !!u.suspendedAt,
      ebay: { connected: !!e, stores: e ? e.stores : 0, marketplaces: e ? (e.marketplaces || []).filter(Boolean) : [] },
    };
  });
  return { users: out, summary };
}

module.exports = { enrichUsers, ONLINE_WINDOW_MS };
