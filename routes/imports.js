const express = require('express');
const router = express.Router();
const { listImports, getImportById, updateImportImages } = require('../models/importsModel');
const { requireAuth } = require('../middleware/requireAuth');

/**
 * GET /api/imports
 * Requires a valid session token.
 * Returns the current user's recent history of Amazon products fetched.
 */
router.get('/', requireAuth, async (req, res) => {
  const imports = await listImports(req.userId);
  res.json({ success: true, imports });
});

/**
 * GET /api/imports/:id
 * Requires a valid session token. Only returns the import if it belongs
 * to the current user.
 */
router.get('/:id', requireAuth, async (req, res) => {
  const importRecord = await getImportById(req.userId, req.params.id);
  if (!importRecord) {
    return res.status(404).json({ success: false, error: 'Import not found.' });
  }
  res.json({ success: true, import: importRecord });
});


/**
 * PUT /api/imports/:id/images
 * Updates the saved product gallery for the current user's import.
 * Images are source URLs only; the server never trusts arbitrary file paths.
 */
router.put('/:id/images', requireAuth, async (req, res) => {
  try {
    const images = Array.isArray(req.body?.images) ? req.body.images : [];
    if (images.length > 50) {
      return res.status(400).json({ success: false, error: 'A product can have at most 50 images.' });
    }
    const updated = await updateImportImages(req.userId, req.params.id, images);
    if (!updated) {
      return res.status(404).json({ success: false, error: 'Import not found.' });
    }
    res.json({ success: true, import: updated });
  } catch (err) {
    console.error('update import images error:', err.message);
    res.status(400).json({ success: false, error: err.message || 'Could not update product images.' });
  }
});

module.exports = router;
