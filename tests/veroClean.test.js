// The AI cleaner: asks the AI to rewrite ONLY the pieces that hold a VeRO word (the title, the bullet points that hold one, the
// sentences of the description that hold one), puts its answers back into an otherwise untouched listing, and guarantees none of
// the user's words is left (anything the AI missed, or could not be asked about, is cut by rule); brand / specifics are cleaned by rule.
const assert = require('assert');
const aiPath = require.resolve('../services/aiService');
require(aiPath);
let answer = '';
let prompts = [];
let tokenBudgets = [];
require.cache[aiPath].exports.askClaude = async ({ prompt, maxTokens }) => { prompts.push(prompt); tokenBudgets.push(maxTokens); return { text: answer, model: 't', inputTokens: 1, outputTokens: 1 }; };
const { cleanVeroTerms, splitForRewrite, usableRewrite, MAX_SNIPPETS, MAX_SNIPPET_CHARS, MAX_SNIPPET_TOTAL_CHARS } = require('../services/veroCleanerService');
const { createMatcher } = require('../services/veroService');

const words = ['nike', 'air max', 'marvel', 'apple', 'adidas'];
const vero = createMatcher(words);
const remaining = (data) => vero.scanListing(data).terms;
const piecesOf = (prompt) => JSON.parse(prompt.slice(prompt.lastIndexOf('Pieces to rewrite:\n') + 'Pieces to rewrite:\n'.length));
const reset = () => { prompts = []; tokenBudgets = []; };
const empty = { bulletPoints: [], specifications: [], aspects: {}, brand: '' };

(async () => {
  const input = {
    title: 'Nike Air Max running shoes for men', description: 'Soft shoes by Nike.\nMarvel fans love them.',
    bulletPoints: ['Nike quality', 'Comfortable'], specifications: [{ name: 'Brand', value: 'Nike' }, { name: 'Color', value: 'Black' }],
    aspects: { Brand: ['Nike'], Color: ['Black'] }, brand: 'Nike',
  };
  // the AI removes most words but leaves "Marvel" behind -> the sweep removes it
  answer = 'Sure: ' + JSON.stringify({ title: 'Running shoes for men', bullets: [{ i: 0, t: 'Great quality' }], snippets: [{ id: 0, t: 'Soft shoes.' }, { id: 1, t: 'Marvel fans love them.' }] });
  let out = await cleanVeroTerms(input, words);
  assert.strictEqual(out.data.title, 'Running shoes for men');
  assert.strictEqual(out.data.description, 'Soft shoes.\nfans love them.');
  assert.deepStrictEqual(out.data.bulletPoints, ['Great quality', 'Comfortable']);
  assert.deepStrictEqual(out.data.specifications, [{ name: 'Brand', value: 'Unbranded' }, { name: 'Color', value: 'Black' }]);
  assert.deepStrictEqual(out.data.aspects, { Brand: ['Unbranded'], Color: ['Black'] });
  assert.ok(['nike', 'air max', 'marvel'].every((w) => out.data.removed.includes(w)));
  assert.deepStrictEqual(remaining(out.data), [], 'the result contains none of the user\'s words');
  assert.match(prompts[0], /nike, air max/);
  // ...and the AI was only given the pieces that hold a word: the title, bullet 0 (not "Comfortable"), the two sentences
  const given = piecesOf(prompts[0]);
  assert.strictEqual(given.title, input.title);
  assert.deepStrictEqual(given.bullets, [{ i: 0, t: 'Nike quality' }]);
  assert.deepStrictEqual(given.snippets, [{ id: 0, t: 'Soft shoes by Nike.' }, { id: 1, t: 'Marvel fans love them.' }]);
  assert.ok(!prompts[0].includes('Comfortable'));

  // a word the user did NOT save is left alone
  answer = JSON.stringify({ title: 'Gucci belt' });
  out = await cleanVeroTerms({ title: 'Gucci belt by Nike', description: '', ...empty }, words);
  assert.strictEqual(out.data.title, 'Gucci belt');

  // an answer for a bullet that was not asked about is ignored; the piece it did not answer for is cut by rule
  answer = '{"title":"Shoes","bullets":[{"i":5,"t":"x"}]}';
  out = await cleanVeroTerms(input, words);
  assert.deepStrictEqual(out.data.bulletPoints, ['quality', 'Comfortable']);
  assert.deepStrictEqual(remaining(out.data), []);

  // a very long title from the AI is cut to 80
  answer = JSON.stringify({ title: 'Shoes '.repeat(30) });
  out = await cleanVeroTerms(input, words);
  assert.ok(out.data.title.length <= 80);

  // unreadable answer -> error (the route refunds the credit)
  answer = 'no json here';
  await assert.rejects(() => cleanVeroTerms(input, words), /could not be read/);

  // nothing in the running text: no AI call at all, the rule-based part still runs
  reset();
  out = await cleanVeroTerms({ title: 'Plain table', description: 'A table.', bulletPoints: [], specifications: [], aspects: { Brand: ['Adidas'] }, brand: '' }, words);
  assert.strictEqual(prompts.length, 0);
  assert.deepStrictEqual(out.data.aspects, { Brand: ['Unbranded'] });

  // no saved words at all: nothing to remove
  reset();
  out = await cleanVeroTerms({ title: 'Nike shoes', description: '', ...empty }, []);
  assert.strictEqual(prompts.length, 0);
  assert.strictEqual(out.data.title, 'Nike shoes');

  // =====================================================================================================================
  // The point of this design: an AI call is slow in proportion to the text it WRITES. Only the sentences that hold a word go to
  // it; every other character of the description - tags, attributes, spacing, line breaks - comes back exactly as it was.
  // =====================================================================================================================
  const html = '<div class="d" style="color:red"><h2>Product details</h2>\n<p>Great fit. This Nike shoe is light.   Keep dry.</p>\n<ul><li>Soft sole</li><li>Official Nike style</li></ul>\n<p>Unrelated paragraph with   odd   spacing.</p></div>';
  reset();
  answer = JSON.stringify({ snippets: [{ id: 0, t: 'This shoe is light.' }, { id: 1, t: 'Official style' }] });
  out = await cleanVeroTerms({ title: 'Plain title', description: html, ...empty }, words);
  assert.strictEqual(out.data.description, '<div class="d" style="color:red"><h2>Product details</h2>\n<p>Great fit. This shoe is light.   Keep dry.</p>\n<ul><li>Soft sole</li><li>Official style</li></ul>\n<p>Unrelated paragraph with   odd   spacing.</p></div>', 'only the two sentences changed; tags, spacing and the rest are byte-identical');
  assert.strictEqual(prompts.length, 1);
  const htmlGiven = piecesOf(prompts[0]);
  assert.deepStrictEqual(htmlGiven.snippets, [{ id: 0, t: 'This Nike shoe is light.' }, { id: 1, t: 'Official Nike style' }]);
  assert.ok(!('title' in htmlGiven) && !('bullets' in htmlGiven), 'a clean title and clean bullets are not sent');
  for (const unrelated of ['Unrelated paragraph', 'Great fit', 'Product details', 'Soft sole', '<div', 'style=']) assert.ok(!prompts[0].includes(unrelated), 'never sent: ' + unrelated);
  assert.deepStrictEqual(remaining(out.data), []);

  // a sentence keeps the spaces around it; an HTML entity next to the word still counts as a word boundary
  reset();
  answer = JSON.stringify({ snippets: [{ id: 0, t: 'Shoes rock!' }, { id: 1, t: 'shoes &amp; socks.' }] });
  out = await cleanVeroTerms({ title: 'x', description: '<p>  Nike shoes rock!  </p><p>Nike&nbsp;shoes &amp; socks.</p>', ...empty }, words);
  assert.strictEqual(prompts.length, 1);
  assert.strictEqual(out.data.description, '<p>  Shoes rock!  </p><p>shoes &amp; socks.</p>');

  // the AI answers with markup or a line break the sentence did not have, or something much longer: not trusted, that sentence is cut by rule
  for (const bad of ['<b>Shoes</b>', 'Shoes\nand more', 'This is a completely different and far far longer answer than the short sentence ever was, honestly.', 42, null]) {
    reset();
    answer = JSON.stringify({ snippets: [{ id: 0, t: bad }] });
    out = await cleanVeroTerms({ title: 'x', description: '<p>This Nike shoe is light.</p>', ...empty }, words);
    assert.strictEqual(out.data.description, '<p>This shoe is light.</p>', 'rule cut instead of: ' + JSON.stringify(bad));
  }

  // one sentence the AI answered, one it did not: the answered one uses the AI, the other is cut by rule - the rest untouched
  reset();
  answer = JSON.stringify({ snippets: [{ id: 0, t: 'Lovely soft shoes.' }] });
  out = await cleanVeroTerms({ title: 'x', description: '<p>Nike shoes are soft. Marvel fans love them. Stay dry.</p>', ...empty }, words);
  assert.strictEqual(out.data.description, '<p>Lovely soft shoes. fans love them. Stay dry.</p>');

  // a sentence the AI did not answer for is cut by rule ON ITS OWN, so the final sweep finds nothing left and the rest of the
  // description keeps its spacing exactly (a sweep over the whole text would collapse the odd spacing elsewhere)
  reset();
  answer = JSON.stringify({ snippets: [] });
  out = await cleanVeroTerms({ title: 'x', description: '<p>Nike shoes.   Other   spacing   here.</p>', ...empty }, words);
  assert.strictEqual(out.data.description, '<p>shoes.   Other   spacing   here.</p>');

  // the AI leaves a word behind inside a sentence: the final sweep cuts it
  reset();
  answer = JSON.stringify({ snippets: [{ id: 0, t: 'Nike shoes are soft.' }] });
  out = await cleanVeroTerms({ title: 'x', description: '<p>Nike shoes are soft.</p>', ...empty }, words);
  assert.deepStrictEqual(remaining(out.data), []);

  // a long description is no longer skipped: only its branded sentences are sent, however long the rest is
  reset();
  const filler = '<p>' + 'Plain sentence about the product and how well it is made. '.repeat(40) + '</p>\n';
  const longDescription = filler.repeat(12) + '<p>Made by Nike for you.</p>' + filler.repeat(12) + '<p>Fits Apple cases.</p>';
  assert.ok(longDescription.length > 25000);
  answer = JSON.stringify({ snippets: [{ id: 0, t: 'Made for you.' }, { id: 1, t: 'Fits phone cases.' }] });
  out = await cleanVeroTerms({ title: 'x', description: longDescription, ...empty }, words);
  assert.ok(prompts[0].length < 2500, 'the prompt is a few hundred characters of sentences, not 25000 of description: ' + prompts[0].length);
  assert.strictEqual(out.data.description, longDescription.replace('Made by Nike for you.', 'Made for you.').replace('Fits Apple cases.', 'Fits phone cases.'));

  // a "sentence" over the limit is not sent (it is cut by rule), and with nothing else to ask there is NO AI call at all
  reset();
  const runOn = '<p>' + 'word '.repeat(150) + 'Nike ' + 'word '.repeat(10) + '</p>';
  assert.ok(runOn.length > MAX_SNIPPET_CHARS);
  out = await cleanVeroTerms({ title: 'x', description: runOn, ...empty }, words);
  assert.strictEqual(prompts.length, 0);
  assert.deepStrictEqual(remaining(out.data), []);
  assert.match(out.data.description, /^<p>word word.*word\s*<\/p>$/, 'the rest of it is still there');

  // a word only inside a tag attribute (alt text): nothing to send, the sweep cuts it, no AI call
  reset();
  out = await cleanVeroTerms({ title: 'x', description: '<p>Plain.</p><img alt="Nike shoes" src="a.jpg">', ...empty }, words);
  assert.strictEqual(prompts.length, 0);
  assert.deepStrictEqual(remaining(out.data), []);

  // a brand in every sentence: never more than the limits go to the AI, and the result is still clean
  reset();
  const many = '<p>' + Array.from({ length: 150 }, (_, i) => `Sentence ${i} about Nike shoes in detail.`).join(' ') + '</p>';
  answer = JSON.stringify({ snippets: [] }); // the AI is no help here: everything falls back to the rule
  out = await cleanVeroTerms({ title: 'x', description: many, ...empty }, words);
  const sent = piecesOf(prompts[0]).snippets;
  assert.ok(sent.length <= MAX_SNIPPETS, 'at most ' + MAX_SNIPPETS + ' sentences: ' + sent.length);
  assert.ok(sent.reduce((n, s) => n + s.t.length, 0) <= MAX_SNIPPET_TOTAL_CHARS);
  assert.ok(tokenBudgets[0] <= 3500, 'the answer budget stays inside what the model is given');
  assert.deepStrictEqual(remaining(out.data), [], 'the ones not sent were cut by rule');

  // long branded sentences: together they may not exceed the total limit either (the model's answer would not fit its token budget); the rest is cut by rule
  reset();
  const bulky = '<p>' + Array.from({ length: 30 }, (_, i) => `Sentence ${i} about Nike ` + 'detail '.repeat(70) + 'end.').join(' ') + '</p>';
  answer = JSON.stringify({ snippets: [] });
  out = await cleanVeroTerms({ title: 'x', description: bulky, ...empty }, words);
  const bulkySent = piecesOf(prompts[0]).snippets;
  assert.ok(bulkySent.length > 0 && bulkySent.length < 30, 'some sent, not all: ' + bulkySent.length);
  assert.ok(bulkySent.reduce((n, s) => n + s.t.length, 0) <= MAX_SNIPPET_TOTAL_CHARS);
  assert.deepStrictEqual(remaining(out.data), []);

  // the answer budget is a fixed ceiling, never worked out from the text: many SHORT pieces cost more tokens in JSON than in text, and an
  // answer cut short has no closing "}" and fails (max_tokens only caps the answer, it does not make the call slower)
  reset();
  const lis = '<ul>' + Array.from({ length: 60 }, () => '<li>Fits Apple 12 Pro</li>').join('') + '</ul>';
  answer = JSON.stringify({ snippets: Array.from({ length: 60 }, (_, id) => ({ id, t: 'Fits phone 12 Pro' })) });
  out = await cleanVeroTerms({ title: 'x', description: lis, ...empty }, words);
  assert.strictEqual(piecesOf(prompts[0]).snippets.length, 60);
  assert.strictEqual(tokenBudgets[0], 3500);
  assert.strictEqual(out.data.description, '<ul>' + '<li>Fits phone 12 Pro</li>'.repeat(60) + '</ul>', 'all 60 answers were applied');

  // the AI answers for a title that was NOT sent (it copied the three-key example): a clean title is never overwritten
  reset();
  answer = JSON.stringify({ title: 'Hacked title', snippets: [{ id: 0, t: 'Soft shoes.' }] });
  out = await cleanVeroTerms({ title: 'Plain title', description: '<p>Nike soft shoes.</p>', ...empty }, words);
  assert.strictEqual(out.data.title, 'Plain title');

  // cutting a word can join its neighbours into another listed word ("Air Nike Max" -> "Air Max"): the sweep repeats until nothing is left
  reset();
  answer = JSON.stringify({});
  out = await cleanVeroTerms({ title: 'Air Nike Max shoes', description: '<p>Air Nike Max fans.</p>', bulletPoints: ['Air Nike Max comfort'], specifications: [], aspects: {}, brand: '' }, words);
  assert.strictEqual(out.data.title, 'shoes');
  assert.deepStrictEqual(remaining(out.data), [], 'no listed word survives, even one that only appeared after another was cut');
  assert.deepStrictEqual(out.data.bulletPoints, ['comfort']);

  // a "<" with no ">" is text, not a tag: it neither swallows the words after it nor makes the split slow
  reset();
  answer = JSON.stringify({ snippets: [{ id: 0, t: 'Shoes.' }] });
  out = await cleanVeroTerms({ title: 'x', description: '<p>a < b. Nike <b>x</b> shoes.</p>', ...empty }, words);
  assert.deepStrictEqual(piecesOf(prompts[0]).snippets.map((s) => s.t), ['Nike'], 'the sentence with the word was found, not hidden inside a fake tag');
  assert.deepStrictEqual(remaining(out.data), []);
  reset();
  const started = Date.now();
  out = await cleanVeroTerms({ title: 'x', description: 'Nike ' + '<'.repeat(80000), ...empty }, words);
  assert.ok(Date.now() - started < 2000, 'a long run of "<" is not quadratic (the old pattern needed ~9 seconds here): ' + (Date.now() - started) + 'ms');
  assert.deepStrictEqual(remaining(out.data), []);

  // a word hidden by invisible marks (Amazon pastes them) is still found, sent and removed
  reset();
  answer = JSON.stringify({ snippets: [{ id: 0, t: 'Shoes.' }] });
  out = await cleanVeroTerms({ title: 'x', description: '<p>Ni​ke shoes. Other.</p>', ...empty }, words);
  assert.strictEqual(prompts.length, 1);
  assert.strictEqual(out.data.description, '<p>Shoes. Other.</p>');

  // =====================================================================================================================
  // splitForRewrite / usableRewrite on their own
  // =====================================================================================================================
  const rebuild = (split) => split.parts.map((p) => (typeof p === 'string' ? p : split.snippets[p.id].core)).join('');
  for (const text of [
    html, '', 'plain Nike text', '  Nike  ', 'a < b and Nike > c', '<p>Nike</p><p></p>', 'Line one Nike.\n\nLine two.\nNike again!', '<a href="x?brand=nike">Nike</a> & <b>Apple</b>.',
    '<p>Nike&nbsp;shoes. 3.5mm Apple jack. e.g. Marvel!</p>',
  ]) {
    const split = splitForRewrite(text, vero);
    const rebuiltWithSpaces = split.parts.map((p) => (typeof p === 'string' ? p : '\u0001' + p.id + '\u0001')).join('');
    assert.strictEqual(rebuiltWithSpaces.replace(/\u0001(\d+)\u0001/g, (m, id) => split.snippets[id].core), rebuild(split));
    // joining it back with the SAME sentences (no rewrite) gives the original text exactly - nothing was lost or moved
    assert.strictEqual(rebuild(split).replace(/\s/g, ''), text.replace(/\s/g, ''), 'no character lost: ' + JSON.stringify(text));
  }
  assert.deepStrictEqual(splitForRewrite('<p>A. Nike B. C.</p>', vero).snippets.map((s) => s.core), ['Nike B.']);
  assert.deepStrictEqual(splitForRewrite('no words here <b>at all</b>', vero).snippets, []);
  assert.deepStrictEqual(splitForRewrite('<p>Nike</p>', vero).parts.filter((p) => typeof p !== 'string'), [{ id: 0 }]);

  assert.strictEqual(usableRewrite('Nike shoes', '  Shoes  '), 'Shoes');
  assert.strictEqual(usableRewrite('Nike shoes', 'Shoes'), 'Shoes');
  assert.strictEqual(usableRewrite('Nike shoes', ''), '', 'removing a whole sentence is allowed');
  assert.strictEqual(usableRewrite('Nike shoes', '<b>Shoes</b>'), null);
  assert.strictEqual(usableRewrite('a < b Nike', 'a < b'), 'a < b', 'markup characters the original already had are fine');
  assert.strictEqual(usableRewrite('Nike shoes', 'Shoes\nmore'), null);
  assert.strictEqual(usableRewrite('Nike shoes', 'x'.repeat(200)), null);
  assert.strictEqual(usableRewrite('Nike shoes', undefined), null);
  assert.strictEqual(usableRewrite('Nike shoes', ['Shoes']), null);

  console.log('vero clean tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
