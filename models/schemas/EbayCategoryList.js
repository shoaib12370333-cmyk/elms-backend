const mongoose = require('mongoose');

// The eBay categories of ONE marketplace, from the "Category IDs" CSV the admin uploads (Admin Panel -> Categories).
// The rows are kept as one gzipped text (about a fifth of the CSV's size), so replacing a list is a single write:
// a list is never half there while it is being replaced. See services/categoryListService.js.
const ebayCategoryListSchema = new mongoose.Schema(
  {
    marketplaceId: { type: String, required: true, unique: true, trim: true },
    data: { type: Buffer, required: true },
    count: { type: Number, required: true },
    filename: { type: String, default: '' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('EbayCategoryList', ebayCategoryListSchema);
