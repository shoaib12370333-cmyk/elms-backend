/**
 * The Net Profit sheet: one line per order, with the money worked out in whole cents (never in floating point), so 0.1 + 0.2 style
 * mistakes cannot creep into a profit.
 *
 *   AMAZON PRICE   what the order cost on Amazon                                  typed by the seller, EMPTY until they type it
 *   EBAY PRICE     what the order was sold for (the item price of the order line)  from the order
 *   PROFIT         EBAY PRICE - AMAZON PRICE                                        worked out
 *   ORDER EARNING  what eBay pays out for the order ("Order earnings" in Seller Hub)  typed by the seller
 *   EBAY COST      EBAY PRICE - ORDER EARNING (what eBay kept: fees ...)             worked out
 *   NET PROFIT     ORDER EARNING - AMAZON PRICE                                     worked out
 *
 * Every money column is for the whole order line (an order of 2 pieces has one price, one earning, one Amazon price). What cannot be
 * worked out yet (a figure is not typed) is empty, never 0. A net profit typed in the first version of the sheet is kept and shown
 * until both figures are typed.
 *
 * Free accounts see a limited number of lines (an admin sets it); an account with a running plan sees them all, 1000 at a time.
 */
const PAGE_SIZE = 1000;

/** Money as whole cents (null when there is no number). Rounds half away from zero, like a person would. */
function cents(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.sign(n) * Math.round(Math.abs(n) * 100 + 1e-7);
}
const money = (c) => (c === null || c === undefined ? null : c / 100);

/**
 * The net profit of an order, in money (null when there is none): ORDER EARNING - AMAZON PRICE when both are typed, else the net profit an
 * older version of the sheet had the seller type (null when there is none either).
 */
function resolveNetProfit(orderEarning, sheetAmazonPrice, typedNetProfit) {
  const e = cents(orderEarning);
  const a = cents(sheetAmazonPrice);
  return money(e !== null && a !== null ? e - a : cents(typedNetProfit));
}

/** A plan that is running: bought and not ended (a plan without an end date, like a credit pack, counts), or an admin. */
function isPaidUser(user, now = new Date()) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (!user.planName) return false;
  return !user.planExpiresAt || new Date(user.planExpiresAt) > now;
}

/**
 * One line of the sheet from a serialized order (models/ordersModel serialize + enrichOrder). Every price is for the whole order line;
 * `quantity` only says how many pieces the order had.
 */
function buildLine(order) {
  const quantity = Math.max(1, Math.trunc(Number(order.quantity) || 1));
  const ebay = cents(order.sale_price); // eBay gives the price of the whole line
  const amazon = cents(order.sheet_amazon_price); // only what the seller typed: never filled from a listing
  const earning = cents(order.order_earning);
  const older = cents(order.net_profit_typed);
  const worked = earning !== null && amazon !== null;
  const net = worked ? earning - amazon : older;
  const profit = ebay !== null && amazon !== null ? ebay - amazon : null;
  const cost = ebay !== null && earning !== null ? ebay - earning : null;
  return {
    id: order.id,
    title: order.listing_title || order.item_title || order.sku || '',
    ebay_order_id: order.ebay_order_id || '',
    ebay_item_id: order.legacy_item_id || '',
    asin: order.asin || '',
    amazon_url: order.amazon_url || null,
    marketplace_id: order.marketplace_id || null,
    currency: order.currency ? String(order.currency).toUpperCase() : null,
    quantity,
    store: order.ebay_account_label || order.ebay_account_username || '',
    date: order.ebay_created_at || order.created_at || null,
    status: order.order_status || null,
    amazon_price: money(amazon),
    ebay_price: money(ebay),
    profit: money(profit),
    order_earning: money(earning),
    ebay_cost: money(cost),
    net_profit: money(net),
    net_profit_older: !worked && older !== null, // shown from an older version of the sheet, until the two typed figures are there
  };
}

/** The total row: per currency (a euro and a dollar are never added together), each column adds only the cells that have a number. */
function totalsOf(lines) {
  const byCurrency = new Map();
  for (const l of lines) {
    const key = l.currency || '';
    if (!byCurrency.has(key)) byCurrency.set(key, { currency: l.currency || null, lines: 0, sums: { amazon_price: null, ebay_price: null, profit: null, order_earning: null, ebay_cost: null, net_profit: null } });
    const t = byCurrency.get(key);
    t.lines += 1;
    for (const col of Object.keys(t.sums)) {
      const c = cents(l[col]);
      if (c !== null) t.sums[col] = (t.sums[col] || 0) + c;
    }
  }
  return [...byCurrency.values()].map((t) => ({ currency: t.currency, lines: t.lines, amazon_price: money(t.sums.amazon_price), ebay_price: money(t.sums.ebay_price), profit: money(t.sums.profit), order_earning: money(t.sums.order_earning), ebay_cost: money(t.sums.ebay_cost), net_profit: money(t.sums.net_profit) }));
}

/**
 * Which lines a request may have. Free: up to `freeLines` in all (a request may load them in steps). Paid: all.
 * `take` = how many to read now, `hasMore` = "Add lines" can add more, `locked` = a free account is at its limit and there are more lines.
 */
function paging({ paid, freeLines, offset, limit, total }) {
  const off = Math.max(0, Math.trunc(Number(offset)) || 0);
  const lim = Math.min(PAGE_SIZE, Math.max(1, Math.trunc(Number(limit)) || PAGE_SIZE));
  const count = Math.max(0, Math.trunc(Number(total)) || 0);
  const cap = paid ? Infinity : Math.max(1, Math.trunc(Number(freeLines)) || 1);
  const reachable = Math.min(count, cap);
  const take = Math.max(0, Math.min(lim, reachable - off));
  const end = off + take;
  return { offset: off, take, hasMore: end < reachable, locked: !paid && count > cap && end >= cap, reachable };
}

// ---------------------------------------------------------------- CSV
const CSV_HEADER = ['Title', 'Order ID', 'Amazon price', 'eBay price', 'Profit', 'Order earning', 'eBay cost', 'Net profit', 'Currency', 'Quantity', 'Order date', 'Store', 'eBay item number', 'Amazon ASIN'];
const quoted = (s) => '"' + String(s).replace(/"/g, '""') + '"';
/** Text: quoted, and a text that would be read as a formula by Excel gets a ' in front. */
const csvText = (s) => quoted(/^[=+\-@\t\r]/.test(String(s == null ? '' : s)) ? "'" + s : (s == null ? '' : s));
/** Long numbers (an eBay item number has 12 digits) would turn into 1.1E+11 in Excel: they are written as text. */
const csvDigits = (s) => (s ? quoted('="' + String(s).replace(/"/g, '') + '"') : '""');
const csvNumber = (n) => (n === null || n === undefined ? '' : (Math.round(n * 100) / 100).toFixed(2));
const csvDate = (d) => { const t = d ? new Date(d) : null; return t && !Number.isNaN(t.getTime()) ? t.toISOString().slice(0, 10) : ''; };

const csvHeader = () => '﻿' + CSV_HEADER.map(quoted).join(',') + '\r\n';
function csvLine(l) {
  return [csvText(l.title), csvText(l.ebay_order_id), csvNumber(l.amazon_price), csvNumber(l.ebay_price), csvNumber(l.profit), csvNumber(l.order_earning), csvNumber(l.ebay_cost), csvNumber(l.net_profit),
    csvText(l.currency || ''), String(l.quantity), csvDate(l.date), csvText(l.store), csvDigits(l.ebay_item_id), csvText(l.asin)].join(',') + '\r\n';
}
/** The total rows at the end of the file (one per currency), the same numbers the sheet shows. */
function csvTotals(lines) {
  return totalsOf(lines).map((t) => [csvText('TOTAL (' + t.lines + ' line' + (t.lines === 1 ? '' : 's') + ')'), '""', csvNumber(t.amazon_price), csvNumber(t.ebay_price), csvNumber(t.profit), csvNumber(t.order_earning), csvNumber(t.ebay_cost), csvNumber(t.net_profit),
    csvText(t.currency || ''), '', '', '""', '""', '""'].join(',') + '\r\n').join('');
}

module.exports = { PAGE_SIZE, cents, money, isPaidUser, resolveNetProfit, buildLine, totalsOf, paging, csvHeader, csvLine, csvTotals };
