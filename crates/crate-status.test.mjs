// Regression guard for the cross-cutting Rust-crates gate (MAINNET-GATES.md § Cross-cutting):
// the eight Rust crates are primitive stubs that have NOT reached parity with the JS reference,
// so they MUST be labeled non-production in their crate docs before crates.io consumers rely on
// them. The gate offers "parity OR non-production label"; this closes it via the label branch and
// FAILS if any crate's label is removed (a label that can't fail is not a gate).
//
// The check: every crate's `src/lib.rs` carries the exact marker as a crate-level (`//!`) doc line,
// so `cargo doc` / docs.rs renders it at the top of the crate page — the place a consumer looks.
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MARKER = 'NON-PRODUCTION (pre-mainnet stub)';

let pass = 0, fail = 0;
const check = (n, f) => { try { f(); console.log(`  ok   ${n}`); pass++; } catch (e) { console.log(`  FAIL ${n}\n       ${e.message}`); fail++; } };

// Discover the crates from the filesystem, so a NEW crate added without a label also fails here
// (never a hardcoded list that silently misses a ninth crate).
const crateDirs = readdirSync(HERE, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name.startsWith('xmbl-'))
  .map((d) => d.name)
  .sort();

check('all eight Rust crates are present', () => {
  assert.strictEqual(crateDirs.length, 8, `expected 8 xmbl-* crates, found ${crateDirs.length}: ${crateDirs.join(', ')}`);
});

for (const c of crateDirs) {
  check(`crate ${c} is labeled non-production in its crate docs (//! ${MARKER})`, () => {
    const src = readFileSync(join(HERE, c, 'src', 'lib.rs'), 'utf8');
    const line = src.split('\n').find((l) => l.includes(MARKER));
    assert.ok(line, `${c}/src/lib.rs has no "${MARKER}" marker — the non-production label was removed`);
    assert.ok(line.trimStart().startsWith('//!'), `the marker in ${c} must be a crate-level //! doc line (rendered by cargo doc), got: ${line.trim()}`);
  });
}

console.log(`\nRust crate status labels: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
