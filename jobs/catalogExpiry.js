const cron = require('node-cron');
const { deleteExpiredCatalogItems } = require('../models/productCatalogModel');

/** Once a day - removes Admin Panel > Product Catalog rows past their expiresAt (Settings > Limits, catalogRetentionDays), whether or not they were ever pushed to a seller's Drafts (a push only copies the fields into that seller's own Listing document, it never keeps a live link back to this row). */
function startCatalogExpiry() {
  cron.schedule('30 3 * * *', async () => {
    try {
      const removed = await deleteExpiredCatalogItems();
      if (removed) console.log(`[catalog-expiry] removed ${removed} expired product catalog row(s).`);
    } catch (err) {
      console.error('[catalog-expiry] failed:', err.message);
    }
  });
}

module.exports = { startCatalogExpiry };
