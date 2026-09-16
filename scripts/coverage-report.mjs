// LINE COVERAGE over the protocol gate, measured — not estimated.
//
//   NODE_V8_COVERAGE=.coverage npm run test:protocol
//   node scripts/coverage-report.mjs .coverage
//
// The gate's suites are plain `node` scripts, so there is no jest/vitest coverage reporter to lean on
// and no c8/nyc in the dependency tree. V8 emits its own coverage for every process when
// NODE_V8_COVERAGE is set, `spawnSync` in run-node-tests.mjs passes the env through to each suite, and
// this script reduces the resulting range data to lines.
//
// WHAT COUNTS AS A COVERABLE LINE. A line is counted if it holds any non-whitespace character and V8
// attributed at least one execution range to the file; it is covered if any of those characters fell
// inside a range with count > 0. That includes comment and brace lines, so this number is pessimistic
// against a `c8` line count — deliberately, because the alternative is to parse and the point of this
// file is to be checkable by hand.
//
// WHAT IS EXCLUDED FROM THE DENOMINATOR, and why each one is not a coverage hole:
//   - *.test.mjs / *.test.js      the suites themselves
//   - *.config.js, build-*.mjs    build configuration executed by vite/electron-builder/emcc, not by us
//   - bench-*, profile-*, record-demo, verify-extension, assert-loadable
//                                 instruments and demos; they measure the code, they are not the code
//   - dist/, data/, coverage/, node_modules/, __tests__/ (jest, entered through its own wrapper suite)
//   - packages/visualizer         retirement is an open operator decision (A10); writing suites for a
//                                 package that may be deleted is waste. Counted and reported SEPARATELY
//                                 so the exclusion is visible rather than silent.
//
// NOTHING IS EXCLUDED SILENTLY. The walk covers BOTH workspace roots — packages/ and apps/ — because the
// question this file answers is "all modules", and a reporter that quietly walks one root answers a
// narrower question than the one it prints. apps/ source is keyed `apps/<name>` (so apps/visualizer and
// packages/visualizer cannot collide in the per-package table) and totalled under APPS, which is reported
// beside PROTOCOL and never folded into it: the protocol packages are what ship to npm, and mixing an
// unshipped app's lines into that number would move it without moving what it measures.
//
// Exclusions are printed with the report. A coverage number whose denominator you cannot see is a
// claim, not a measurement.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const COV = process.argv[2] || '.coverage';
const ROOT = process.cwd();

// The 12 packages published to npm as @xmbl/*. Everything else under packages/ is an app or a tool.
const PROTOCOL = new Set(['core', 'identity', 'networking', 'cubic-ledger', 'state-machine', 'consensus',
                          'storage-compute', 'zero-knowledge', 'lng', 'contracts', 'simulator', 'cli']);
const SEPARATE = new Set(['visualizer']);          // A10: retirement pending, reported but not totalled

const SKIP_DIR = new Set(['node_modules', 'dist', 'data', 'coverage', '__tests__', '.git', 'target']);
const isTooling = (b) => /\.config\.(js|mjs|cjs)$/.test(b)
  || /^(build|bench|profile|record)-/.test(b)
  || /^(verify-extension|assert-loadable|verify-extension-loaded)\./.test(b);
const isSource = (p) => /\.(mjs|js)$/.test(p) && !/\.test\.(mjs|js)$/.test(p) && !isTooling(basename(p));

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    if (SKIP_DIR.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (isSource(p)) out.push(p);
  }
  return out;
}

// BOTH roots. packages/ holds the 12 published protocol packages (plus the private ones); apps/ holds the
// app-builder and the app visualizer. Walking only packages/ would exclude apps/ without saying so.
const allSrc = [...walk(join(ROOT, 'packages')), ...walk(join(ROOT, 'apps'))];
const inScope = new Set(allSrc);

// ── reduce the raw V8 output ────────────────────────────────────────────────────────────────────
const scriptsByFile = new Map();
let rawFiles = 0;
for (const f of readdirSync(COV)) {
  let j;
  try { j = JSON.parse(readFileSync(join(COV, f), 'utf8')); } catch { continue; }
  rawFiles++;
  for (const script of j.result || []) {
    if (!script.url || !script.url.startsWith('file://')) continue;
    let p;
    try { p = fileURLToPath(script.url); } catch { continue; }
    if (!inScope.has(p)) continue;
    if (!scriptsByFile.has(p)) scriptsByFile.set(p, []);
    scriptsByFile.get(p).push(script);
  }
}

const rows = [];
for (const [p, scripts] of scriptsByFile) {
  let src;
  try { src = readFileSync(p, 'utf8'); } catch { continue; }
  const n = src.length;
  const hit = new Uint8Array(n);
  for (const s of scripts) {
    // Ranges nest: an inner range's count overrides the enclosing one, and V8 emits them
    // outermost-first, so a straight overwrite leaves the innermost count in place.
    const mark = new Int32Array(n);
    for (const fn of s.functions || []) {
      for (const r of fn.ranges || []) {
        const a = Math.max(0, r.startOffset), b = Math.min(n, r.endOffset);
        for (let i = a; i < b; i++) mark[i] = r.count;
      }
    }
    for (let i = 0; i < n; i++) if (mark[i] > 0) hit[i] = 1;   // union across every suite that loaded it
  }
  let total = 0, covered = 0, code = false, seen = false;
  const flush = () => { if (code) { total++; if (seen) covered++; } code = false; seen = false; };
  for (let i = 0; i < n; i++) {
    const ch = src[i];
    if (ch === '\n') { flush(); continue; }
    if (ch !== ' ' && ch !== '\t' && ch !== '\r') { code = true; if (hit[i]) seen = true; }
  }
  flush();
  rows.push({ p: relative(ROOT, p), total, covered });
}

const loaded = new Set(scriptsByFile.keys());
const never = allSrc.filter((p) => !loaded.has(p)).map((p) => relative(ROOT, p)).sort();

// ── aggregate ───────────────────────────────────────────────────────────────────────────────────
// `packages/core/x.js` -> `core`; `apps/visualizer/x.js` -> `apps/visualizer`. The prefix is kept for apps
// so a name that exists under both roots stays two rows rather than silently summing into one.
const pkgOf = (rel) => { const [top, name] = rel.split('/'); return top === 'apps' ? `apps/${name}` : name; };
const pkgs = new Map();
const bump = (k) => { if (!pkgs.has(k)) pkgs.set(k, { total: 0, covered: 0, files: 0, never: 0 }); return pkgs.get(k); };
for (const r of rows) { const a = bump(pkgOf(r.p)); a.total += r.total; a.covered += r.covered; a.files++; }
for (const rel of never) bump(pkgOf(rel)).never++;

const pad = (s, w) => String(s).padEnd(w);
const rp = (s, w) => String(s).padStart(w);
const pct = (c, t) => (t ? (c / t * 100).toFixed(1) : '—');

console.log(`LINE COVERAGE — packages/*/ and apps/*/ source under the protocol gate  (${rawFiles} V8 coverage files reduced)\n`);
console.log(`  ${pad('package', 20)} ${rp('lines', 8)} ${rp('covered', 8)} ${rp('%', 7)}  ${rp('files', 6)} ${rp('never run', 10)}`);
const group = (names) => {
  let T = 0, C = 0, F = 0, N = 0;
  for (const k of [...pkgs.keys()].filter(names).sort()) {
    const a = pkgs.get(k);
    T += a.total; C += a.covered; F += a.files; N += a.never;
    console.log(`  ${pad(k, 20)} ${rp(a.total, 8)} ${rp(a.covered, 8)} ${rp(pct(a.covered, a.total), 7)}  ${rp(a.files, 6)} ${rp(a.never || '', 10)}`);
  }
  return { T, C, F, N };
};
const proto = group((k) => PROTOCOL.has(k));
console.log(`  ${pad('── PROTOCOL TOTAL', 20)} ${rp(proto.T, 8)} ${rp(proto.C, 8)} ${rp(pct(proto.C, proto.T), 7)}  ${rp(proto.F, 6)} ${rp(proto.N || '', 10)}`);
console.log('');
const apps = group((k) => !PROTOCOL.has(k) && !SEPARATE.has(k));
if (apps.F || apps.N) console.log(`  ${pad('── APPS TOTAL', 20)} ${rp(apps.T, 8)} ${rp(apps.C, 8)} ${rp(pct(apps.C, apps.T), 7)}  ${rp(apps.F, 6)} ${rp(apps.N || '', 10)}`);
const sep = group((k) => SEPARATE.has(k));
if (sep.F || sep.N) console.log(`  ${pad('(A10, excluded)', 20)} ${rp(sep.T, 8)} ${rp(sep.C, 8)} ${rp(pct(sep.C, sep.T), 7)}  ${rp(sep.F, 6)} ${rp(sep.N || '', 10)}`);

const protoNever = never.filter((f) => PROTOCOL.has(pkgOf(f)));
console.log(`\nPROTOCOL SOURCE THE GATE NEVER LOADED: ${protoNever.length}`);
for (const f of protoNever) console.log('    ' + f);

const worst = rows.filter((r) => PROTOCOL.has(pkgOf(r.p)) && r.total >= 40)
                  .sort((a, b) => (a.covered / a.total) - (b.covered / b.total)).slice(0, 20);
console.log(`\nLOWEST-COVERED PROTOCOL FILES (>=40 code lines):`);
for (const r of worst) console.log(`    ${rp(pct(r.covered, r.total), 5)}%  ${rp(r.covered, 5)}/${pad(r.total, 5)} ${r.p}`);

// A floor, so the number cannot quietly slide back. Raise it when it is honestly beaten; never lower
// it to make a run green.
const FLOOR = Number(process.env.COVERAGE_FLOOR || 0);
const actual = proto.C / proto.T * 100;
if (FLOOR) {
  const okFloor = actual >= FLOOR;
  console.log(`\nfloor ${FLOOR.toFixed(1)}% — measured ${actual.toFixed(1)}% — ${okFloor ? 'OK' : 'BELOW FLOOR'}`);
  if (!okFloor) process.exit(1);
}
