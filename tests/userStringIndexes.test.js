// users.googleId and users.username are unique among accounts that HAVE one - as PARTIAL indexes. The old "unique + sparse" field options could never
// be built on a database where two accounts store an explicit null (every email/password account does): every start logged
// `E11000 ... index: googleId_1 dup key: { googleId: null }` and the database enforced nothing. db.js migrateUserStringUniqueIndexes builds the
// right ones on an existing database without touching a single user document.
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

// ---- the schema itself (the real one) ----
const realUser = require('../models/schemas/User');
const declared = realUser.schema.indexes().map(([keys, opts]) => ({ keys, opts }));
for (const field of ['googleId', 'username']) {
  const hit = declared.find((d) => Object.keys(d.keys)[0] === field);
  assert.ok(hit, field + ' has an index declared');
  assert.strictEqual(hit.opts.unique, true);
  assert.deepStrictEqual(hit.opts.partialFilterExpression, { [field]: { $type: 'string' } }, field + ': only real strings are indexed, so stored nulls never collide');
  assert.strictEqual(hit.opts.sparse, undefined, field + ': not sparse (a sparse index still indexes an explicit null)');
  const opts = realUser.schema.path(field).options;
  assert.ok(!opts.unique && !opts.sparse && !opts.index, field + ': no unique / sparse / index on the field itself (that would declare a second, clashing index of the same name)');
  assert.strictEqual(opts.default, null, field + ': the stored null of every account is left as it is');
}
assert.strictEqual(declared.filter((d) => Object.keys(d.keys)[0] === 'googleId').length, 1);
assert.strictEqual(declared.filter((d) => Object.keys(d.keys)[0] === 'username').length, 1);
assert.ok(declared.some((d) => Object.keys(d.keys)[0] === 'email' && d.opts.unique), 'email stays unique');

// connectDB runs it, and before the extension-key migration (whose createIndexes would otherwise meet the old definitions first)
const dbSource = require('fs').readFileSync(path.join(__dirname, '..', 'db.js'), 'utf8').split('\r\n').join('\n');
const iMine = dbSource.indexOf('  await migrateUserStringUniqueIndexes();');
const iExt = dbSource.indexOf('  await migrateUserExtensionKeyIndex();');
assert.ok(iMine > 0 && iExt > iMine, 'connectDB calls migrateUserStringUniqueIndexes before migrateUserExtensionKeyIndex');

// ---- the migration, against a stand-in collection ----
let existing = []; // index descriptions the "database" has
const ops = [];
let failCreate = new Set();
let listFails = false;
const collection = {
  indexes: async () => { if (listFails) throw new Error('ns does not exist'); return existing.map((i) => ({ ...i })); },
  dropIndex: async (name) => { ops.push(['drop', name]); existing = existing.filter((i) => i.name !== name); },
  createIndex: async (keys, options) => {
    const field = Object.keys(keys)[0];
    if (failCreate.has(field)) throw new Error('Index build failed: E11000 duplicate key error collection: elms.users index: ' + options.name + ' dup key: { ' + field + ': "twice" }');
    ops.push(['create', field, options]);
    existing.push({ name: options.name, key: keys, unique: options.unique, partialFilterExpression: options.partialFilterExpression });
  },
};
stub('models/schemas/User', { collection });
const logs = []; const warns = [];
console.log = (...a) => logs.push(a.join(' ')); console.warn = (...a) => warns.push(a.join(' '));
const { _migrateUserStringUniqueIndexes: migrate } = require('../db');
const reset = () => { existing = []; ops.length = 0; failCreate = new Set(); listFails = false; logs.length = 0; warns.length = 0; };
const partial = (field) => ({ name: field + '_1', key: { [field]: 1 }, unique: true, partialFilterExpression: { [field]: { $type: 'string' } } });

(async () => {
  // a database that has neither index (production on 2026-10-03): both are created, partial and unique
  reset();
  await migrate();
  assert.deepStrictEqual(ops.map((o) => o.slice(0, 2)), [['create', 'googleId'], ['create', 'username']]);
  for (const o of ops) {
    assert.strictEqual(o[2].unique, true); assert.strictEqual(o[2].name, o[1] + '_1');
    assert.deepStrictEqual(o[2].partialFilterExpression, { [o[1]]: { $type: 'string' } });
    assert.strictEqual(o[2].sparse, undefined);
    const mongooseSide = declared.find((d) => Object.keys(d.keys)[0] === o[1]).opts;
    assert.deepStrictEqual({ unique: o[2].unique, partialFilterExpression: o[2].partialFilterExpression, background: o[2].background }, mongooseSide, o[1] + ': exactly the options Mongoose declares, so the next createIndexes() finds an identical index and has nothing to conflict with');
  }
  assert.strictEqual(warns.length, 0);
  assert.ok(logs.some((l) => /Created users index googleId_1/.test(l)) && logs.some((l) => /Created users index username_1/.test(l)));

  // run again: nothing left to do
  ops.length = 0; logs.length = 0;
  await migrate();
  assert.deepStrictEqual(ops, [], 'idempotent: an index that is already partial is left alone');

  // an old index of the same name that is not partial (a database where it was built) is replaced
  reset();
  existing = [{ name: 'googleId_1', key: { googleId: 1 }, unique: true, sparse: true }, partial('username')];
  await migrate();
  assert.deepStrictEqual(ops.map((o) => o.slice(0, 2)), [['drop', 'googleId_1'], ['create', 'googleId']], 'dropped first (the new options would clash with it), then created; the username one is untouched');

  // other indexes are not touched
  reset();
  existing = [{ name: 'email_1', key: { email: 1 }, unique: true }, { name: 'emailKey_1', key: { emailKey: 1 } }];
  await migrate();
  assert.ok(ops.every((o) => o[0] === 'create'), 'nothing is dropped that is not ours');
  assert.deepStrictEqual(existing.map((i) => i.name).sort(), ['email_1', 'emailKey_1', 'googleId_1', 'username_1'].sort());

  // one field cannot be built (a username that really exists twice): it is reported, the other one is still built, and nothing throws
  reset();
  failCreate = new Set(['username']);
  await migrate();
  assert.deepStrictEqual(ops.map((o) => o.slice(0, 2)), [['create', 'googleId']]);
  assert.strictEqual(warns.length, 1);
  assert.match(warns[0], /^Users index username_1 not built: .*dup key: \{ username: "twice" \}/, 'the log names the index and the duplicate value');
  failCreate = new Set(['googleId']);
  reset(); failCreate = new Set(['googleId']);
  await migrate();
  assert.deepStrictEqual(ops.map((o) => o.slice(0, 2)), [['create', 'username']], 'the first failing does not stop the second');

  // a collection that does not exist yet (a fresh database): treated as having no indexes
  reset(); listFails = true;
  await migrate();
  assert.strictEqual(ops.length, 2);

  // the old one cannot be dropped: reported, not thrown, and the other field goes on
  reset();
  existing = [{ name: 'googleId_1', key: { googleId: 1 }, unique: true, sparse: true }];
  const realDrop = collection.dropIndex;
  collection.dropIndex = async () => { throw new Error('not authorized'); };
  await migrate();
  collection.dropIndex = realDrop;
  assert.strictEqual(warns.length, 1); assert.match(warns[0], /^Users index googleId_1 not built: not authorized/);
  assert.deepStrictEqual(ops.map((o) => o.slice(0, 2)), [['create', 'username']]);

  process.stdout.write('user string unique index tests passed\n');
  process.exit(0);
})().catch((e) => { process.stdout.write(String(e.stack || e) + '\n'); process.exit(1); });
