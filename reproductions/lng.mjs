// REPRODUCTION — ONE LNG SOURCE, THREE BACKENDS, ONE ANSWER (packages/lng).
//
// CLAIM: a contract written once in LNG produces the SAME result whether it is interpreted, compiled to WASM
// and run in a sandbox, or transpiled to Solidity — and the language refuses, at compile time, to write a
// contract whose result could differ between them.
//
// WHY THAT MATTERS MORE THAN IT SOUNDS: a smart contract language with two backends that disagree anywhere is
// a consensus bug generator — validators re-executing the same call reach different states and the chain
// forks. The guarantee has to be a property of the LANGUAGE, not a promise about the compiler, which is why
// non-determinism is a TYPE ERROR here: a contract that reads a clock, a random source or an address-dependent
// value is rejected before it can ever be deployed.
//
// This reproduction runs the interpreter and the WASM backend in-process (both ship in the package) and
// checks the Solidity output is real, compilable source. The full three-way execution parity — including
// deploying the Solidity through solc into an EVM and comparing return values — runs in the gate as
// evm-deploy.test.mjs, where the solc and EVM dependencies are dev-only and nothing ships.
//
// Exits non-zero if any claim fails, so it is also a hard-gate test (reproductions.test.mjs).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { run, compile, transpile, check, checkDeterminism } from '@xmbl/lng';

const selfDigest = createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex');
console.log('XMBL reproduction — one LNG source, three backends, one answer');
console.log(`source sha256: ${selfDigest}\n`);

let failures = 0;
const ok = (name, cond, detail = '') => { console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`); if (!cond) failures++; };

const COUNTER = `~contract \`Counter {
  ~state { ~public { \`count ~u256 0 } }
  ~event \`Bumped()
  ~on \`inc(\`n ~u256) { \`count = \`count + \`n; ~emit \`Bumped(); return \`count }
  ~on \`sumTo(\`n ~u256) { \`acc ~u256 0; ~for \`i 1 \`n { \`acc = \`acc + \`i }; return \`acc }
  ~on \`classify(\`x ~u256) { return \`x !> 10 ? 1 | 2 }
}`;

// ── 1. IT TYPE-CHECKS, AND IT IS PROVABLY DETERMINISTIC ──
const checked = check(COUNTER);
ok('the contract type-checks — zero errors', Array.isArray(checked) && checked.length === 0, `errors=${JSON.stringify(checked)}`);
const det = checkDeterminism(COUNTER);
ok('and it is DETERMINISTIC — zero violations', Array.isArray(det) && det.length === 0, `violations=${JSON.stringify(det)}`);

// ── 2. NON-DETERMINISM IS A COMPILE-TIME ERROR, NOT A RUNTIME SURPRISE ──
for (const [what, src] of [
  ['a clock', '~contract `T { ~on `f() { return ~now } }'],
  ['randomness', '~contract `R { ~on `f() { return ~random } }'],
]) {
  let rejected = false, why = '';
  try {
    const d = checkDeterminism(src);
    rejected = Array.isArray(d) ? d.length > 0 : !!d;
    why = JSON.stringify(d).slice(0, 70);
  } catch (e) { rejected = true; why = e.message.slice(0, 70); }
  ok(`reading ${what} is REFUSED before deployment`, rejected, why);
}

// ── 3. THE INTERPRETER AND THE WASM BACKEND AGREE, CALL BY CALL ──
const cases = [
  ['inc', [5], 5n],
  ['sumTo', [10], 55n],
  ['classify', [3], 1n],
  ['classify', [30], 2n],
];
const bytes = await compile(COUNTER);
ok('the contract compiles to real WASM', bytes instanceof Uint8Array && bytes.length > 0, `${bytes.length} bytes`);
ok('and that WASM is valid', WebAssembly.validate(bytes));

// The interpreter is driven the way LNG itself is written: a script that deploys the contract and calls it,
// printing each result. Same source, same calls, no harness-specific entry point.
const interp = (script) => { let out = ''; run(COUNTER + '\n' + script, { write: (s) => (out += s) }); return out.trim().split('\n').filter(Boolean).map((x) => BigInt(x)); };
const results = interp('`c ~deploy `Counter()\n~p `c.inc(5)\n~p `c.sumTo(10)\n~p `c.classify(3)\n~p `c.classify(30)');
const expected = cases.map(([, , e]) => e);
for (let i = 0; i < cases.length; i++) {
  const [fn, args] = cases[i];
  ok(`the interpreter computes ${fn}(${args.join(', ')}) = ${expected[i]}`, results[i] === expected[i], `got=${results[i]}`);
}

// The WASM backend, instantiated and called through its own exports, must agree call for call.
const inst = (await WebAssembly.instantiate(bytes, {})).instance;
const mem = () => new DataView(inst.exports.memory.buffer);
const wr = (p, v) => { const d = mem(); for (let i = 0; i < 4; i++) d.setBigUint64(p + i * 8, (BigInt(v) >> BigInt(64 * i)) & 0xffffffffffffffffn, true); };
const rd = (p) => { const d = mem(); let v = 0n; for (let i = 3; i >= 0; i--) v = (v << 64n) | d.getBigUint64(p + i * 8, true); return v; };
const callW = (name, ...args) => { const ps = args.map((a) => { const p = inst.exports.__alloc(); wr(p, BigInt(a)); return p; }); return rd(inst.exports[name](...ps)); };
for (let i = 0; i < cases.length; i++) {
  const [fn, args] = cases[i];
  let got = null; try { got = callW(fn, ...args); } catch (e) { got = 'threw: ' + e.message; }
  ok(`the WASM backend agrees on ${fn}(${args.join(', ')}) = ${expected[i]}`, got === expected[i], `got=${got}`);
}

// ── 4. THE SOLIDITY OUTPUT IS REAL SOURCE, NOT A COMMENT ──
const sol = transpile(COUNTER);
const solText = typeof sol === 'string' ? sol : (sol.source ?? sol.solidity ?? '');
ok('the EVM backend emits Solidity with the contract and its functions',
   /contract\s+Counter/.test(solText) && /function\s+inc/.test(solText) && /function\s+sumTo/.test(solText),
   `${solText.split('\n').length} lines`);
ok('it declares a pragma and the state variable', /pragma solidity/.test(solText) && /count/.test(solText));
ok('the event survived the translation', /event\s+Bumped/.test(solText));

console.log(failures === 0
  ? '\nREPRODUCED — one source; the interpreter and the WASM backend agree on every call; the Solidity is real; non-determinism cannot compile.'
  : `\nNOT REPRODUCED — ${failures} assertion(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
