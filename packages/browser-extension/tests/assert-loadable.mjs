// LOADABLE INVARIANT for the XMBL browser extension (packages/browser-extension).
//
// Chrome refuses to load an unpacked extension if ANY path component in the loaded tree begins with
// `_` (reserved), except the special `_locales`, `_metadata`, `_platform_specific` dirs — the exact
// rule in Chromium's extensions/common/file_util.cc (CheckForIllegalFilenames). That is a pure
// filename predicate, so this guard enforces precisely what Chrome enforces, deterministically and
// with no browser. (Confirmed empirically: headless Chrome-for-Testing's CLI --load-extension does NOT
// surface this error, so a browser-automation check cannot verify it — the filename scan is the
// faithful outcome check, and the operator's own "Load unpacked" is the final word.)
//
// This is the regression guard for the `__tests__/` + `_harness.html` load failure (those were renamed
// to tests/ and harness.html): re-introducing any `_`-prefixed file anywhere under the package — at the
// root or nested, committed source or built dist/ — fails this, and `npm test`, loudly.
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = dirname(dirname(fileURLToPath(import.meta.url))); // tests/ → package root
const ALLOW = new Set(['_locales', '_metadata', '_platform_specific']); // Chrome's reserved-but-allowed dirs
const SKIP = new Set(['node_modules', '.git']); // not part of the loaded extension tree

const offenders = [];
let scanned = 0;
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    scanned++;
    if (name.startsWith('_') && !ALLOW.has(name)) offenders.push(full.slice(PKG.length + 1));
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full);
  }
};
walk(PKG);

const distPresent = existsSync(join(PKG, 'dist'));
if (!distPresent) console.warn('  note: dist/ absent — built output not covered in this run (npm run verify:extension builds then re-runs this guard)');

if (offenders.length) {
  console.error(`\n❌ RESERVED-NAME VIOLATION — Chrome will refuse "Load unpacked" (${offenders.length} entr${offenders.length === 1 ? 'y' : 'ies'}):`);
  for (const o of offenders) console.error('   _-prefixed: ' + o);
  console.error('   Chrome reserves `_`-prefixed names (except _locales/_metadata/_platform_specific). Rename these.');
  process.exit(1);
}
console.log(`✅ loadable — 0 reserved (_-prefixed) entries across ${scanned} tree entries${distPresent ? ' (incl. built dist/)' : ''}`);
process.exit(0);
