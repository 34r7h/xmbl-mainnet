// Plain-node test runner for the protocol packages. Their suites are self-contained
// scripts (`*.test.mjs`/`*.test.js`) that assert and exit non-zero on failure — not
// jest — so CI needs something that actually runs them and fails the build when one
// fails. This is that something; it is the hard gate, deliberately with NO
// continue-on-error around it.
//
//   node scripts/run-node-tests.mjs <dir> [<dir> ...]
//
// Finds every test file under each dir (skipping node_modules), runs each in its own
// `node` process with a timeout, and exits 1 if ANY file fails or times out.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const PER_FILE_TIMEOUT_MS = 120_000;

function findTests(dir) {
  const out = [];
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    if (name === 'node_modules' || name === '.git') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...findTests(p));
    else if (/\.test\.(mjs|js)$/.test(name)) out.push(p);
  }
  return out;
}

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error('usage: run-node-tests.mjs <dir> [<dir> ...]');
  process.exit(2);
}

// Honest coverage: a dir with 0 test files contributes 0/0 and would otherwise be
// invisible in a "N/N passed" line, overstating how much is actually covered. List those
// dirs loudly so the gap is legible. They do not fail the build — the missing suites are
// tracked as open gates in MAINNET-GATES.md, not regressions — but they must not hide.
const empty = dirs.filter((d) => findTests(d).length === 0);
if (empty.length) {
  console.log('⚠ NO TEST FILES (tracked as open gates in MAINNET-GATES.md):');
  for (const d of empty) console.log('    ' + d);
  console.log('');
}

const files = dirs.flatMap(findTests).sort();
if (files.length === 0) {
  console.log('no test files found — nothing to run');
  process.exit(0);
}

let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, [f], { stdio: 'inherit', timeout: PER_FILE_TIMEOUT_MS });
  const ok = r.status === 0 && !r.error;
  if (!ok) {
    failed++;
    const why = r.error ? (r.error.code === 'ETIMEDOUT' ? 'TIMEOUT' : r.error.message) : `exit ${r.status}`;
    console.error(`\n✗ ${f} — ${why}`);
  }
}

console.log(`\nprotocol suites: ${files.length - failed}/${files.length} passed`);
process.exit(failed === 0 ? 0 : 1);
