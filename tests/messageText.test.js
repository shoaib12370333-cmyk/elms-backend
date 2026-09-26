// eBay's own messages arrive as a whole HTML document; the Messages page must show readable text, and plain messages must stay exactly as written.
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
const { messageToText } = require('../services/messageTextService');

// ---- a realistic eBay notice: doctype, head/style, tables, links, entities, comments
const ebayNotice = [
  '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">',
  '<html xmlns="http://www.w3.org/1999/xhtml"><head><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"><title>Order update</title>',
  '<style type="text/css">body{font-family:Arial} .x{color:red}</style><script>var a = "<b>not text</b>";</script></head>',
  '<body><!-- tracking pixel --><table width="100%"><tr><td>Hi&nbsp;Sam,</td></tr>',
  '<tr><td>Your item <b>Blue &amp; Green Mug</b> sold for &#163;12.50 &ndash; please ship by Friday.<br><br>Buyer&#39;s note: &quot;gift wrap&quot;</td></tr>',
  '<tr><td><ul><li>Print the label</li><li>Add tracking</li></ul></td></tr>',
  '<tr><td><a href="https://www.ebay.co.uk/sh/ord/details?orderid=1">View order</a> or <a href="https://www.ebay.co.uk/help">https://www.ebay.co.uk/help</a></td></tr>',
  '<tr><td><img src="https://i.ebayimg.com/x.png" alt="eBay logo"><img src="https://i.ebayimg.com/pixel.gif"></td></tr></table></body></html>',
].join('\n');
const text = messageToText(ebayNotice);
assert.ok(!/<|>/.test(text), 'no tag is left: ' + text);
assert.ok(!/doctype|xhtml|font-family|not text|tracking pixel|Order update/i.test(text), 'doctype, head, style, script and comments are gone: ' + text);
assert.ok(text.startsWith('Hi Sam,'), 'starts with the real words: ' + JSON.stringify(text.slice(0, 40)));
assert.ok(text.includes('Blue & Green Mug') && text.includes('£12.50 - please ship by Friday.'), 'entities are decoded');
assert.ok(text.includes('Buyer\'s note: "gift wrap"'));
assert.ok(text.includes('- Print the label\n- Add tracking'), 'list items on their own lines: ' + JSON.stringify(text));
assert.ok(text.includes('View order or') && !text.includes('orderid=1'), 'a tracking-style link (it has a query) keeps only its words');
assert.ok(text.includes('https://www.ebay.co.uk/help') && !text.includes('https://www.ebay.co.uk/help (https'), 'a link whose words are its address is not doubled');
assert.ok(text.includes('eBay logo'), 'an image with alt text keeps the alt');
assert.ok(!/\n{3,}/.test(text) && text === text.trim(), 'no big gaps');

// a link with a plain short address keeps it; a tracking address (query, or very long) is dropped when the link has words
assert.strictEqual(messageToText('<p>Read the <a href="https://www.ebay.com/help/policies">policy</a></p>'), 'Read the policy (https://www.ebay.com/help/policies)');
assert.strictEqual(messageToText('<p>Go <a href="https://www.ebay.com/track?' + 'x=1&'.repeat(60) + '">here</a></p>'), 'Go here');
assert.strictEqual(messageToText('<p><a href="https://www.ebay.com/track?x=1"></a></p>'), 'https://www.ebay.com/track', 'a link with no words shows its address without the query');
// only web links keep an address
assert.strictEqual(messageToText('<p><a href="javascript:alert(1)">click</a> <a href="mailto:a@b.com">mail</a></p>'), 'click mail');

// ---- an eBay mail as it really looks: a hidden preview line padded with invisible characters, spacer images, tracking links, junk entities
const noisy = '<html><body><div style="display:none;font-size:1px;color:#fff;max-height:0px;opacity:0;overflow:hidden">Your order has shipped &#847; &zwnj; &#8203; &nbsp; &#847; &zwnj; xqzk vwpl &#847; &zwnj;</div>'
  + '<table><tr><td><img src="https://i.ebayimg.com/s.gif" alt="a" width="1"><img src="x.gif" alt="  "><img src="l.png" alt="eBay"></td></tr>'
  + '<tr><td style="font-size:0px">hidden filler abc</td></tr>'
  + '<tr><td>Hello Sam,\u200B\u00AD\u034F you sold <b>1 item</b>.</td></tr>'
  + '<tr><td><a href="https://rover.ebay.com/rover/0/e1/7?mpre=https%3A%2F%2Fwww.ebay.com%2Forder&amp;_trkparms=abc123&amp;euid=zzzzzzzzzzzzzzzz">Go to order</a></td></tr>'
  + '<tr><td><a href="https://rover.ebay.com/rover/0/e1/8?x=1"><img src="btn.png" alt="b"></a></td></tr>'
  + '<tr><td>&copy; 2026 eBay Inc.&thinsp;All rights reserved.</td></tr></table></body></html>';
const clean = messageToText(noisy);
assert.strictEqual(clean, 'eBay\n\nHello Sam, you sold 1 item.\nGo to order\nhttps://rover.ebay.com/rover/0/e1/8\n(c) 2026 eBay Inc. All rights reserved.');
assert.ok(!/xqzk|vwpl|filler|zzzz|mpre|abc123|&zwnj|&#/.test(clean), 'no hidden filler, no tracking junk, no raw entities');
assert.ok(!/[\u200B-\u200F\u00AD\u034F\uFEFF]/.test(clean), 'no invisible characters are left');
assert.strictEqual(messageToText('<p>Hi&zwnj;&shy;there &#847;</p>'), 'Hithere', 'invisible entities leave nothing behind');

// ---- plain messages are returned exactly as they are
for (const plain of ['Hello, is this still available?', 'Size < 5 and price > 10?', 'Line one\n\nLine two', 'x <3 you', 'Use the <name> field', '', 'a & b &amp; c']) {
  assert.strictEqual(messageToText(plain), plain, JSON.stringify(plain));
}
assert.strictEqual(messageToText(null), ''); assert.strictEqual(messageToText(undefined), ''); assert.strictEqual(messageToText(42), '42');
// a small html message
assert.strictEqual(messageToText('Thanks!<br>Best,<br/>Sam'), 'Thanks!\nBest,\nSam');
assert.strictEqual(messageToText('<p>One</p><p>Two &lt;3</p>'), 'One\nTwo <3');
// numeric and unknown entities
assert.strictEqual(messageToText('<p>&#x41;&#66; &unknown; &#0; &#99999999;</p>'), 'AB &unknown;');

// ---- where it is used: saving and reading a message, and a conversation snippet
stub('models/schemas/Message', {
  bulkWrite: async (ops) => { saved.push(...ops.map((o) => o.updateOne.update.$set)); },
  find: () => ({ sort: () => ({ lean: async () => stored }) }),
});
const saved = []; let stored = [];
const { upsertMessages, listMessages } = require('../models/messagesModel');

(async () => {
  await upsertMessages({ userId: 'u', ebayAccountId: 'a', conversationDoc: { _id: 'c1' }, ebayConversationId: 'e1', messages: [
    { messageId: 'm1', content: ebayNotice, fromUsername: 'eBay' },
    { messageId: 'm2', content: 'Is size < 5 ok?', fromUsername: 'buyer' },
  ] });
  assert.ok(saved[0].content.startsWith('Hi Sam,') && !/</.test(saved[0].content), 'HTML is turned into text when a message is saved');
  assert.strictEqual(saved[1].content, 'Is size < 5 ok?', 'a plain message is saved as written');

  // rows saved BEFORE the fix still hold HTML: they are shown clean when read
  stored = [{ ebayMessageId: 'old', content: ebayNotice, fromUsername: 'eBay', isSelf: false, readStatus: true, sentDate: new Date(), media: [] }];
  const read = await listMessages('u', 'c1');
  assert.ok(read[0].content.startsWith('Hi Sam,') && !/DOCTYPE/i.test(read[0].content), 'an old HTML row is shown as text');

  // the conversation list snippet (serialize) and the sync's own conversion
  stub('models/schemas/Conversation', { findOne: () => ({ select: () => ({ lean: async () => null }) }), findOneAndUpdate: async (q, doc) => ({ _id: 'x', ...doc, toObject() { return { ...doc, _id: 'x' }; } }) });
  stub('services/accountLabel', { accountLabel: () => '', publicUsername: () => '' });
  const conv = require('../models/conversationsModel');
  const out = await conv.upsertConversation('u', 'a', { conversationId: 'e1', subject: 's', conversationType: 'FROM_EBAY', lastMessageSnippet: ebayNotice, lastMessageDate: new Date() });
  assert.ok(out.last_message_snippet.startsWith('Hi Sam,') && !/</.test(out.last_message_snippet), 'the inbox preview is text');

  console.log('message text tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
