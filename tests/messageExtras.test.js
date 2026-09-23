// Buyer profile parsing (Trading API GetUser) and attachment sanitising for the Messages page.
const assert = require('node:assert/strict');
const { parseBuyerProfile } = require('../services/ebayBuyerProfileService');
const { sanitizeAttachments } = require('../services/messageAttachmentService');

const xml = `<?xml version="1.0"?><GetUserResponse><Ack>Success</Ack><User>
  <UserID>johndoe123</UserID><FeedbackScore>412</FeedbackScore><FeedbackRatingStar>Turquoise</FeedbackRatingStar>
  <RegistrationDate>2018-03-14T09:21:00.000Z</RegistrationDate><Site>UK</Site></User></GetUserResponse>`;
const p = parseBuyerProfile(xml);
assert.equal(p.feedbackScore, 412);
assert.equal(p.starColor, 'Turquoise');
assert.equal(p.site, 'United Kingdom');
assert.equal(p.memberSince.getUTCFullYear(), 2018);

// A masked/limited response (fields missing) must not throw or invent values.
const empty = parseBuyerProfile('<GetUserResponse><Ack>Success</Ack><User><UserID>x</UserID></User></GetUserResponse>');
assert.equal(empty.feedbackScore, null);
assert.equal(empty.memberSince, null);
assert.equal(empty.site, null);

// Only our own hosted HTTPS image/PDF files pass, capped at 5 - the client is not trusted.
const own = (n, type = 'IMAGE') => ({ name: `f${n}.jpg`, type, url: `https://api.example.com/uploads/listing-images/u1/messages/${n}.jpg` });
const cleaned = sanitizeAttachments([
  own(1), own(2, 'PDF'),
  { name: 'evil', type: 'IMAGE', url: 'https://evil.example/x.jpg' },
  { name: 'http', type: 'IMAGE', url: 'http://api.example.com/uploads/listing-images/u1/messages/h.jpg' },
  { name: 'exe', type: 'EXE', url: 'https://api.example.com/uploads/listing-images/u1/messages/e.exe' },
  own(3), own(4), own(5), own(6), own(7),
]);
assert.equal(cleaned.length, 5);
assert.ok(cleaned.every((a) => a.url.startsWith('https://api.example.com/uploads/listing-images/')));
assert.deepEqual(sanitizeAttachments(undefined), []);

console.log('message extras tests passed');
