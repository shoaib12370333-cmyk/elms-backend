const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/requireAuth');
const {
  listEbayAccounts,
  getAccountLimitStatus,
  setActiveEbayAccount,
  updateEbayAccountDisplayName,
} = require('../models/ebayAccountsModel');

/**
 * GET /api/ebay-accounts
 * Requires a valid session token.
 * Returns all of the current user's connected eBay accounts, plus their
 * admin-set connection limit - used by the sidebar widget and Settings page.
 */
router.get('/', requireAuth, async (req, res) => {
  const [accounts, limitStatus] = await Promise.all([
    listEbayAccounts(req.userId),
    getAccountLimitStatus(req.userId),
  ]);

  res.json({ success: true, accounts, limit: limitStatus });
});

/**
 * POST /api/ebay-accounts/:id/activate
 * Requires a valid session token.
 * Marks one of the user's eBay accounts as "active" (the sidebar's default).
 */
router.post('/:id/activate', requireAuth, async (req, res) => {
  const account = await setActiveEbayAccount(req.userId, req.params.id);
  if (!account) {
    return res.status(404).json({ success: false, error: 'That eBay account was not found.' });
  }
  res.json({ success: true, account });
});


/**
 * PUT /api/ebay-accounts/:id/display-name
 * Saves the user's private ELMS nickname for a connected eBay account.
 * This never changes the actual eBay username.
 */
router.put('/:id/display-name', requireAuth, async (req, res) => {
  const displayName = String(req.body?.displayName || '').trim();
  if (displayName.length > 60) {
    return res.status(400).json({ success: false, error: 'Account name must be 60 characters or fewer.' });
  }
  const account = await updateEbayAccountDisplayName(req.userId, req.params.id, displayName);
  if (!account) return res.status(404).json({ success: false, error: 'That eBay account was not found.' });
  res.json({ success: true, account });
});

module.exports = router;
