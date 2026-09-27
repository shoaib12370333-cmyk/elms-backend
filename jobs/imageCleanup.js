const cron = require('node-cron');
const { cleanupOrphanedImages } = require('../services/imageCleanupService');

/** Once a day (off-peak relative to the midnight stock monitor) - frees disk space from orphaned import image folders. */
function startImageCleanup() {
  cron.schedule('0 3 * * *', async () => {
    try {
      const result = await cleanupOrphanedImages();
      if (result.foldersRemoved) {
        console.log(`[image-cleanup] removed ${result.foldersRemoved} orphaned import folder(s) of ${result.checked} checked, freed ${(result.freedBytes / (1024 * 1024)).toFixed(1)} MB.`);
      }
    } catch (err) {
      console.error('[image-cleanup] failed:', err.message);
    }
  });
}

module.exports = { startImageCleanup };
