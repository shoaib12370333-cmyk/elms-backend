const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/requireAuth');
const svc = require('../services/veroSettingsService');
const { MAX_WORDS } = require('../services/veroService');
const { getSuggestionWords } = require('../config/veroWords');

router.use(requireAuth);

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

module.exports = router;
