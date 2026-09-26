const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/requireAuth');
const User = require('../models/schemas/User');
const { getLimits } = require('../models/settingsModel');
const { listNetProfitLines, countNetProfitLines, getNetProfitLine, setNetProfit, setBuyPrice } = require('../models/ordersModel');
const { PAGE_SIZE, isPaidUser, paging, csvHeader, csvLine, csvTotals } = require('../services/netProfitService');

/** What the request asks for: the filters of the sheet (store, dates, search, cancelled orders). */
function filtersOf(query) {
  const date = (v) => { if (!v) return null; const d = new Date(String(v)); return Number.isNaN(d.getTime()) ? null : d; };
  return {
    accountId: /^[a-f0-9]{24}$/i.test(String(query.accountId || '')) ? String(query.accountId) : null,
    from: date(query.from),
    to: date(query.to),
    q: String(query.q || '').trim().slice(0, 100),
    includeCancelled: query.includeCancelled === '1' || query.includeCancelled === 'true',
  };
}

async function accessOf(userId) {
  const [user, limits] = await Promise.all([User.findById(userId).select('role planName planExpiresAt').lean(), getLimits()]);
  return { paid: isPaidUser(user), freeLines: limits.netProfitFreeLines };
}

/**
 * GET /api/net-profit?offset=0&limit=1000&q=&accountId=&from=&to=&includeCancelled=1
 * The lines of the sheet, newest first, 1000 at a time. A free account reaches at most `freeLines` lines (`locked` says it is at its
 * limit with more orders behind it); an account with a running plan reaches all of them (`hasMore` says "Add lines" can add more).
 */
router.get('/', requireAuth, async (req, res) => {
  try {
    const filters = filtersOf(req.query);
    const access = await accessOf(req.userId);
    const total = await countNetProfitLines(req.userId, filters);
    const page = paging({ ...access, offset: req.query.offset, limit: req.query.limit, total });
    const lines = page.take > 0 ? await listNetProfitLines(req.userId, filters, { offset: page.offset, limit: page.take }) : [];
    res.json({ success: true, lines, total, offset: page.offset, hasMore: page.hasMore, locked: page.locked, paid: access.paid, freeLines: access.freeLines, pageSize: PAGE_SIZE });
  } catch (err) {
    console.error('net profit list error:', err.message);
    res.status(500).json({ success: false, error: 'Could not load the sheet. Please try again.' });
  }
});

/**
 * GET /api/net-profit/export?...same filters
 * The sheet as a CSV file for Excel: every column of the sheet plus currency, quantity, date, store, item number and ASIN, and the
 * total rows at the end. Free: the lines a free account can reach; with a running plan: every line the filters give.
 */
router.get('/export', requireAuth, async (req, res) => {
  try {
    const filters = filtersOf(req.query);
    const access = await accessOf(req.userId);
    const total = await countNetProfitLines(req.userId, filters);
    const cap = access.paid ? total : Math.min(total, access.freeLines);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="net-profit-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.write(csvHeader());
    const all = [];
    for (let offset = 0; offset < cap; offset += PAGE_SIZE) {
      const lines = await listNetProfitLines(req.userId, filters, { offset, limit: Math.min(PAGE_SIZE, cap - offset) });
      if (!lines.length) break;
      for (const l of lines) { res.write(csvLine(l)); all.push({ currency: l.currency, amazon_price: l.amazon_price, ebay_price: l.ebay_price, profit: l.profit, ebay_cost: l.ebay_cost, net_profit: l.net_profit }); }
    }
    res.write(csvTotals(all));
    res.end();
  } catch (err) {
    console.error('net profit export error:', err.message);
    if (!res.headersSent) res.status(500).json({ success: false, error: 'Could not make the file. Please try again.' });
    else res.end();
  }
});

const isNumberOrEmpty = (v) => v === null || v === '' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)));

/**
 * PATCH /api/net-profit/:id   { amazonPrice?: number | null, netProfit?: number | null }
 * The two cells a seller types. AMAZON PRICE is the same cost figure the Orders page uses (per piece; empty = back to the listing's
 * price); NET PROFIT is kept with the order (empty clears it). Answers with the line as the sheet now shows it.
 */
router.patch('/:id', requireAuth, async (req, res) => {
  const id = String(req.params.id || '');
  if (!/^[a-f0-9]{24}$/i.test(id)) return res.status(404).json({ success: false, error: 'Order not found.' });
  const body = req.body || {};
  if (body.amazonPrice === undefined && body.netProfit === undefined) return res.status(400).json({ success: false, error: 'Nothing to save.' });
  if (body.amazonPrice !== undefined && !isNumberOrEmpty(body.amazonPrice)) return res.status(400).json({ success: false, error: 'Enter the Amazon price as a number.' });
  if (body.netProfit !== undefined && !isNumberOrEmpty(body.netProfit)) return res.status(400).json({ success: false, error: 'Enter the net profit as a number.' });
  try {
    if (body.amazonPrice !== undefined) {
      try { await setBuyPrice(req.userId, id, body.amazonPrice === '' ? null : body.amazonPrice); } catch (err) { return res.status(400).json({ success: false, error: err.message }); }
    }
    if (body.netProfit !== undefined) {
      const n = body.netProfit === null || body.netProfit === '' ? null : Number(body.netProfit);
      if (n !== null && Math.abs(n) > 1e9) return res.status(400).json({ success: false, error: 'That net profit is too large.' });
      await setNetProfit(req.userId, id, n);
    }
    const line = await getNetProfitLine(req.userId, id);
    if (!line) return res.status(404).json({ success: false, error: 'Order not found.' });
    res.json({ success: true, line });
  } catch (err) {
    console.error('net profit save error:', err.message);
    res.status(500).json({ success: false, error: 'Could not save. Please try again.' });
  }
});

module.exports = router;
