// The browser build of @xmbl/lng IS the node build — one source, one artifact, no hand copies anywhere.
//
// XMBL is modular: every user of LNG (a node, a web panel, an extension, a bundler) IMPORTS this module and
// gets the same language. This gate holds that property by counts:
//   1. dist/lng.browser.js is byte-identical to a fresh build from src/*.js (the artifact cannot drift);
//   2. it carries no Node built-in (node:, require, Buffer, import.meta) — browser-loadable by construction;
//   3. its export surface and VERSION equal index.js's — the browser gets exactly what the node exports;
//   4. the SAME programs produce the SAME bytes through both: interpreter output, WASM bytes, Solidity
//      text, type diagnostics, determinism refusals (with the same message), Solidity→LNG import;
//   5. it runs inside a bare V8 context with NO process/Buffer/require (what a browser is), and the WASM it
//      emits there validates and instantiates.
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { pathToFileURL } from 'node:url';
import { buildBrowserBundle, BROWSER_BUNDLE } from '../build-browser.mjs';
import * as node from '../index.js';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('ok   ' + name); } else { fail++; console.log('FAIL ' + name); } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const bytesEq = (a, b) => a.length === b.length && Array.from(a).every((x, i) => x === b[i]);
const collect = (mod, src) => { let out = ''; let err = null; try { mod.run(src, { write: (s) => (out += s) }); } catch (e) { err = e.message; } return { out, err }; };
const refusal = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

// ── 1. no drift ──
const committed = readFileSync(BROWSER_BUNDLE, 'utf8');
ok('dist/lng.browser.js is byte-identical to a fresh build from src/*.js', committed === buildBrowserBundle());

// ── 2. browser-loadable by construction ──
ok("bundle references no 'node:' built-in", !/['"]node:/.test(committed));
ok('bundle has no require("…") of a module', !/\brequire\s*\(\s*['"]/.test(committed));
ok('bundle has no import.meta', !/import\.meta/.test(committed));
ok('bundle has no Buffer usage', !/\bBuffer\s*\.|new\s+Buffer\b/.test(committed));
ok('bundle has no bare import statements (single file, no fetches)', !/^import\s/m.test(committed));

// ── 3. same surface ──
const browser = await import(pathToFileURL(BROWSER_BUNDLE).href);
ok('export surface identical to index.js: ' + Object.keys(node).sort().join(','), same(Object.keys(browser).sort(), Object.keys(node).sort()));
ok('VERSION identical (' + node.VERSION + ')', browser.VERSION === node.VERSION && typeof node.VERSION === 'string');

// ── 4. same programs → same bytes ──
const PROGRAMS = [
  ['hello', "~p 'Hello, World!'", 'Hello, World!\n'],
  ['sum', "`a (1,2,3,4,5)\n`s 0\n`a ~for ~as `x { `s = `s + `x }\n~p `s", '15\n'],
  ['fn-class', "`pt(`x, `y) {(`x `x, `y `y)}\n`p `pt(3, 4)\n~p `p.x\n~p `p.y", '3\n4\n'],
  ['ternary-chain', "`g 72\n`g !< 90 ? {~p 'A'} | `g !< 70 ? {~p 'B'} | {~p 'C'}", 'B\n'],
  ['revert', "~p 'a'\n~e 'boom'\n~p 'b'", null],
];
for (const [name, src, want] of PROGRAMS) {
  const b = collect(browser, src), n = collect(node, src);
  ok(`run ${name}: browser output == node output` + (want !== null ? ' == expected' : ' (both throw the same revert)'),
    same(b, n) && (want === null ? b.err !== null : b.out === want));
}

const CONTRACT = `~contract \`Counter {
  ~state { ~public { \`count ~u256 0 } }
  ~on \`inc(\`n ~u256) { \`count = \`count + \`n; ~emit \`Bumped(); return \`count }
  ~on \`classify(\`x ~u256) { \`x !> 10 ? {\`count = \`count + 1} | {\`count = \`count + 2}; return \`count }
}`;
const wasmB = browser.compile(CONTRACT), wasmN = node.compile(CONTRACT);
ok(`compile: identical WASM bytes (${wasmN.length} bytes)`, wasmB.length > 8 && bytesEq(wasmB, wasmN));
ok('compile (hostState): identical WASM bytes', bytesEq(browser.compile(CONTRACT, { hostState: true }), node.compile(CONTRACT, { hostState: true })));
ok('compile (compose): identical WASM bytes', bytesEq(browser.compile(CONTRACT, { compose: true }), node.compile(CONTRACT, { compose: true })));
ok('transpile: identical Solidity text', browser.transpile(CONTRACT) === node.transpile(CONTRACT) && /contract Counter/.test(node.transpile(CONTRACT)));
ok('contractFields: identical', same(browser.contractFields(CONTRACT), node.contractFields(CONTRACT)));
const TYPED = "`a ~u8 300; `b ~decimal 1.5; `c ~u256 (`b + 1); `d ~u256 1.5";
ok('check: identical diagnostics (' + node.check(TYPED).length + ')', same(browser.check(TYPED), node.check(TYPED)) && node.check(TYPED).length > 0);
const NONDET = "~contract `T { ~state { ~public { `t ~u256 0 } } ~on `tick() { `t = `time.now(); return `t } }";
ok('checkDeterminism: identical findings', same(browser.checkDeterminism(NONDET), node.checkDeterminism(NONDET)));
const rB = refusal(() => browser.compile(NONDET)), rN = refusal(() => node.compile(NONDET));
ok('determinism gate refuses with the SAME message on both sides', rB !== null && rB === rN);
const rBe = refusal(() => browser.transpile(NONDET)), rNe = refusal(() => node.transpile(NONDET));
ok('EVM backend refuses non-determinism with the SAME message on both sides', rBe !== null && rBe === rNe);
const SOL = `pragma solidity ^0.8.20;
contract Counter {
    uint256 public count = 0;
    function inc(uint256 n) public returns (uint256) { count = count + n; return count; }
    function classify(uint256 x) public returns (uint256) { if (x <= 10) { return 1; } else { return 2; } }
}`;
ok('importSolidity: identical LNG text', browser.importSolidity(SOL) === node.importSolidity(SOL) && /~contract `Counter/.test(node.importSolidity(SOL)));
ok('importSolidity → compile: identical WASM bytes', bytesEq(browser.compile(browser.importSolidity(SOL)), node.compile(node.importSolidity(SOL))));

// ── 5. a browser-like realm: no process, no Buffer, no require — the artifact runs and its WASM is real ──
const logged = [];
const ctx = createContext({ TextEncoder, console: { log: (s) => logged.push(s) } });
ok('bare context has no process / Buffer / require', runInContext('[typeof process, typeof Buffer, typeof require].join()', ctx) === 'undefined,undefined,undefined');
let api = null, loadErr = null;
try {
  // The bundle is an ES module; a bare vm context evaluates scripts, so the `export const` surface lines
  // become plain declarations and are handed back on the context. Nothing else changes.
  runInContext(committed.replace(/^export const /gm, 'const ') + '\nglobalThis.__lng = { run, compile, transpile, check, importSolidity, VERSION };', ctx, { filename: 'lng.browser.js' });
  api = ctx.__lng;
} catch (e) { loadErr = e.message; }
ok('bundle evaluates in the bare context' + (loadErr ? ' (' + loadErr + ')' : ''), api !== null);
if (api) {
  let out = '';
  api.run("~p 'Hello, World!'", { write: (s) => (out += s) });
  ok('interpreter runs in the bare context', out === 'Hello, World!\n');
  api.run("~p 'to-console'");
  ok('default sink in a browser is the console (no process.stdout to reach for)', logged.join('|') === 'to-console');
  const bytes = api.compile(CONTRACT);
  ok('WASM compiled in the bare context is byte-identical to the node build', bytesEq(bytes, wasmN));
  const valid = runInContext('(b) => WebAssembly.validate(b)', ctx)(bytes);
  ok('that WASM validates in the bare context', valid === true);
  const inst = runInContext('(b) => new WebAssembly.Instance(new WebAssembly.Module(b), {})', ctx)(bytes);
  ok('…and instantiates with NO imports (mainnet-safe default)', typeof inst.exports.inc === 'function' && typeof inst.exports.classify === 'function');
  ok('Solidity transpiles in the bare context', /contract Counter/.test(api.transpile(CONTRACT)));
  ok('Solidity imports in the bare context', /~contract `Counter/.test(api.importSolidity(SOL)));
  ok('VERSION in the bare context', api.VERSION === node.VERSION);
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
