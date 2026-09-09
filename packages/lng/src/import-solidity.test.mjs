// Solidity → LNG importer — proven by BEHAVIOR, not shape.
//   (A) ROUND-TRIP: LNG --transpile--> Solidity --importSolidity--> LNG, run through the
//       interpreter, must produce the SAME observable output as the original LNG.
//   (B) FORWARD: hand-written Solidity --import--> LNG --compile--> WASM, instantiated and
//       CALLED, must return the values the Solidity computes (measured from module memory).
//   (C) REFUSAL: unsupported Solidity (inheritance, structs, modifiers, while) is rejected
//       BY NAME, never silently mistranslated.
// Run: node import-solidity.test.mjs
import { importSolidity } from './import-solidity.js';
import { transpile } from './transpile-evm.js';
import { compile } from './compile-wasm.js';
import { run } from './lng.js';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('ok   ' + n); } else { fail++; console.log('FAIL ' + n); } };
const exec = (src) => { let b = ''; run(src, { write: (s) => (b += s) }); return b; };

// ---- WASM harness (import-free, u256 memory ABI — same as compile-wasm.test.mjs) ----
const MASK = (1n << 256n) - 1n;
function harness(lngSrc) {
  const bytes = compile(lngSrc);
  const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), {});
  const mem = new DataView(inst.exports.memory.buffer);
  const rd = (p) => { let v = 0n; for (let i = 0; i < 4; i++) v |= mem.getBigUint64(p + i * 8, true) << BigInt(i * 64); return v; };
  const wr = (p, v) => { v &= MASK; for (let i = 0; i < 4; i++) mem.setBigUint64(p + i * 8, (v >> BigInt(i * 64)) & ((1n << 64n) - 1n), true); };
  const call = (name, ...args) => { inst.exports.__reset(); const ps = args.map((a) => { const p = inst.exports.__alloc(); wr(p, BigInt(a)); return p; }); return rd(inst.exports[name](...ps)); };
  return { call, exports: inst.exports };
}

// =================== (A) ROUND-TRIP through Solidity ===================
// A contract the EVM backend fully supports, so transpile→import→run is a real closed loop.
const ORIG = `
~contract \`Bank {
  ~state { ~public { \`total ~u256 0 } ~private { \`risk ~u256 0 } }
  ~event \`Deposited(\`who ~address, \`amount ~u256)
  ~on \`deposit(\`who ~address, \`amount ~u256) { \`total = \`total + \`amount; ~emit \`Deposited(\`who, \`amount); return \`total }
  ~on \`sum(\`n ~u256) { \`acc ~u256 0; ~for \`i 1 \`n { \`acc = \`acc + \`i }; return \`acc }
  ~on \`classify(\`x ~u256) { return \`x !> 10 ? 1 | 2 }
}`;
const sol = transpile(ORIG);
const back = importSolidity(sol);
ok('import produces a ~contract block', /~contract `Bank/.test(back));

// Drive the ORIGINAL and the ROUND-TRIPPED contract identically; outputs must match.
const ME = "`me ~address '0x1111111111111111111111111111111111111111'\n";
const driver = "`b.deposit(`me, 500)\n~p `b.deposit(`me, 250)\n~p `b.total\n~p `b.sum(5)\n~p `b.classify(4)\n~p `b.classify(20)\n";
const deploy = (contract) => contract + '\n' + ME + '`b ~deploy `Bank()\n' + driver;
let origOut = '', backOut = '';
try { origOut = exec(deploy(ORIG)); } catch (e) { origOut = 'ERR:' + e.message; }
try { backOut = exec(deploy(back)); } catch (e) { backOut = 'ERR:' + e.message; }
ok('round-trip: deposit/sum/classify output matches the original LNG' + (origOut === backOut ? '' : ` (orig=${JSON.stringify(origOut)} back=${JSON.stringify(backOut)})`), origOut === backOut && origOut === '750\n750\n15\n1\n2\n');

// =================== (B) hand-written Solidity → LNG → WASM → run ===================
const SOL_COUNTER = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract Counter {
    uint256 public count = 0;
    event Bumped();
    function inc(uint256 n) public returns (uint256) {
        count = count + n;
        emit Bumped();
        return count;
    }
    function sumTo(uint256 n) public returns (uint256) {
        uint256 acc = 0;
        for (uint256 i = 1; i <= n; i++) { acc = acc + i; }
        return acc;
    }
    function classify(uint256 x) public returns (uint256) {
        if (x <= 10) { return 1; } else { return 2; }
    }
}`;
const lngFromSol = importSolidity(SOL_COUNTER);
ok('hand-written Solidity imports to an LNG contract', /~contract `Counter/.test(lngFromSol) && /~on `inc/.test(lngFromSol));
try {
  const H = harness(lngFromSol);
  ok('imported Solidity → WASM: inc(42) then inc(8) → 50 (real storage)', (H.call('inc', 42n), H.call('inc', 8n) === 50n));
  ok('imported Solidity → WASM: sumTo(10) → 55 (Solidity for-loop lowered to counted-for)', H.call('sumTo', 10n) === 55n);
  ok('imported Solidity → WASM: classify(4) → 1 (if/else → ternary)', H.call('classify', 4n) === 1n);
  ok('imported Solidity → WASM: classify(20) → 2', H.call('classify', 20n) === 2n);
  ok('imported Solidity → WASM emits no imports (mainnet-safe)', WebAssembly.Module.imports(new WebAssembly.Module(compile(lngFromSol))).length === 0);
} catch (e) { ok('imported Solidity compiles + runs (' + e.message + ')', false); }

// require(...) folds into a reverting guard: below the threshold the method errors, above it returns.
const SOL_REQ = `
contract Guarded {
  uint256 public v = 0;
  function setIfBig(uint256 x) public returns (uint256) {
    require(x >= 100, "too small");
    v = x;
    return v;
  }
}`;
const lngReq = importSolidity(SOL_REQ);
ok('require lowered to a guard (~e on the false branch)', /\? \{/.test(lngReq) && /~e 'too small'/.test(lngReq));
{
  const D = lngReq + "\n`g ~deploy `Guarded()\n";
  const okPath = exec(D + '~p `g.setIfBig(250)\n');
  ok('require pass path returns the value (setIfBig(250) → 250)', okPath === '250\n');
  // fail path: a failed require REVERTS the call in the interpreter (throws), exactly as the WASM
  // backend traps — the assignment `v = x` after the guard never runs, so state cannot change.
  let reverted = false, revMsg = '';
  try { exec(D + "`g.setIfBig(5)\n"); } catch (e) { reverted = true; revMsg = e.message || String(e); }
  ok('require fail path REVERTS the call (interpreter throws, agreeing with the WASM trap)', reverted && /too small/.test(revMsg));
}
// require() must ENFORCE ON-CHAIN, not only in the interpreter: it lowers to a WASM trap (`~e` →
// unreachable). A false precondition traps; a true one runs. Compiling in the interpreter alone is
// not enforcement — this asserts the WASM backend accepts it and the trap actually fires.
{
  let compiled = true, HH;
  try { HH = harness(lngReq); } catch { compiled = false; }
  ok('require() contract COMPILES to WASM (no ~e compile error)', compiled);
  if (compiled) {
    ok('require pass path on-chain: setIfBig(250) → 250', HH.call('setIfBig', 250n) === 250n);
    let trapped = false;
    try { HH.exports.__reset(); const p = HH.exports.__alloc(); const dv = new DataView(HH.exports.memory.buffer); dv.setBigUint64(p, 5n, true); HH.exports.setIfBig(p); } catch { trapped = true; }
    ok('require fail path on-chain TRAPS (setIfBig(5) reverts, not silently ignored)', trapped);
  }
}
// msg.value has no LNG/XCL equivalent: it must be REFUSED, never aliased to `caller (which would
// silently neuter a payable/price guard). This is the exact mistranslation an importer must not do.
refusesMsgValue();
function refusesMsgValue() {
  const PAY = 'contract P { uint256 public price; function buy() public { require(msg.value >= price, "underpaid"); } }';
  try { importSolidity(PAY); ok('REFUSES msg.value (but did not — silently mistranslated!)', false); }
  catch (e) { ok('REFUSES msg.value → ' + e.message.split('—')[0].trim().slice(0, 50), /msg\.value/.test(e.message)); }
  ok('msg.sender still maps to `caller (the correct lowering is kept)', /`caller/.test(importSolidity('contract S { address public o; function c() public { o = msg.sender; } }')));
}

// An imported if/ELSE with block branches must run the ELSE branch in BOTH backends — the
// interpreter's ternary else parses as a closure, so a naive lowering silently drops it. Both
// backends must agree the else path executes.
{
  const SOL_IE = 'contract E { uint256 public r; function pick(uint256 x) public returns (uint256) { if (x > 10) { r = 100; } else { r = 200; } return r; } }';
  const lngIE = importSolidity(SOL_IE);
  const HE = harness(lngIE);
  ok('imported if/else → WASM: pick(5) → 200 (else branch runs)', HE.call('pick', 5n) === 200n);
  ok('imported if/else → WASM: pick(50) → 100 (then branch runs)', HE.call('pick', 50n) === 100n);
  const DE = lngIE + "\n`e ~deploy `E()\n";
  ok('imported if/else → interpreter: pick(5) → 200 (else branch NOT silently skipped)', exec(DE + '~p `e.pick(5)\n') === '200\n');
  ok('imported if/else → interpreter: pick(50) → 100', exec(DE + '~p `e.pick(50)\n') === '100\n');
}

// =================== (C) refusals are explicit, never silent ===================
const refuses = (label, sol, needle) => {
  try { importSolidity(sol); ok('REFUSES ' + label + ' (but did not)', false); }
  catch (e) { ok('REFUSES ' + label + ' → ' + e.message.split('—')[0].trim().slice(0, 60), needle ? e.message.includes(needle) : true); }
};
refuses('inheritance', 'contract A is B { }', 'inheritance');
refuses('a struct member', 'contract A { struct S { uint256 x; } }', 'struct');
refuses('a while loop', 'contract A { function f() public { while (true) { } } }', 'while');
refuses('a function modifier', 'contract A { function f() public onlyOwner { } }', 'modifier');
refuses('array types', 'contract A { uint256[] xs; }', 'array');
// EVM-only globals: refused by name, never passed through to a 0/null or an opaque backend error.
refuses('block.timestamp', 'contract A { function f() public returns (uint256) { return block.timestamp; } }', 'block.timestamp');
refuses('tx.origin', 'contract A { function f() public returns (address) { return tx.origin; } }', 'tx.origin');
refuses('address(this).balance', 'contract A { function f() public returns (uint256) { return address(this).balance; } }', '.balance');
refuses('an ether transfer (.transfer)', 'contract A { function f(address payable to) public { to.transfer(1); } }', 'transfer');
refuses('gasleft()', 'contract A { function f() public returns (uint256) { return gasleft(); } }', 'gasleft');
refuses('keccak256()', 'contract A { function f() public returns (bytes32) { return keccak256("x"); } }', 'keccak256');

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
