// services/validationService.js descriptionWordCount: counts the READABLE words of a description, never its HTML
// markup (tag names, attributes, entities) - a table-heavy, AI-beautified description must not be overstated just
// because of its own tags.
const assert = require('assert');
const { descriptionWordCount, DESCRIPTION_WORD_LIMIT } = require('../services/validationService');

(async () => {
  assert.strictEqual(DESCRIPTION_WORD_LIMIT, 4000);

  // ---------- plain text ----------
  assert.strictEqual(descriptionWordCount('one two three'), 3);
  assert.strictEqual(descriptionWordCount(''), 0);
  assert.strictEqual(descriptionWordCount(null), 0);
  assert.strictEqual(descriptionWordCount(undefined), 0);
  assert.strictEqual(descriptionWordCount('   '), 0);

  // ---------- HTML tags and their attributes are never counted as words ----------
  assert.strictEqual(
    descriptionWordCount('<div class="hero" style="color:red"><h2>Great Product</h2><p>Works well and lasts long.</p></div>'),
    7, // Great Product Works well and lasts long
  );

  // ---------- HTML entities (&nbsp;, &amp;, ...) are stripped, not counted or glued onto neighbouring words ----------
  assert.strictEqual(descriptionWordCount('Salt&nbsp;&amp;&nbsp;Pepper Set'), 3, 'Salt & Pepper Set - the entities themselves are not words');

  // ---------- the limit itself ----------
  const exactly4000 = Array.from({ length: 4000 }, () => 'word').join(' ');
  assert.strictEqual(descriptionWordCount(exactly4000), 4000);
  assert.ok(!(descriptionWordCount(exactly4000) > DESCRIPTION_WORD_LIMIT), 'exactly at the limit is allowed, not over it');
  assert.ok(descriptionWordCount(exactly4000 + ' oneMore') > DESCRIPTION_WORD_LIMIT);

  console.log('description word count tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
