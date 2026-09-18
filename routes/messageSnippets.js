const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/requireAuth');
const { listSnippets, createSnippet, updateSnippet, deleteSnippet } = require('../models/messageSnippetsModel');

router.get('/', requireAuth, async (req, res) => {
  res.json({ success: true, snippets: await listSnippets(req.userId) });
});

router.post('/', requireAuth, async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const content = String(req.body?.content || '').trim();
  if (!name || !content) return res.status(400).json({ success: false, error: 'Snippet name and message are required.' });
  if (name.length > 80 || content.length > 4000) return res.status(400).json({ success: false, error: 'Snippet is too long.' });
  try {
    const snippet = await createSnippet(req.userId, name, content);
    res.status(201).json({ success: true, snippet });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ success: false, error: 'A snippet with that name already exists.' });
    throw err;
  }
});

router.put('/:id', requireAuth, async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const content = String(req.body?.content || '').trim();
  if (!name || !content) return res.status(400).json({ success: false, error: 'Snippet name and message are required.' });
  try {
    const snippet = await updateSnippet(req.userId, req.params.id, name, content);
    if (!snippet) return res.status(404).json({ success: false, error: 'Snippet not found.' });
    res.json({ success: true, snippet });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ success: false, error: 'A snippet with that name already exists.' });
    throw err;
  }
});

router.delete('/:id', requireAuth, async (req, res) => {
  const deleted = await deleteSnippet(req.userId, req.params.id);
  if (!deleted) return res.status(404).json({ success: false, error: 'Snippet not found.' });
  res.json({ success: true });
});

module.exports = router;
