// Gate runner for the auditor reproductions (reproductions/README.md).
//
// Each reproduction is a standalone .mjs with an auditor-facing name (run directly with `node`), so
// it is NOT named *.test.mjs and the protocol runner would skip it. This file bridges that: it
// DISCOVERS every reproduction from the filesystem, runs each in its own `node` process, and asserts
// exit 0 — so a reproduction whose claim regresses fails the hard gate, and a NEW reproduction is
// enforced automatically (no hardcoded list to forget to update).
import assert from 'node:assert';
import { readdirSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const SELF = basename(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const check = (n, f) => { try { f(); console.log(`  ok   ${n}`); pass++; } catch (e) { console.log(`  FAIL ${n}\n       ${e.message}`); fail++; } };

const reproductions = readdirSync(HERE)
  .filter((f) => f.endsWith('.mjs') && f !== SELF && !f.endsWith('.test.mjs'))
  .filter((f) => statSync(join(HERE, f)).isFile())
  .sort();

check('at least one reproduction exists', () => {
  assert.ok(reproductions.length >= 1, `no reproductions found in ${HERE}`);
});

for (const f of reproductions) {
  check(`reproduction ${f} reproduces its claim (exit 0)`, () => {
    const r = spawnSync(process.execPath, [join(HERE, f)], { encoding: 'utf8', timeout: 60_000 });
    assert.ok(!r.error, `${f} failed to run: ${r.error && r.error.message}`);
    assert.strictEqual(r.status, 0, `${f} exited ${r.status}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`);
  });
}

console.log(`\nreproductions: ${pass} passed, ${fail} failed (${reproductions.length} reproductions)`);
process.exit(fail === 0 ? 0 : 1);
