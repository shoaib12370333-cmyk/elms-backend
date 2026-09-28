// Settings -> VeRO -> "Import from PDF": a text-based PDF's words are added the same way pasting them would be.
const assert = require('assert');
const path = require('path');
const PDFDocument = require('pdfkit');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

const store = { u1: { veroWords: [] } };
stub('models/schemas/User', {
  findById: (id) => ({ lean: async () => (store[id] ? { veroWords: store[id].veroWords.slice() } : null) }),
  updateOne: async ({ _id }, u) => {
    const s = store[_id];
    if (u.$addToSet) for (const w of u.$addToSet.veroWords.$each) if (!s.veroWords.includes(w)) s.veroWords.push(w);
  },
});
stub('middleware/requireAuth', { requireAuth: (req, res, next) => next() });

const { candidatesFromPdfText, importVeroWordsFromPdfBuffer } = require('../services/veroPdfImportService');
const router = require('../routes/veroSettings');
const handler = (method, p) => { const l = router.stack.find((x) => x.route && x.route.path === p && x.route.methods[method]); assert.ok(l, method + ' ' + p); return l.route.stack[l.route.stack.length - 1].handle; };
const fakeRes = () => { const r = { statusCode: 200 }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
const call = async (req) => { const res = fakeRes(); await handler('post', '/import-pdf')({ userId: 'u1', body: {}, ...req }, res); return res; };

/**
 * A tiny real PDF (Buffer), built the same way services/invoiceService.js builds one. A small font keeps every line
 * from wrapping within the page width, so each string here becomes exactly one line in the PDF's own text layer -
 * without that, a long line would word-wrap into several short fragments (see the caveat in veroPdfImportService.js),
 * which would make this test's "one input line = one candidate" assumption wrong for reasons that have nothing to do
 * with the code under test.
 */
function buildPdf(lines) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.fontSize(6);
    for (const line of lines) doc.text(line);
    doc.end();
  });
}

(async () => {
  // candidatesFromPdfText: splits on comma/semicolon/newline/tab, drops anything longer than 6 words (prose, not a brand)
  assert.deepStrictEqual(
    candidatesFromPdfText('Nike\nAdidas, Air Max\tTiffany & Co\n\nThis sentence has way more than six words in it and must be dropped'),
    ['Nike', 'Adidas', 'Air Max', 'Tiffany & Co']
  );
  assert.deepStrictEqual(candidatesFromPdfText(''), []);
  assert.deepStrictEqual(candidatesFromPdfText('   \n  \n '), []);

  // end to end: a real PDF, really parsed, really added - the prose-filtering itself is covered above (candidatesFromPdfText),
  // in isolation from pdfkit's own word-wrap (a long line here would wrap across several short fragments in the real
  // PDF, per the caveat in veroPdfImportService.js, which would make assertions about it non-deterministic here).
  const pdf = await buildPdf(['TestBrandXYZ', 'AnotherBrandABC', 'Multi Word Brand', '1:1']);
  let out = await importVeroWordsFromPdfBuffer('u1', pdf);
  assert.deepStrictEqual(out.added.sort(), ['1:1', 'anotherbrandabc', 'multi word brand', 'testbrandxyz'].sort());

  // re-importing the same PDF adds nothing new (already-saved words are just skipped, same as pasting them again)
  out = await importVeroWordsFromPdfBuffer('u1', pdf);
  assert.deepStrictEqual(out.added, []);

  // a PDF with nothing usable at all is refused
  const emptyPdf = await buildPdf(['   ']);
  await assert.rejects(() => importVeroWordsFromPdfBuffer('u2-empty', emptyPdf), /No usable words/);

  // the route: success path (multer already having set req.file is assumed - this is our own handler's logic, not multer's)
  store.u1.veroWords = [];
  let res = await call({ file: { buffer: pdf, mimetype: 'application/pdf' } });
  assert.strictEqual(res.body.success, true);
  assert.deepStrictEqual(res.body.added.sort(), ['1:1', 'anotherbrandabc', 'multi word brand', 'testbrandxyz'].sort());

  // the route: no file at all
  res = await call({ file: undefined });
  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.error, /Choose a PDF file/);

  console.log('vero pdf import tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
