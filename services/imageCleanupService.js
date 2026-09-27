const fs = require('fs');
const path = require('path');
const { rootDir } = require('./imageStorageService');
const Import = require('../models/schemas/Import');
const Listing = require('../models/schemas/Listing');

/**
 * Frees disk space taken by downloaded product images that nothing needs anymore. Every downloaded image lives in a folder
 * named after the IMPORT it belongs to (`rootDir()/<userId>/<importId>/...` - see services/imageStorageService.js
 * writeActual, called with `listingId: importRecord.id` from every import path: fetchProduct.js, browserImport.js,
 * cjImportService.js, aliexpressImportService.js). An Import row is never deleted (it stays as the source-of-truth product
 * data for a draft/listing via Listing.importId), so its image folder never used to get cleaned up either, even after
 * every draft/listing that ever pointed to it was deleted - that is what was filling the disk.
 */

// Never touch an import younger than this - it may still be mid-flight (a bulk import running right now, a multi-variant
// CJ/AliExpress product whose picker has not been submitted yet, an Amazon fetch that has not finished saving the draft).
const DEFAULT_MIN_AGE_MS = 24 * 60 * 60 * 1000;

function dirSizeBytes(dirPath) {
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      total += dirSizeBytes(full);
    } else {
      try { total += fs.statSync(full).size; } catch { /* file vanished mid-scan - not worth failing the whole pass over */ }
    }
  }
  return total;
}

/**
 * Every Import id no Listing still references, older than minAgeMs. The Import row itself is kept forever regardless
 * (still real product data ELMS may want again); only its own image files are what get removed, by cleanupOrphanedImages.
 */
async function findOrphanedImportIds(minAgeMs = DEFAULT_MIN_AGE_MS) {
  const cutoff = new Date(Date.now() - minAgeMs);
  const referenced = new Set((await Listing.distinct('importId', { importId: { $ne: null } })).map(String));
  const candidates = await Import.find({ createdAt: { $lt: cutoff } }).select('_id userId').lean();
  return candidates
    .filter((imp) => !referenced.has(String(imp._id)))
    .map((imp) => ({ importId: String(imp._id), userId: String(imp.userId) }));
}

/** Deletes the on-disk image folder of every orphaned import (findOrphanedImportIds) - never the Import row itself. */
async function cleanupOrphanedImages(minAgeMs = DEFAULT_MIN_AGE_MS) {
  const orphans = await findOrphanedImportIds(minAgeMs);
  let freedBytes = 0;
  let foldersRemoved = 0;
  for (const { importId, userId } of orphans) {
    const dir = path.join(rootDir(), userId, importId);
    if (!fs.existsSync(dir)) continue;
    freedBytes += dirSizeBytes(dir);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      foldersRemoved++;
    } catch (err) {
      console.warn(`[image-cleanup] could not remove ${dir}: ${err.message}`);
    }
  }
  return { checked: orphans.length, foldersRemoved, freedBytes };
}

module.exports = { findOrphanedImportIds, cleanupOrphanedImages };
