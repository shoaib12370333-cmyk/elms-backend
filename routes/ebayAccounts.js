const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/requireAuth');
const {
  listEbayAccounts,
  getAccountLimitStatus,
  setActiveEbayAccount,
  updateEbayAccountDisplayName,
  getEbayAccountById,
} = require('../models/ebayAccountsModel');
const { refreshStaleIdentities, refreshAccountIdentity } = require('../services/accountIdentityService');

/**
 * GET /api/ebay-accounts
 * Requires a valid session token.
 * Returns all of the current user's connected eBay accounts, plus their
 * admin-set connection limit - used by the sidebar widget and Settings page.
 */
router.get('/', requireAuth, async (req, res) => {
  let [accounts, limitStatus] = await Promise.all([
    listEbayAccounts(req.userId),
    getAccountLimitStatus(req.userId),
  ]);

  // Accounts whose name eBay has not been asked for yet (or that were saved under a stand-in name) are looked up now, once,
  // and remembered; the page does not wait longer than a few seconds for eBay.
  try {
    const looked = await refreshStaleIdentities(req.userId, accounts);
    if (looked.length) accounts = await listEbayAccounts(req.userId);
  } catch (err) {
    console.warn('[ebay-accounts] name lookup failed:', err.message);
  }

  res.json({ success: true, accounts, limit: limitStatus });
});

/**
 * POST /api/ebay-accounts/:id/refresh-name
 * Asks eBay again who this account is (eBay username and eBay Store name) and remembers the answer.
 */
router.post('/:id/refresh-name', requireAuth, async (req, res) => {
  const existing = await getEbayAccountById(req.userId, req.params.id);
  if (!existing) return res.status(404).json({ success: false, error: 'That eBay account was not found.' });
  await refreshAccountIdentity(req.userId, req.params.id);
  const account = await getEbayAccountById(req.userId, req.params.id);
  res.json({ success: true, account });
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
