// Super admin: always an admin, the only one who gives or takes the admin panel, and cannot be removed.
const assert = require('assert');
const path = require('path');
const abs = (rel) => require.resolve(path.join('..', rel));
const stub = (rel, exports) => { const p = abs(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
const fakeRes = () => { const r = { statusCode: 200 }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
const handler = (router, method, p) => { const l = router.stack.find((x) => x.route && x.route.path === p && x.route.methods[method]); assert.ok(l, method + ' ' + p); return l.route.stack[l.route.stack.length - 1].handle; };

const OWNER = 'shoaib12370333@gmail.com';
const ID = (n) => String(n).padStart(24, 'a');
const db = [
  { _id: ID(1), email: OWNER, name: 'Owner', role: 'user' }, // stored role is wrong on purpose
  { _id: ID(2), email: 'helper@x.com', name: 'Helper', role: 'admin' },
  { _id: ID(3), email: 'kim@x.com', name: 'Kim', role: 'user' },
];
const chain = (v) => ({ lean: async () => v });
const UserModel = {
  find: () => chain(db.filter((u) => u.role === 'admin' || u.email === OWNER)),
  findById: (id) => chain(db.find((u) => u._id === id) || null),
  findOneAndUpdate: (q, u) => { const x = db.find((d) => d.email === q.email); if (x) Object.assign(x, u.$set); return chain(x || null); },
  updateOne: async (q, u) => { const x = db.find((d) => d._id === q._id); if (x) Object.assign(x, u.$set); },
};

(async () => {
  delete process.env.SUPER_ADMIN_EMAIL;
  const { isSuperAdminEmail, superAdminEmail } = require('../services/superAdmin');
  assert.strictEqual(superAdminEmail(), OWNER);
  assert.ok(isSuperAdminEmail('  Shoaib12370333@Gmail.com '));
  assert.ok(!isSuperAdminEmail('helper@x.com') && !isSuperAdminEmail(''));

  // the user record: the super admin is an admin and flagged, whatever the stored role
  stub('models/schemas/User', Object.assign(function () {}, { findById: async (id) => { const u = db.find((d) => d._id === id); return u ? { toObject: () => ({ ...u, _id: { toString: () => u._id } }) } : null; } }));
  const { getUserById } = require('../models/usersModel');
  const owner = await getUserById(ID(1));
  assert.strictEqual(owner.role, 'admin');
  assert.strictEqual(owner.isSuperAdmin, true);
  const helper = await getUserById(ID(2));
  assert.strictEqual(helper.role, 'admin');
  assert.strictEqual(helper.isSuperAdmin, false);
  assert.strictEqual((await getUserById(ID(3))).role, 'user');

  // the middleware: an ordinary admin is refused
  const { requireSuperAdmin, requireAdmin } = require('../middleware/requireAdmin');
  const pass = async (mw, userId) => { let next = false; const res = fakeRes(); await mw({ userId }, res, () => { next = true; }); return { next, status: res.statusCode }; };
  assert.deepStrictEqual(await pass(requireSuperAdmin, ID(1)), { next: true, status: 200 });
  assert.deepStrictEqual(await pass(requireSuperAdmin, ID(2)), { next: false, status: 403 });
  assert.deepStrictEqual(await pass(requireAdmin, ID(2)), { next: true, status: 200 });
  assert.deepStrictEqual(await pass(requireAdmin, ID(3)), { next: false, status: 403 });

  // the routes (the middleware is checked above)
  stub('middleware/requireAuth', { requireAuth: (req, res, next) => next() });
  stub('middleware/requireAdmin', { requireAdmin: (q, s, n) => n(), requireSuperAdmin: (q, s, n) => n() });
  stub('models/schemas/User', UserModel);
  const router = require('../routes/admin');

  let res = fakeRes(); await handler(router, 'get', '/admins')({}, res);
  assert.deepStrictEqual(res.body.admins.map((a) => [a.email, a.isSuperAdmin]), [[OWNER, true], ['helper@x.com', false]]);

  res = fakeRes(); await handler(router, 'post', '/admins')({ body: { email: 'nope' } }, res);
  assert.strictEqual(res.statusCode, 400);
  res = fakeRes(); await handler(router, 'post', '/admins')({ body: { email: 'ghost@x.com' } }, res);
  assert.strictEqual(res.statusCode, 404);
  res = fakeRes(); await handler(router, 'post', '/admins')({ body: { email: ' Kim@X.com ' } }, res);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(db[2].role, 'admin');

  res = fakeRes(); await handler(router, 'delete', '/admins/:id')({ params: { id: ID(1) } }, res);
  assert.strictEqual(res.statusCode, 403, 'the super admin cannot be removed');
  db[0].role = 'admin';
  res = fakeRes(); await handler(router, 'delete', '/admins/:id')({ params: { id: ID(1) } }, res);
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(db[0].role, 'admin');
  res = fakeRes(); await handler(router, 'delete', '/admins/:id')({ params: { id: ID(2) } }, res);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(db[1].role, 'user');
  res = fakeRes(); await handler(router, 'delete', '/admins/:id')({ params: { id: ID(2) } }, res);
  assert.strictEqual(res.statusCode, 404, 'already not an admin');
  res = fakeRes(); await handler(router, 'delete', '/admins/:id')({ params: { id: 'zz' } }, res);
  assert.strictEqual(res.statusCode, 404);

  console.log('superAdmin tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
