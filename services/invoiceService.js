/**
 * Invoices for credit purchases. One invoice per paid purchase: a number that never changes, what was bought, the discount
 * only when there was one, how it was paid, the total. No tax lines and no addresses.
 * A plan given free by a voucher is not a purchase, so it has no invoice.
 */
const { layout, esc, paragraphsHtml, COLORS, siteUrl } = require('./mailTemplate');

const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dateText = (d) => new Date(d || Date.now()).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** How the buyer paid, in words. Cash App for CashTap payments; otherwise what the provider told us (card, PayPal ...). */
function paymentLabel(purchase) {
  if (purchase.paymentMethod) return purchase.paymentMethod;
  if (purchase.provider === 'cashtap') return 'Cash App';
  if (purchase.provider === 'paddle') return 'Paddle';
  return 'Online payment';
}

function billingEmail() {
  return process.env.BILLING_EMAIL || 'billing@elmstool.com';
}

/** Everything an invoice shows. `number` must already exist (ensureInvoiceNumber). */
function buildInvoice(purchase, buyer, number) {
  const paid = Number(purchase.priceUsd) || 0;
  const list = Number(purchase.listPriceUsd) || paid;
  const discount = list - paid > 0.005 ? Math.round((list - paid) * 100) / 100 : 0;
  const credits = Number(purchase.creditsGranted) || 0;
  const planName = purchase.planName || null;
  return {
    number,
    date: purchase.createdAt,
    dateText: dateText(purchase.createdAt),
    status: purchase.status === 'refunded' ? 'Refunded' : 'Paid',
    buyerName: (buyer && buyer.name) || null,
    buyerEmail: (buyer && buyer.email) || '',
    payment: paymentLabel(purchase),
    reference: purchase.providerTransactionId,
    item: (planName ? planName + ', ' : '') + credits.toLocaleString('en-US') + ' credits',
    itemAmount: discount ? list : paid,
    discount,
    total: paid,
    credits,
  };
}

/** The invoice as the block inside a mail (already safe HTML). */
function invoiceHtml(inv) {
  const td = 'padding:10px 0;border-top:1px solid #eef0f4;font-size:14px;color:#374151';
  const rows = '<tr><td style="' + td + '">' + esc(inv.item) + '</td><td align="right" style="' + td + '">' + money(inv.itemAmount) + '</td></tr>'
    + (inv.discount ? '<tr><td style="' + td + ';color:#6b7280">Discount</td><td align="right" style="' + td + ';color:#3b6d11">-' + money(inv.discount) + '</td></tr>' : '');
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:12px;margin:6px 0 4px"><tr><td style="padding:20px">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>'
    + '<td valign="top"><div style="font-size:12px;color:#9ca3af">Invoice</div><div style="font-size:15px;font-weight:bold;color:#111827">' + esc(inv.number) + '</div><div style="font-size:13px;color:#6b7280">' + esc(inv.dateText) + '</div></td>'
    + '<td valign="top" align="right"><span style="display:inline-block;padding:3px 12px;border-radius:6px;font-size:12px;background:#eaf3de;color:#27500a">' + esc(inv.status) + '</span><div style="font-size:13px;color:#6b7280;margin-top:6px">' + esc(inv.payment) + '<br>Ref ' + esc(inv.reference) + '</div></td>'
    + '</tr></table>'
    + '<div style="margin:16px 0 12px;padding:12px 0;border-top:1px solid #eef0f4;border-bottom:1px solid #eef0f4;font-size:14px;color:#374151"><div style="font-size:12px;color:#9ca3af">Billed to</div>' + esc(inv.buyerName ? inv.buyerName + ' · ' : '') + '<span style="color:#6b7280">' + esc(inv.buyerEmail) + '</span></div>'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="font-size:12px;color:#9ca3af;padding-bottom:6px">Item</td><td align="right" style="font-size:12px;color:#9ca3af;padding-bottom:6px">Amount</td></tr>'
    + rows
    + '<tr><td style="padding:12px 0 0;border-top:2px solid #d1d5db;font-size:15px;font-weight:bold;color:#111827">Total paid</td><td align="right" style="padding:12px 0 0;border-top:2px solid #d1d5db;font-size:20px;font-weight:bold;color:#111827">' + money(inv.total) + '</td></tr></table>'
    + '</td></tr></table>';
}

/** The invoice as a PDF (Buffer). */
function invoicePdf(inv) {
  const PDFDocument = require('pdfkit');
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: 'Invoice ' + inv.number, Author: process.env.APP_NAME || 'ELMS' } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = 50;
    const right = doc.page.width - 50;
    const width = right - left;
    const grey = '#6b7280';
    const muted = '#9ca3af';
    const ink = '#111827';

    // logo letters + the four-colour strip
    doc.font('Helvetica-Bold').fontSize(30);
    doc.fillColor(COLORS.red).text('E', left, 50, { continued: true });
    doc.fillColor(COLORS.blue).text('L', { continued: true });
    doc.fillColor(COLORS.yellow).text('M', { continued: true });
    doc.fillColor(COLORS.green).text('S');
    doc.font('Helvetica').fontSize(9).fillColor(grey).text('eBay Listing & Management System', left, 88);
    const stripY = 108;
    [COLORS.red, COLORS.blue, COLORS.yellow, COLORS.green].forEach((c, i) => doc.rect(left + (width / 4) * i, stripY, width / 4, 4).fill(c));

    // invoice heading (right) and status
    doc.font('Helvetica-Bold').fontSize(20).fillColor(ink).text('INVOICE', left, 50, { width, align: 'right' });
    doc.font('Helvetica').fontSize(10).fillColor(grey).text(inv.number, left, 76, { width, align: 'right' }).text(inv.dateText, { width, align: 'right' });

    // billed to / payment
    let y = 140;
    doc.font('Helvetica').fontSize(9).fillColor(muted).text('BILLED TO', left, y).text('PAYMENT', left + width / 2, y);
    doc.font('Helvetica-Bold').fontSize(11).fillColor(ink).text(inv.buyerName || inv.buyerEmail, left, y + 14, { width: width / 2 - 10 });
    doc.font('Helvetica-Bold').fontSize(11).fillColor(ink).text(inv.payment, left + width / 2, y + 14, { width: width / 2 });
    doc.font('Helvetica').fontSize(10).fillColor(grey);
    if (inv.buyerName) doc.text(inv.buyerEmail, left, y + 30, { width: width / 2 - 10 });
    doc.text('Ref ' + inv.reference, left + width / 2, y + 30, { width: width / 2 });
    doc.text('Status: ' + inv.status, left + width / 2, y + 44, { width: width / 2 });

    // table
    y = 230;
    doc.font('Helvetica').fontSize(9).fillColor(muted).text('ITEM', left, y).text('AMOUNT', left, y, { width, align: 'right' });
    y += 18;
    const line = (yy, color = '#e5e7eb', w = 1) => doc.moveTo(left, yy).lineTo(right, yy).lineWidth(w).strokeColor(color).stroke();
    line(y);
    y += 10;
    doc.font('Helvetica').fontSize(11).fillColor('#374151').text(inv.item, left, y, { width: width - 110 }).text(money(inv.itemAmount), left, y, { width, align: 'right' });
    y += 26;
    if (inv.discount) {
      line(y - 6);
      doc.fillColor(grey).text('Discount', left, y).fillColor('#3b6d11').text('-' + money(inv.discount), left, y, { width, align: 'right' });
      y += 26;
    }
    line(y - 4, '#d1d5db', 2);
    y += 8;
    doc.font('Helvetica-Bold').fontSize(13).fillColor(ink).text('Total paid', left, y + 4);
    doc.font('Helvetica-Bold').fontSize(18).text(money(inv.total), left, y, { width, align: 'right' });

    // footer
    doc.font('Helvetica').fontSize(9).fillColor(muted).text('Questions about this invoice? Write to ' + billingEmail() + ' and quote ' + inv.number + '.', left, 760, { width, align: 'center' });
    doc.text((process.env.APP_NAME || 'ELMS') + ' · ' + siteUrl('').replace(/^https?:\/\//, ''), left, 774, { width, align: 'center' });
    doc.end();
  });
}

/** The mail for a new invoice (subject, plain text, html). */
function invoiceMail(inv) {
  const first = (inv.buyerName || '').trim().split(/\s+/)[0];
  const intro = 'Your payment went through and ' + inv.credits.toLocaleString('en-US') + ' credits are in your account now. Your invoice is below and attached as a PDF.';
  const bodyHtml = paragraphsHtml(intro) + invoiceHtml(inv)
    + '<p style="margin:16px 0 0;font-size:13px;line-height:1.6;color:#6b7280">Questions about this invoice? Reply to this email and quote the invoice number.</p>';
  const text = [
    'Thanks for your purchase' + (first ? ', ' + first : ''),
    intro,
    'Invoice ' + inv.number + ' - ' + inv.dateText,
    inv.item + ': ' + money(inv.itemAmount),
    inv.discount ? 'Discount: -' + money(inv.discount) : null,
    'Total paid: ' + money(inv.total) + ' (' + inv.payment + ', ref ' + inv.reference + ')',
    'Questions? Reply to this email and quote the invoice number.',
  ].filter(Boolean).join('\n\n');
  return {
    subject: (process.env.APP_NAME || 'ELMS') + ' invoice ' + inv.number,
    text,
    html: layout({
      title: 'Thanks for your purchase' + (first ? ', ' + first : ''),
      preheader: inv.item + ' · ' + money(inv.total) + ' paid',
      bodyHtml,
      cta: { text: 'Open ' + (process.env.APP_NAME || 'ELMS'), url: siteUrl('/dashboard') },
    }),
  };
}

/** Numbers the purchase if needed and builds its invoice. Returns null for a purchase that has none (free voucher plan). */
async function invoiceForPurchase(purchase) {
  if (!purchase || purchase.provider === 'voucher') return null;
  const { ensureInvoiceNumber } = require('../models/purchasesModel');
  const { getUserById } = require('../models/usersModel');
  const number = await ensureInvoiceNumber(purchase.id);
  if (!number) return null;
  const buyer = await getUserById(purchase.userId);
  return buildInvoice(purchase, buyer, number);
}

/** Mails the invoice (with its PDF) to the buyer. Never throws: the buyer already has their credits. */
async function sendInvoiceForPurchase(purchase) {
  try {
    const inv = await invoiceForPurchase(purchase);
    if (!inv || !inv.buyerEmail) return null;
    const mail = invoiceMail(inv);
    let attachments;
    try {
      attachments = [{ filename: inv.number + '.pdf', content: await invoicePdf(inv), contentType: 'application/pdf' }];
    } catch (pdfErr) {
      console.warn('invoice pdf failed:', pdfErr.message); // the mail still carries the invoice
    }
    return await require('./emailService').sendInvoiceEmail({ to: inv.buyerEmail, ...mail, attachments });
  } catch (err) {
    console.warn('invoice email failed:', err.message);
    return null;
  }
}

module.exports = { buildInvoice, invoiceHtml, invoicePdf, invoiceMail, invoiceForPurchase, sendInvoiceForPurchase, paymentLabel, money };
