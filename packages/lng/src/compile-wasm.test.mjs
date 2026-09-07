// XCL/WASM backend tests — import-free module, full 256-bit integers.
// Grounded in vendor/xmbl-node/xvsm/src/wasm-execution.js: the executor instantiates with
// NO imports, so these modules declare none. State + values live in the module's own memory;
// the harness marshals 256-bit BigInts in/out and FUZZES the in-module ALU against BigInt.
import { compile } from './compile-wasm.js';
const MASK = (1n << 256n) - 1n;
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('ok   ' + name); } else { fail++; console.log('FAIL ' + name); } };

function harness(src) {
  const bytes = compile(src);
  const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), {}); // NO imports
  const mem = new DataView(inst.exports.memory.buffer);
  const rd = (p) => { let v = 0n; for (let i = 0; i < 4; i++) v |= mem.getBigUint64(p + i * 8, true) << BigInt(i * 64); return v; };
  const wr = (p, v) => { v &= MASK; for (let i = 0; i < 4; i++) mem.setBigUint64(p + i * 8, (v >> BigInt(i * 64)) & ((1n << 64n) - 1n), true); };
  const call = (name, ...args) => { inst.exports.__reset(); const ps = args.map(a => { const p = inst.exports.__alloc(); wr(p, BigInt(a)); return p; }); return rd(inst.exports[name](...ps)); };
  const traps = (name, ...args) => { try { call(name, ...args); return false; } catch { return true; } };
  return { call, traps, exports: inst.exports, size: bytes.length };
}

// no imports declared → module links with bare instantiate (as the executor does)
let C;
try { C = harness("~contract `C { ~on `id(`a ~u256) { return `a } }"); ok('import-free module instantiates with NO import object', true); }
catch (e) { ok('import-free module instantiates (' + e.message + ')', false); }

// ---- ALU fuzz against BigInt (the whole point of u256) ----
const ALU = `~contract \`A {
  ~on \`add(\`a ~u256, \`b ~u256) { return \`a + \`b }
  ~on \`sub(\`a ~u256, \`b ~u256) { return \`a - \`b }
  ~on \`mul(\`a ~u256, \`b ~u256) { return \`a * \`b }
  ~on \`div(\`a ~u256, \`b ~u256) { return \`a / \`b }
  ~on \`mod(\`a ~u256, \`b ~u256) { return \`a % \`b }
  ~on \`and(\`a ~u256, \`b ~u256) { return \`a b& \`b }
  ~on \`or(\`a ~u256, \`b ~u256) { return \`a b| \`b }
  ~on \`xor(\`a ~u256, \`b ~u256) { return \`a b^ \`b }
  ~on \`shl(\`a ~u256, \`b ~u256) { return \`a b< \`b }
  ~on \`shr(\`a ~u256, \`b ~u256) { return \`a b> \`b }
}`;
try {
  const A = harness(ALU);
  const rnd = () => { let v = 0n; for (let i = 0; i < 4; i++) v = (v << 64n) | BigInt(Math.floor(Math.random() * 2 ** 32)) << 32n | BigInt(Math.floor(Math.random() * 2 ** 32)); return v & MASK; };
  let bad = [];
  for (let t = 0; t < 200; t++) {
    const a = rnd(), b = rnd();
    if (A.call('and', a, b) !== (a & b)) bad.push('and');
    if (A.call('or', a, b) !== (a | b)) bad.push('or');
    if (A.call('xor', a, b) !== (a ^ b)) bad.push('xor');
    if (((a + b) <= MASK) && A.call('add', a, b) !== a + b) bad.push('add');
    if (a >= b && A.call('sub', a, b) !== a - b) bad.push('sub');
    const sh = b % 200n; // keep shift bounded so the loop is quick
    if (A.call('shl', a, sh) !== ((a << sh) & MASK)) bad.push('shl@' + sh);
    if (A.call('shr', a, sh) !== (a >> sh)) bad.push('shr@' + sh);
    if (b !== 0n) { if (A.call('div', a, b) !== a / b) bad.push('div'); if (A.call('mod', a, b) !== a % b) bad.push('mod'); }
    // mul with bounded operands so products fit 256 bits
    const ma = a >> 128n, mb = b >> 128n; if (A.call('mul', ma, mb) !== ((ma * mb) & MASK)) bad.push('mul');
  }
  bad = [...new Set(bad)];
  ok('ALU matches BigInt over 200 random cases (add sub mul div mod and or xor shl shr)', bad.length === 0);
  if (bad.length) console.log('   mismatched:', bad.join(', '));

  // specific 256-bit landmarks
  const big = 1n << 100n;
  ok('2^100 + 2^100 = 2^101', A.call('add', big, big) === (big << 1n));
  ok('2^100 * 2^100 = 2^200', A.call('mul', big, big) === (1n << 200n));
  ok('(2^256-1) / 3 exact', A.call('div', MASK, 3n) === MASK / 3n);
  ok('(2^256-1) % 7 exact', A.call('mod', MASK, 7n) === MASK % 7n);
  ok('overflow traps: (2^256-1)+1', A.traps('add', MASK, 1n));
  ok('underflow traps: 3-5', A.traps('sub', 3n, 5n));
  ok('mul overflow traps: 2^200*2^200', A.traps('mul', 1n << 200n, 1n << 200n));
  ok('div by zero traps', A.traps('div', 6n, 0n));
} catch (e) { ok('ALU contract runs (' + e.message + ')', false); }

// ---- storage, control flow, events ----
const COUNTER = `~contract \`Counter {
  ~state { ~public { \`count ~u256 0 } }
  ~event \`Bumped()
  ~on \`inc(\`n ~u256) { \`count = \`count + \`n; ~emit \`Bumped(); return \`count }
  ~on \`sumTo(\`n ~u256) { \`acc ~u256 0; ~for \`i 1 \`n { \`acc = \`acc + \`i }; return \`acc }
  ~on \`classify(\`x ~u256) { return \`x !> 10 ? 1 | 2 }
}`;
try {
  const K = harness(COUNTER);
  ok('storage write: inc(5) → 5', K.call('inc', 5n) === 5n);
  ok('storage read+write persists: inc(3) → 8', K.call('inc', 3n) === 8n);
  ok('counted for: sumTo(5) → 15', K.call('sumTo', 5n) === 15n);
  ok('counted for: sumTo(10) → 55', K.call('sumTo', 10n) === 55n);
  ok('ternary → if/else: classify(4) → 1', K.call('classify', 4n) === 1n);
  ok('ternary → if/else: classify(20) → 2', K.call('classify', 20n) === 2n);
  K.exports.__reset(); K.call('inc', 1n);
  ok('~emit bumps the exported event counter', K.exports.__events() >= 1);
} catch (e) { ok('COUNTER runs (' + e.message + ')', false); }

// ---- overload mangling (distinct exports) ----
try {
  const OV = harness("~contract `Ov { ~on `f(`a ~u256){ return `a } ~on `f(`a ~u256, `b ~u256){ return `a + `b } }");
  ok('overloads → distinct exports f__1 / f__2', OV.call('f__1', 7n) === 7n && OV.call('f__2', 7n, 8n) === 15n);
} catch (e) { ok('overload contract runs (' + e.message + ')', false); }

// ---- signed / decimal are rejected (not silently wrong) ----
ok('signed ~i256 field rejected', (() => { try { compile("~contract `S { ~state { ~public { `x ~i256 0 } } ~on `f(){ return 1 } }"); return false; } catch { return true; } })());
ok('~decimal rejected', (() => { try { compile("~contract `D { ~state { ~public { `x ~decimal 1 } } ~on `f(){ return 1 } }"); return false; } catch { return true; } })());

// ---- mainnet-safety of the emitted module (pins the deploy reality) ----
// The old fake WASMExecutor is gone; the deploy target is @xmbl/storage-compute's hardened
// runtime, which REFUSES an unbounded-memory or import-carrying guest. So the compiler must
// emit a module that clears those gates. Asserted here with only the WebAssembly API, so the
// LNG stays standalone (the full ContractHost path is tested in @xmbl/contracts).
(async () => {
  const bytes = compile(COUNTER);
  const u8 = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  const mod = await WebAssembly.compile(u8);
  ok('compiled contract imports nothing (no ambient host access)',
     WebAssembly.Module.imports(mod).length === 0);
  // Memory section (id 5): flags bit0 must be set → a bounded maximum is declared.
  let p = 8, memFlags = null;
  const uleb = () => { let x = 0, s = 0, b; do { b = u8[p++]; x += (b & 0x7f) * (2 ** s); s += 7; } while (b & 0x80); return x; };
  while (p < u8.length) { const id = u8[p++]; const size = uleb(); const end = p + size; if (id === 5) { uleb(); memFlags = u8[p]; break; } p = end; }
  ok('emitted memory declares a bounded maximum (mainnet-safe)', memFlags !== null && (memFlags & 0x01) === 0x01);

  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})();
