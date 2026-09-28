const express = require('express');
const multer = require('multer');
const router = express.Router();
const { requireAuth } = require('../middleware/requireAuth');
const svc = require('../services/veroSettingsService');
const { MAX_WORDS } = require('../services/veroService');
const { getSuggestionWords } = require('../config/veroWords');
const { importVeroWordsFromPdfBuffer } = require('../services/veroPdfImportService');

router.use(requireAuth);

const uploadPdf = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB - a word-list PDF is text, never anywhere near this
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'application/pdf') return cb(Object.assign(new Error('Please upload a PDF file.'), { statusCode: 400 }));
    cb(null, true);
  },
});

const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (!err.statusCode) console.error('[vero-settings]', err);
    res.status(err.statusCode || 500).json({ success: false, error: err.statusCode ? err.message : 'Something went wrong.' });
  }
};

/**
 * GET /api/vero
 * The user's own VeRO words, plus a list of suggestions to offer while they type (suggestions are NOT flagged
 * unless the user saves them).
 */
router.get('/', wrap(async (req, res) => {
  res.json({ success: true, words: await svc.getVeroWordsOf(req.userId), suggestions: getSuggestionWords(), max: MAX_WORDS });
}));

/** POST /api/vero/words  { word: string }  or  { words: string[] }   (a comma or a new line separates several words) */
router.post('/words', wrap(async (req, res) => {
  const out = await svc.addWords(req.userId, req.body && req.body.words !== undefined ? req.body.words : req.body && req.body.word);
  res.json({ success: true, ...out });
}));

/** POST /api/vero/words/remove  { word } */
router.post('/words/remove', wrap(async (req, res) => {
  res.json({ success: true, words: await svc.removeWord(req.userId, req.body && req.body.word) });
}));

/** POST /api/vero/words/clear - removes every saved word. */
router.post('/words/clear', wrap(async (req, res) => {
  res.json({ success: true, words: await svc.clearWords(req.userId) });
}));

/**
 * POST /api/vero/import-pdf  (multipart/form-data, field "pdf")
 * Reads a text-based PDF and adds every usable word on it, same as pasting them into POST /words would.
 */
router.post('/import-pdf', uploadPdf.single('pdf'), wrap(async (req, res) => {
  if (!req.file) throw Object.assign(new Error('Choose a PDF file first.'), { statusCode: 400 });
  const out = await importVeroWordsFromPdfBuffer(req.userId, req.file.buffer);
  res.json({ success: true, ...out });
}));

// Multer rejects a bad upload (wrong type, too large) by calling next(err) BEFORE the handler above ever runs, which
// would otherwise fall through to Express's default HTML error page - this puts it back in the same
// { success:false, error } shape as every other error on this router.
router.use((err, req, res, next) => {
  if (!err) return next();
  const message = err.code === 'LIMIT_FILE_SIZE' ? 'That PDF is too large (max 8MB).' : (err.message || 'Could not read that file.');
  res.status(400).json({ success: false, error: message });
});

module.exports = router;
