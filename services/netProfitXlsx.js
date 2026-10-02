const ExcelJS = require('exceljs');

/**
 * The Net Profit sheet's export as a real .xlsx (not CSV): CSV cannot carry a bold header or a coloured cell, and eBay's daily
 * calls to build it can be large for a paid account, so this streams straight to the response instead of holding the whole
 * sheet in memory (the same way the CSV version paged through listNetProfitLines PAGE_SIZE at a time).
 */

// The symbol shown for a currency, everywhere a money figure is - never the plain 3-letter code the old CSV wrote.
const CURRENCY_SYMBOLS = {
  USD: '$', GBP: '£', EUR: '€', CAD: 'C$', AUD: 'A$',
  JPY: '¥', INR: '₹', MXN: 'MX$', BRL: 'R$', CHF: 'CHF',
  SEK: 'kr', SGD: 'S$', AED: 'د.إ', SAR: '﷼', CNY: '¥',
  TRY: '₺', PLN: 'zł', NOK: 'kr', HKD: 'HK$', NZD: 'NZ$', MYR: 'RM', PHP: '₱', TWD: 'NT$',
};
const currencySymbol = (code) => { const up = String(code || '').toUpperCase(); return CURRENCY_SYMBOLS[up] || up; };

// No separate "Currency" column - every money cell already shows its own sign via moneyFormat below, so a text column
// repeating "GBP"/"USD" next to it would just say the same thing twice.
const SHEET_HEADER = ['Title', 'Order ID', 'Buying price', 'eBay price', 'Profit', 'Order earning', 'eBay cost', 'Ad fee', 'Net profit', 'Quantity', 'Order date', 'Store', 'eBay item number', 'Amazon ASIN'];
const COLUMN_WIDTHS = [40, 16, 13, 12, 12, 14, 12, 10, 12, 10, 12, 18, 16, 14];
const HEADER_FILL = 'FF0064D2'; // ELMS' own blue (the primary button colour used across the app)
const GOOD = 'FF15803D'; const BAD = 'FFDC2626'; // the same green/red the app already uses for a positive/negative profit
const MONEY_COLS = [3, 4, 5, 6, 7, 8, 9]; // 1-based: Buying price, eBay price, Profit, Order earning, eBay cost, Ad fee, Net profit
const NET_PROFIT_COL = 9;
const ITEM_NUMBER_COL = 13; // kept as text - an eBay item number (12 digits) turns into 1.1E+11 as a real number

/** The money format for one row's own currency: its symbol, 2 decimals, red for a loss - a pound's cells are never formatted like a dollar's. */
function moneyFormat(currency) {
  const sym = currencySymbol(currency).replace(/"/g, '');
  return `"${sym}"#,##0.00;[Red]-"${sym}"#,##0.00`;
}
const isoDate = (d) => { const t = d ? new Date(d) : null; return t && !Number.isNaN(t.getTime()) ? t.toISOString().slice(0, 10) : ''; };

/**
 * Opens a new Net Profit workbook writing straight to `stream`. Returns { addLine, addTotal, finish }:
 *   addLine(l)   one line of the sheet (models/ordersModel serialize -> netProfitService.buildLine's shape)
 *   addTotal(t)  one currency's total row (netProfitService.totalsOf's shape) - shown bold, as "TOTAL (N lines)"
 *   finish()     closes the sheet and the workbook; must be awaited before the response ends
 */
function openNetProfitWorkbook(stream) {
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream, useStyles: true });
  const sheet = workbook.addWorksheet('Net Profit', { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = COLUMN_WIDTHS.map((width) => ({ width }));

  const header = sheet.addRow(SHEET_HEADER);
  header.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
  });
  header.commit();

  function addRow(l, totalLabel) {
    const row = sheet.addRow([
      totalLabel || l.title || '',
      totalLabel ? '' : (l.ebay_order_id || ''),
      l.amazon_price, l.ebay_price, l.profit, l.order_earning, l.ebay_cost, l.ad_fee, l.net_profit,
      totalLabel ? '' : l.quantity,
      totalLabel ? '' : isoDate(l.date),
      totalLabel ? '' : (l.store || ''),
      totalLabel ? '' : (l.ebay_item_id || ''),
      totalLabel ? '' : (l.asin || ''),
    ]);
    const fmt = moneyFormat(l.currency);
    MONEY_COLS.forEach((col) => { row.getCell(col).numFmt = fmt; });
    row.getCell(ITEM_NUMBER_COL).numFmt = '@';
    if (l.net_profit != null) row.getCell(NET_PROFIT_COL).font = { bold: !!totalLabel, color: { argb: l.net_profit >= 0 ? GOOD : BAD } };
    if (totalLabel) row.eachCell((cell) => { cell.font = { ...(cell.font || {}), bold: true }; });
    row.commit();
  }

  return {
    addLine: (l) => addRow(l),
    addTotal: (t) => addRow(t, `TOTAL (${t.lines} line${t.lines === 1 ? '' : 's'})`),
    async finish() { await sheet.commit(); await workbook.commit(); },
  };
}

module.exports = { openNetProfitWorkbook, currencySymbol, CURRENCY_SYMBOLS };
