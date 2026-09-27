// services/imageCleanupService.js: finds Import rows no Listing still references (older than the safety margin) and
// deletes only their on-disk image folder - never the Import row itself, never a too-recent (possibly in-flight) import,
// never a still-referenced one. Real fs operations against a throwaway temp directory; only the Mongoose models are stubs.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'elms-image-cleanup-'));
process.env.LISTING_IMAGE_DIR = tmpRoot;

const stub = (specifier, exports) => { const p = require.resolve(specifier); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

const OLD = new Date(Date.now() - 48 * 60 * 60 * 1000); // 48h ago - past the default 24h safety margin
const NEW = new Date(Date.now() - 60 * 60 * 1000); // 1h ago - inside it, still possibly mid-flight

const imports = [
  { _id: 'orphanOld', userId: 'u1', createdAt: OLD }, // no listing references it, old enough: should be cleaned
  { _id: 'orphanNew', userId: 'u1', createdAt: NEW }, // no listing references it, too new: must be left alone
  { _id: 'referenced', userId: 'u1', createdAt: OLD }, // a listing still references it: must be left alone
];
stub('../models/schemas/Import', {
  find: (query) => ({
    select: () => ({
      lean: async () => imports.filter((i) => i.createdAt < query.createdAt.$lt),
    }),
  }),
});
stub('../models/schemas/Listing', {
  distinct: async () => ['referenced'],
});

const { findOrphanedImportIds, cleanupOrphanedImages } = require('../services/imageCleanupService');

function makeImportFolder(userId, importId, bytes) {
  const dir = path.join(tmpRoot, userId, importId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.jpg'), Buffer.alloc(bytes, 1));
}

(async () => {
  makeImportFolder('u1', 'orphanOld', 5000);
  makeImportFolder('u1', 'orphanNew', 3000);
  makeImportFolder('u1', 'referenced', 7000);

  // ---------- findOrphanedImportIds: only the old, unreferenced one ----------
  const orphans = await findOrphanedImportIds();
  assert.deepStrictEqual(orphans, [{ importId: 'orphanOld', userId: 'u1' }]);

  // ---------- cleanupOrphanedImages: removes exactly that folder, leaves the other two, reports what it freed ----------
  const result = await cleanupOrphanedImages();
  assert.deepStrictEqual(result, { checked: 1, foldersRemoved: 1, freedBytes: 5000 });
  assert.strictEqual(fs.existsSync(path.join(tmpRoot, 'u1', 'orphanOld')), false, 'the orphaned old folder is gone');
  assert.strictEqual(fs.existsSync(path.join(tmpRoot, 'u1', 'orphanNew')), true, 'too-new: left alone');
  assert.strictEqual(fs.existsSync(path.join(tmpRoot, 'u1', 'referenced')), true, 'still referenced by a listing: left alone');

  // ---------- a second run: the Import row is never deleted, so it is still an "orphan" by DB criteria - but its folder is
  // already gone, so nothing is (or needs to be) removed again. Idempotent, never double-counted as freed. ----------
  const again = await cleanupOrphanedImages();
  assert.deepStrictEqual(again, { checked: 1, foldersRemoved: 0, freedBytes: 0 });

  // ---------- an import whose folder was never actually written to disk (e.g. every image failed to download) is skipped cleanly ----------
  imports.push({ _id: 'orphanNoFolder', userId: 'u1', createdAt: OLD });
  const result2 = await cleanupOrphanedImages();
  assert.deepStrictEqual(result2, { checked: 2, foldersRemoved: 0, freedBytes: 0 });

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('image cleanup service tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
