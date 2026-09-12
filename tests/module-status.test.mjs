// Regression guard for the cross-cutting "every module" program (MODULE-STATUS.md).
//
// The operator's standing requirement is that NO module is left unaccounted for: every package,
// app, and crate must have a row in MODULE-STATUS.md stating whether it is working, tested, and
// reproducible in a miniapp. This test discovers those units from the FILESYSTEM (never a hardcoded
// list that silently misses a new one) and FAILS if any unit has no row — so a module cannot be
// added, renamed, or forgotten without the ledger being updated to match.
//
// It deliberately does NOT assert that every module is "done": that is the work the ledger tracks,
// not an invariant to enforce here (a gate that can't fail is not a gate, and a gate that fails for
// honest in-progress work would only pressure someone to lie in the ledger). What it enforces is
// that the ledger is COMPLETE and HONEST about coverage.
import assert from 'node:assert';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const LEDGER = join(ROOT, 'MODULE-STATUS.md');

let pass = 0, fail = 0;
const check = (n, f) => { try { f(); console.log(`  ok   ${n}`); pass++; } catch (e) { console.log(`  FAIL ${n}\n       ${e.message}`); fail++; } };

const ledger = readFileSync(LEDGER, 'utf8');

// Discover every unit from the filesystem: package dirs, app dirs, and xmbl-* crate dirs.
const dirsIn = (rel, filter = () => true) => {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { withFileTypes: true })
    .filter((d) => d.isDirectory() && filter(d.name))
    .map((d) => `${rel}/${d.name}`)
    .sort();
};

const units = [
  ...dirsIn('packages'),
  ...dirsIn('apps'),
  ...dirsIn('crates', (n) => n.startsWith('xmbl-')),
];

check(`ledger lists at least one unit and the filesystem has units to cover`, () => {
  assert.ok(units.length >= 20, `expected >=20 units, found ${units.length}: ${units.join(', ')}`);
});

for (const u of units) {
  check(`MODULE-STATUS.md has a row for ${u}`, () => {
    // A row cites the unit as a backtick-quoted path, e.g. `packages/core`.
    assert.ok(ledger.includes('`' + u + '`'),
      `no row in MODULE-STATUS.md for "${u}" — add it (working / tested / miniapp reproduction)`);
  });
}

// Symmetric guard: every backtick-quoted packages//apps//crates path IN the ledger must still exist
// on disk, so a deleted/renamed module can't leave a stale row claiming coverage.
const citedPaths = [...ledger.matchAll(/`((?:packages|apps|crates)\/[A-Za-z0-9_.-]+)`/g)]
  .map((m) => m[1]);
for (const p of [...new Set(citedPaths)]) {
  check(`ledger path ${p} still exists on disk`, () => {
    assert.ok(existsSync(join(ROOT, p)), `MODULE-STATUS.md cites "${p}" but it does not exist — stale row`);
  });
}

console.log(`\nmodule-status ledger: ${pass} passed, ${fail} failed (${units.length} units discovered)`);
process.exit(fail === 0 ? 0 : 1);
