const { PDFParse } = require('pdf-parse');
const { addWords } = require('./veroSettingsService');

/**
 * "Import from PDF" (Settings -> VeRO): a seller uploads a PDF of brand names (their own list, or the one ELMS's
 * PDF export gives them back) and every usable word on it is added exactly like pasting them into the box would
 * (routes/veroSettings.js POST /words) - same normalizing, deduping and MAX_WORDS cap (services/veroService.js).
 *
 * Only text-based PDFs are supported (pdf-parse reads the PDF's own text layer; a scanned/photographed page has none
 * and yields nothing here) - the PDF ELMS itself generates for this list is plain HTML printed to PDF, so it always
 * has one.
 */

// A real brand entry is at most a handful of words ("polo ralph lauren", "tag heuer"); a title, the explanatory note
// or a footer line runs much longer, so this alone tells a word list apart from prose without knowing this PDF's layout.
// Caveat: this only catches a prose line that survives as ONE line in the PDF's own text layer. A long paragraph that
// the PDF word-wraps across several lines (as the note in ELMS's own exported list does) comes back from pdf-parse as
// several short line fragments, some of which may slip under this word count - a handful of stray non-brand "words"
// from such a paragraph is possible and is left for the seller to remove from their list by hand (Settings -> VeRO),
// the same way a bad paste would be.
const MAX_WORDS_PER_CANDIDATE = 6;

/** Splits raw PDF text into candidate words: one per line/tab/comma-separated cell, prose sentences filtered out. */
function candidatesFromPdfText(text) {
  return String(text || '')
    .split(/[,;\n\t]/)
    .map((v) => v.trim())
    .filter(Boolean)
    .filter((v) => v.split(/\s+/).length <= MAX_WORDS_PER_CANDIDATE);
}

async function importVeroWordsFromPdfBuffer(userId, buffer) {
  const parser = new PDFParse({ data: buffer });
  let text;
  try {
    // .pages[].text, not the top-level .text: the combined field splices a "-- N of M --" page marker between pages,
    // which (being short) would otherwise pass MAX_WORDS_PER_CANDIDATE and get "imported" as a word of its own.
    const result = await parser.getText();
    text = result.pages.map((p) => p.text).join('\n');
  } catch (err) {
    throw Object.assign(new Error('Could not read that PDF - is it a valid, text-based PDF?'), { statusCode: 400 });
  } finally {
    await parser.destroy();
  }

  const candidates = candidatesFromPdfText(text);
  if (!candidates.length) {
    throw Object.assign(new Error('No usable words were found in that PDF.'), { statusCode: 400 });
  }
  return addWords(userId, candidates);
}

module.exports = { importVeroWordsFromPdfBuffer, candidatesFromPdfText };
