// Admin -> Users shows each user's phone number (typed at sign-up, NOT verified): the real usersModel.listAllUsers + the real enrichUsers run on
// in-memory stand-ins, and the number reaches the admin list in all three forms (E.164, country, spaced display); a user without one shows nulls.
const assert = require('assert');
const path = require('path');
process.env.JWT_SECRET = 'test-secret';
process.env.ENCRYPTION_KEY = 'test-encryption-key-test-encryption-key';
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

class Doc { constructor(o) { Object.assign(this, o); } toObject() { return { ...this }; } }
const docs = [
  new Doc({ _id: 'a1', email: 'with@x.com', username: 'with', role: 'user', creditBalance: 3, createdAt: new Date('2026-10-02'), phone: '+923001234567', phoneCountry: 'PK', phoneDisplay: '+92 300 1234567' }),
  new Doc({ _id: 'a2', email: 'without@x.com', username: 'without', role: 'user', creditBalance: 0, createdAt: new Date('2026-10-01'), phoneRequired: true }),
  new Doc({ _id: 'a3', email: 'old@x.com', username: 'old', role: 'user', creditBalance: 0, createdAt: new Date('2026-09-01') }),
];
stub('models/schemas/User.js', { find: () => ({ sort: async () => docs }) });
const none = { aggregate: async () => [] };
stub('models/schemas/Session.js', none);
stub('models/schemas/Purchase.js', none);
stub('models/schemas/LoginEvent.js', none);
stub('models/schemas/EbayAccount.js', none);

const { listAllUsers } = require('../models/usersModel');
const { enrichUsers } = require('../services/adminUserStatsService');

(async () => {
  const { users } = await enrichUsers(await listAllUsers());
  const by = Object.fromEntries(users.map((u) => [u.email, u]));
  assert.deepStrictEqual([by['with@x.com'].phone, by['with@x.com'].phoneCountry, by['with@x.com'].phoneDisplay], ['+923001234567', 'PK', '+92 300 1234567']);
  assert.deepStrictEqual([by['with@x.com'].needsPhone, by['with@x.com'].phoneRequired], [false, false]);
  // no number: nulls, and the admin can tell "must add" (Google sign-up) from "old account, may skip"
  assert.deepStrictEqual([by['without@x.com'].phone, by['without@x.com'].phoneCountry, by['without@x.com'].phoneDisplay, by['without@x.com'].needsPhone, by['without@x.com'].phoneRequired], [null, null, null, true, true]);
  assert.deepStrictEqual([by['old@x.com'].phone, by['old@x.com'].needsPhone, by['old@x.com'].phoneRequired], [null, true, false]);
  // the rest of the admin row is untouched
  assert.ok(by['with@x.com'].plan && 'online' in by['with@x.com'] && by['with@x.com'].ebay);
  console.log('admin user phone tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
