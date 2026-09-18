const fs = require('node:fs');
const assert = require('node:assert/strict');
const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'routes', 'auth.js'), 'utf8');

assert.match(source, /if \(!user\) return res\.status\(200\)\.json\(generic\);/);
assert.doesNotMatch(source, /if \(!user \|\| !user\.passwordHash\) return res\.status\(200\)\.json\(generic\);/);
assert.match(source, /sendPasswordResetOtp\(\{ to: email, code \}\)/);
assert.match(source, /user\.passwordHash = await hashPassword\(newPassword\)/);
console.log('Auth policy tests: PASS');
