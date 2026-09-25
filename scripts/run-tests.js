// Runs every tests/*.test.js and reports which passed; the exit code is 1 if any failed.
//   npm test              all of them
//   npm test -- payment   only the files whose name contains "payment"
// Each test file gets its own process: they replace modules through require.cache, so they must not share one.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'tests');
const filter = process.argv[2];
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js') && (!filter || f.includes(filter))).sort();
if (!files.length) {
  console.error('No test file matches "' + filter + '".');
  process.exit(1);
}

const failed = [];
const started = Date.now();
for (const file of files) {
  const run = spawnSync(process.execPath, [path.join(dir, file)], { encoding: 'utf8', timeout: 120000 });
  const ok = run.status === 0;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + file);
  if (!ok) {
    failed.push(file);
    const out = ((run.stdout || '') + (run.stderr || '')).trim().split('\n').slice(-20).join('\n');
    console.log(out.replace(/^/gm, '      '));
  }
}
console.log('\n' + (files.length - failed.length) + ' of ' + files.length + ' test files passed in ' + Math.round((Date.now() - started) / 1000) + 's' + (failed.length ? '\nFAILED: ' + failed.join(', ') : ''));
process.exit(failed.length ? 1 : 0);
