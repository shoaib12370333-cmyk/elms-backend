const mongoose = require('mongoose');

/**
 * One background "import 100s of Amazon links" run (see routes/fetchProduct.js POST
 * /bulk-job and jobs/bulkImportProcessor.js). Unlike the small synchronous POST /bulk
 * route, this survives the browser tab closing: items are submitted to Easyparser's
 * Bulk API in one shot, then polled and saved as drafts a little at a time by the
 * background processor.
 *
 * Item lifecycle:
 *   pending  - submitted to Easyparser (or about to be), waiting on a result
 *   fetched  - Easyparser returned the product, but it could not be saved as a draft
 *              yet (currently only happens when the user is out of credits) - product
 *              is kept on the item so saving can be retried without paying Easyparser again
 *   done     - saved as a draft (draftId set)
 *   error    - Easyparser could not fetch it (or the item's own query expired/timed out)
 */
const itemSchema = new mongoose.Schema(
  {
    amazonUrl: { type: String, required: true },
    asin: { type: String, required: true },
    country: { type: String, required: true }, // ELMS country code, e.g. 'US', 'GB' - see canopyAmazonService.detectCountryFromUrl
    status: { type: String, enum: ['pending', 'fetched', 'done', 'error'], default: 'pending' },
    queryId: { type: String, default: null }, // Easyparser's result id, once submitted
    submittedAt: { type: Date, default: null },
    product: { type: mongoose.Schema.Types.Mixed, default: null }, // normalized product, once fetched
    draftId: { type: String, default: null },
    error: { type: String, default: null },
    outOfCredits: { type: Boolean, default: false }, // true = retry just re-attempts saving, no new Easyparser call
  },
  { _id: false }
);

const bulkImportJobSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    ebayAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'EbayAccount', default: null },
    markupPercent: { type: Number, default: 0 },
    status: { type: String, enum: ['queued', 'submitting', 'polling', 'done', 'cancelled'], default: 'queued', index: true },
    items: { type: [itemSchema], default: [] },
    total: { type: Number, default: 0 },
    done: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    submitAttempts: { type: Number, default: 0 }, // how many times we've tried to submit to Easyparser; gives up after a few
    lastError: { type: String, default: null },
    finishedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('BulkImportJob', bulkImportJobSchema);
