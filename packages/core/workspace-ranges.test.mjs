// A WORKSPACE DEPENDENCY FLOOR BELOW THE LINE VERSION SHIPS A BROKEN RESOLVE.
//
// ⛔ MEASURED ON PUBLISHED 0.1.18, the release this suite was written for. `@xmbl/core@0.1.18` imports
// `sealChainKey` and `SUPPORTED_CHAINS` from `@xmbl/identity` — symbols that exist only from 0.1.18 — and
// declared `"@xmbl/identity": "^0.1.12"`. Installing that pair:
//
//     npm i @xmbl/core@0.1.18 @xmbl/identity@0.1.17
//     import('@xmbl/core/control-socket.js')
//     → SyntaxError: The requested module '@xmbl/identity' does not provide an export named 'SUPPORTED_CHAINS'
//
// The control socket is what a node daemon binds at startup, so that resolve is a node that cannot boot.
// It did not bite in practice only because npm happened to pick the newest satisfying version — a
// lockfile, a stale cache, an offline mirror or a deliberate pin all produce the failing pair from the
// range as declared, and the node bundle pins @xmbl/core EXACTLY while its transitive ranges float.
//
// These @xmbl/* packages are ONE VERSION LINE released in lockstep: every publish moves all of them, and
// a package never depends on an older sibling's behaviour. So the floor must BE the line. A caret still
// allows the newer patches a lockstep line produces; what it must not allow is an OLDER sibling.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('ok   ' + n); } else { fail++; console.log('FAIL ' + n); } };

const manifests = [];
for (const group of ['packages', 'apps']) {
  const dir = join(root, group);
  if (!existsSync(dir)) continue;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name, 'package.json');
    if (existsSync(p)) manifests.push({ path: `${group}/${name}/package.json`, json: JSON.parse(readFileSync(p, 'utf8')) });
  }
}
ok('every workspace manifest was found', manifests.length >= 15);

// The line is whatever the published packages say it is — read, never assumed, so this suite keeps
// working across bumps without being edited.
const line = manifests.find((m) => m.json.name === '@xmbl/core').json.version;
ok(`the line version reads from @xmbl/core (${line})`, /^\d+\.\d+\.\d+$/.test(line));

const cmp = (a, b) => {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
};

const offenders = [];
for (const { path, json } of manifests) {
  for (const field of ['dependencies', 'peerDependencies', 'devDependencies']) {
    for (const [dep, range] of Object.entries(json[field] || {})) {
      if (!dep.startsWith('@xmbl/')) continue;
      // `workspace:` and `*` resolve to the local package by construction and cannot select an older one.
      if (range.startsWith('workspace:') || range === '*') continue;
      const floor = range.replace(/^[\^~>=\s]+/, '');
      if (!/^\d+\.\d+\.\d+$/.test(floor)) { offenders.push(`${path} ${field}.${dep} = ${range} (unparseable floor)`); continue; }
      if (cmp(floor, line) < 0) offenders.push(`${path} ${field}.${dep} = ${range} — floor ${floor} is BELOW the line ${line}`);
    }
  }
}
ok(`no @xmbl workspace dependency has a floor below the line${offenders.length ? ':\n       ' + offenders.join('\n       ') : ''}`, offenders.length === 0);

// The specific pair that was broken, named so a regression is recognised rather than re-derived.
const coreDeps = manifests.find((m) => m.json.name === '@xmbl/core').json.dependencies;
ok('@xmbl/core requires an @xmbl/identity that actually exports the settlement surface',
  cmp(coreDeps['@xmbl/identity'].replace(/^\^/, ''), '0.1.19') >= 0);

// And the imports that made it load-bearing still come from there — if they move, this floor argument
// has to be re-made rather than silently inherited.
const socket = readFileSync(join(root, 'packages/core/control-socket.js'), 'utf8');
ok('control-socket.js still imports the settlement surface from @xmbl/identity',
  /import\s*\{[^}]*\bSUPPORTED_CHAINS\b[^}]*\}\s*from\s*'@xmbl\/identity'/.test(socket));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
