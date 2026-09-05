const express = require('express');
const router = express.Router();
const { listImports, getImportById } = require('../models/importsModel');
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

module.exports = router;
