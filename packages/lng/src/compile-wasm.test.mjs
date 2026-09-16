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

// ---- host-state (byte-pointer ABI) emission: OPT-IN, still mainnet-safe ----
// compile(src, {hostState:true}) makes `~u256` fields persist across calls through the XCL
// byte-pointer host ABI (env.xmbl_verkle_get/set). The DEFAULT compile() must stay import-free
// (the mainnet-safe gate below), so this is strictly opt-in.
{
  // A no-arg increment: `~u256` PARAMS arrive as memory pointers, so a literal `+ 1` isolates
  // the state path (arg marshalling is a separate concern owned by ContractHost).
  const HS_SRC = '~contract `HC { ~state { ~public { `count ~u256 0 } } ~on `inc() { `count = `count + 1; return `count } }';
  const HS = compile(HS_SRC, { hostState: true });
  const hmod = new WebAssembly.Module(HS);
  const imps = WebAssembly.Module.imports(hmod).map(i => i.module + '.' + i.name);
  ok('hostState: imports exactly env.xmbl_verkle_get + env.xmbl_verkle_set',
     imps.length === 2 && imps.includes('env.xmbl_verkle_get') && imps.includes('env.xmbl_verkle_set'));
  ok('hostState: default compile() is STILL import-free (opt-in did not leak)',
     WebAssembly.Module.imports(new WebAssembly.Module(compile(HS_SRC))).length === 0);

  // Cross-INSTANCE persistence: every call is a FRESH instance (fresh memory); only the shared
  // store carries over — the fresh-worker-per-call reality of the storage-compute deploy target.
  const store = new Map();
  const HX = '0123456789abcdef';
  const keyHex = (v, p, l) => { let k = ''; for (let j = 0; j < l; j++) k += HX[v[p + j] >> 4] + HX[v[p + j] & 15]; return k; };
  const runInc = () => {
    const ref = {};
    const host = { env: {
      xmbl_verkle_get: (kp, kl, vo) => { const v = new Uint8Array(ref.i.exports.memory.buffer); const s = store.get(keyHex(v, kp, kl)); for (let j = 0; j < 32; j++) v[vo + j] = s ? parseInt(s.slice(j * 2, j * 2 + 2), 16) : 0; return 0; },
      xmbl_verkle_set: (kp, kl, vp, vl) => { const v = new Uint8Array(ref.i.exports.memory.buffer); let val = ''; for (let j = 0; j < 32; j++) { const b = j < vl ? v[vp + j] : 0; val += HX[b >> 4] + HX[b & 15]; } store.set(keyHex(v, kp, kl), val); return 0; },
    } };
    ref.i = new WebAssembly.Instance(hmod, host);
    ref.i.exports.__reset();
    ref.i.exports.inc();
  };
  runInc(); runInc(); runInc();
  const stored = [...store.values()][0] || '';
  let count = 0n; for (let j = 0; j < 32; j++) count |= BigInt(parseInt(stored.slice(j * 2, j * 2 + 2) || '0', 16)) << BigInt(j * 8);
  ok('hostState: `count` persists across 3 FRESH instances → 3 (state only survived via the host)', count === 3n);

  // The opt-in module must ALSO clear the mainnet-safe memory gate.
  (async () => {
    const hm = await WebAssembly.compile(HS instanceof Uint8Array ? HS : Uint8Array.from(HS));
    let pp = 8, mf = null; const u = HS;
    const rdu = () => { let x = 0, s = 0, b; do { b = u[pp++]; x += (b & 0x7f) * (2 ** s); s += 7; } while (b & 0x80); return x; };
    while (pp < u.length) { const id = u[pp++]; const size = rdu(); const end = pp + size; if (id === 5) { rdu(); mf = u[pp]; break; } pp = end; }
    ok('hostState: emitted memory still declares a bounded maximum (mainnet-safe)', mf !== null && (mf & 0x01) === 0x01);
  })();
}

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

  // ---- compose: `xmbl.coord.send`/`read` lower to the env.xmbl_send/env.xmbl_read imports ----
  // Unit-level proof (no ContractHost): the compiler EMITS both imports (in a FIXED order — read,
  // then send) and passes word arguments by 32-byte little-endian POINTER, so a full 256-bit value
  // crosses by reference. The cascade/delivery/fail-closed outcomes are proven end-to-end in
  // @xmbl/contracts' contract-compose-lng test.
  const SENDER = "~contract `S { ~on `fire(`amount ~u256) { `xmbl.coord.send(0, `amount) } }";
  const smod = await WebAssembly.compile(Uint8Array.from(compile(SENDER, { compose: true })));
  const simports = WebAssembly.Module.imports(smod).map(i => i.module + '.' + i.name);
  ok('compose: module declares exactly env.xmbl_read + env.xmbl_send, read first',
     simports.length === 2 && simports[0] === 'env.xmbl_read' && simports[1] === 'env.xmbl_send');
  let seen = null; let sinst;
  const rdWord = (inst, ptr) => { const dv = new DataView(inst.exports.memory.buffer); let v = 0n; for (let i = 3; i >= 0; i--) v = (v << 64n) | dv.getBigUint64(ptr + i * 8, true); return v; };
  const wrWord = (inst, ptr, val) => { const dv = new DataView(inst.exports.memory.buffer); let v = val; for (let i = 0; i < 4; i++) { dv.setBigUint64(ptr + i * 8, v & ((1n << 64n) - 1n), true); v >>= 64n; } };
  sinst = await WebAssembly.instantiate(smod, { env: {
    xmbl_read: () => { throw new Error('sender should not read'); },
    // xmbl_send is now (peer_ptr, args_ptr, arg_count): the args are a contiguous block of 32-byte
    // words at args_ptr. A single-arg send passes arg_count == 1 and its word at args_ptr.
    xmbl_send: (peerPtr, argsPtr, argCount) => { seen = { peer: rdWord(sinst, peerPtr), amount: rdWord(sinst, argsPtr), count: argCount }; return 0; },
  } });
  const AMT = (1n << 130n) + 9n;   // exceeds 2^128: a truncated payload could not equal it
  sinst.exports.__reset();
  const ap = sinst.exports.__alloc();
  wrWord(sinst, ap, AMT);
  sinst.exports.fire(ap);
  ok('compose: xmbl_send received peer index 0, arg_count 1, and the full 256-bit amount by pointer',
     seen !== null && seen.peer === 0n && seen.amount === AMT && seen.count === 1);

  // multi-arg send: `xmbl.coord.send(0, a, b)` packs TWO contiguous 32-byte words at args_ptr and
  // passes arg_count == 2. The second word sits at args_ptr + 32 — proving the contiguous block.
  const SENDER2ARG = "~contract `S2 { ~on `fire(`a ~u256, `b ~u256) { `xmbl.coord.send(0, `a, `b) } }";
  const s2mod = await WebAssembly.compile(Uint8Array.from(compile(SENDER2ARG, { compose: true })));
  let seen2 = null; let s2inst;
  s2inst = await WebAssembly.instantiate(s2mod, { env: {
    xmbl_read: () => { throw new Error('sender should not read'); },
    xmbl_send: (peerPtr, argsPtr, argCount) => { seen2 = { peer: rdWord(s2inst, peerPtr), count: argCount, a: rdWord(s2inst, argsPtr), b: rdWord(s2inst, argsPtr + 32) }; return 0; },
  } });
  const AV = (1n << 200n) + 5n, BV = (1n << 90n) + 7n;   // distinct, both > 2^64
  s2inst.exports.__reset();
  const pa = s2inst.exports.__alloc(); wrWord(s2inst, pa, AV);
  const pb = s2inst.exports.__alloc(); wrWord(s2inst, pb, BV);
  s2inst.exports.fire(pa, pb);
  ok('compose: a two-arg send passes arg_count 2 and both full 256-bit words in a contiguous block',
     seen2 !== null && seen2.peer === 0n && seen2.count === 2 && seen2.a === AV && seen2.b === BV);

  // read: the backend allocates a result buffer, passes (peer_ptr, field_ptr, val_out_ptr), and the
  // method's return value IS that buffer pointer — so a stub that writes a known word into val_out
  // is observed, by reference, as the method result. Exceeds 2^128 to pin full-width marshalling.
  const READER = "~contract `R { ~on `get() { return `xmbl.coord.read(0, 0) } }";
  const rmod = await WebAssembly.compile(Uint8Array.from(compile(READER, { compose: true })));
  const RVAL = (1n << 200n) + 123n;
  let rinst; let readArgs = null;
  rinst = await WebAssembly.instantiate(rmod, { env: {
    xmbl_read: (peerPtr, fieldPtr, valOutPtr) => { readArgs = { peer: rdWord(rinst, peerPtr), field: rdWord(rinst, fieldPtr) }; wrWord(rinst, valOutPtr, RVAL); return 0; },
    xmbl_send: () => { throw new Error('reader should not send'); },
  } });
  rinst.exports.__reset();
  const retPtr = rinst.exports.get();
  ok('compose: xmbl_read received peer 0 / field 0 and its returned word is the full 256-bit value',
     readArgs !== null && readArgs.peer === 0n && readArgs.field === 0n && rdWord(rinst, retPtr) === RVAL);

  // ────────────────────────────────────────────────────────────────────────────
  // ~bytes (B1) — THE ONE MISSING LANGUAGE FEATURE. A 256-bit word cannot carry a message or a UTXO id,
  // so every host call that takes a (pointer, length) pair was unreachable from LNG source and the
  // contracts that used them had to be hand-assembled. A ~bytes value is that pair: literal bytes from a
  // data segment with a compile-time length, or bytes the host writes back with the length in a local.
  // ────────────────────────────────────────────────────────────────────────────
  const refused = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };
  const bytesOf = (inst, p, l) => Array.from(new Uint8Array(inst.exports.memory.buffer.slice(p, p + l)));

  // The forms that have NOWHERE to carry a length are refused, never silently compiled as a word. Before
  // this, both produced a valid module in which the ~bytes annotation simply evaporated.
  ok('~bytes FIELD is refused with a reason (it used to compile silently as a 256-bit word)',
     /~bytes field `x has nowhere to carry its length/.test(refused(() => compile("~contract `S { ~state { ~public { `x ~bytes 0 } } ~on `f(){ return 1 } }")) || ''));
  ok('~bytes PARAM is refused with a reason (it used to compile silently as a 256-bit word)',
     /~bytes param `b has nowhere to carry its length/.test(refused(() => compile("~contract `S { ~on `f(`b ~bytes){ return 1 } }")) || ''));
  ok('a ~bytes literal in arithmetic position is still a hard error (a byte string is not a number)',
     refused(() => compile("~contract `S { ~on `f(){ return '0x01' + 1 } }")) !== null);
  ok('xmbl.utxo.input_id(i) has no word form and says so',
     /has no 256-bit word form/.test(refused(() => compile("~contract `T { ~on `n() { return `xmbl.utxo.input_id(0) } }", { utxo: true })) || ''));

  // Opt-in, exactly like hostState and compose: the DEFAULT module must stay import-free, and a contract
  // with no byte literals must emit the SAME bytes it emitted before ~bytes existed (the blob region is
  // zero-sized, so the 32-byte literal pool keeps its old base).
  const PLAIN = "~contract `C { ~on `f(`a ~u256) { return `a + 1 } }";
  ok('~bytes did not move the literal pool: a contract with no byte literals is unchanged (import-free, 5598 bytes)',
     compile(PLAIN).length === 5598 && WebAssembly.Module.imports(new WebAssembly.Module(compile(PLAIN))).length === 0);
  ok('crypto/utxo are opt-in: xmbl.mayo.verify without { crypto: true } is refused',
     /requires compile\(src, \{ crypto: true \}\)/.test(refused(() => compile("~contract `V { ~on `c() { return `xmbl.mayo.verify('0x01') } }")) || ''));
  ok('xmbl.mayo.verify(msg, sig, pk) — the interpreter arity — is an arity error on-chain, not a silent drop',
     /chain-staged, not guest-supplied/.test(refused(() => compile("~contract `V { ~on `c() { return `xmbl.mayo.verify('0x01','s','p') } }", { crypto: true })) || ''));

  // The literal's bytes reach the host EXACTLY: the import sees (ptr, len) pointing at the source bytes.
  {
    const V = new WebAssembly.Module(compile("~contract `V { ~on `check() { return `xmbl.mayo.verify('0xdeadbeef') } }", { crypto: true }));
    ok('crypto: imports exactly the two §3.1 verifiers',
       WebAssembly.Module.imports(V).map((i) => i.module + '.' + i.name).join(',') === 'env.xmbl_cubic_sig_verify,env.xmbl_mayo_verify');
    let seen = null; let inst;
    inst = new WebAssembly.Instance(V, { env: { xmbl_cubic_sig_verify: () => 0, xmbl_mayo_verify: (p, l) => { seen = bytesOf(inst, p, l); return 1; } } });
    inst.exports.__reset();
    const one = rdWord(inst, inst.exports.check());
    ok('~bytes literal: the host received the EXACT four bytes of the source literal', seen !== null && seen.join(',') === '222,173,190,239');
    let inst0; inst0 = new WebAssembly.Instance(V, { env: { xmbl_cubic_sig_verify: () => 0, xmbl_mayo_verify: () => 0 } });
    inst0.exports.__reset();
    ok('crypto: a 1 verdict becomes the word 1 and a 0 verdict becomes the word 0 (never a pointer mistaken for truth)',
       one === 1n && rdWord(inst0, inst0.exports.check()) === 0n);
    // A UTF-8 literal is carried as its bytes — a UTXO recipient is an ASCII string on the wire, not a digest.
    let seenU; let instU;
    instU = new WebAssembly.Instance(new WebAssembly.Module(compile("~contract `V { ~on `check() { return `xmbl.mayo.verify('BENEF01') } }", { crypto: true })),
      { env: { xmbl_cubic_sig_verify: () => 0, xmbl_mayo_verify: (p, l) => { seenU = new TextDecoder().decode(new Uint8Array(instU.exports.memory.buffer.slice(p, p + l))); return 1; } } });
    instU.exports.__reset(); instU.exports.check();
    ok('~bytes literal: a non-hex literal is carried as its UTF-8 bytes', seenU === 'BENEF01');
  }

  // Bytes the contract could NOT have known at compile time: the caller presents the UTXO, the host writes
  // its id back, and the contract spends by that id — the whole reason a runtime ~bytes value must exist.
  {
    const SPEND = "~contract `T { ~on `go() { `amt `xmbl.utxo.spend(`xmbl.utxo.input_id(0))\n `xmbl.utxo.create('BENEF01', `amt)\n return `amt } }";
    const M = new WebAssembly.Module(compile(SPEND, { utxo: true }));
    ok('utxo: imports exactly the five value-ABI entries, in the ABI order',
       WebAssembly.Module.imports(M).map((i) => i.name).join(',') === 'xmbl_input_count,xmbl_input_id,xmbl_utxo_amount,xmbl_utxo_spend,xmbl_utxo_create');
    const ID = 'abc123def4567890';                       // a 16-hex-char ledger block id
    let spent = null, created = null, inst;
    const env = {
      xmbl_input_count: () => 1,
      xmbl_input_id: (i, out) => { if (i !== 0) return -1; const v = new Uint8Array(inst.exports.memory.buffer); for (let k = 0; k < ID.length; k++) v[out + k] = ID.charCodeAt(k); return ID.length; },
      xmbl_utxo_amount: () => 0n,
      xmbl_utxo_spend: (p, l) => { spent = new TextDecoder().decode(new Uint8Array(inst.exports.memory.buffer.slice(p, p + l))); return 100n; },
      xmbl_utxo_create: (p, l, amt) => { created = [new TextDecoder().decode(new Uint8Array(inst.exports.memory.buffer.slice(p, p + l))), amt]; return 0n; },
    };
    inst = new WebAssembly.Instance(M, { env });
    inst.exports.__reset();
    const amt = rdWord(inst, inst.exports.go());
    ok('utxo: the contract spent the id the HOST supplied, not one it was compiled with', spent === ID);
    ok('utxo: the i64 amount was widened to the full 256-bit word', amt === 100n);
    ok('utxo: create received the literal recipient and the spent amount', created !== null && created[0] === 'BENEF01' && created[1] === 100n);

    // THE -1 SENTINEL. Widened to an unsigned word it reads as 2^256-1, indistinguishable from an enormous
    // legitimate amount — a contract could "spend" a UTXO it does not hold and carry the error on as money.
    // Both failure forms therefore TRAP.
    let bad; bad = new WebAssembly.Instance(M, { env: { ...env, xmbl_utxo_spend: () => -1n,
      xmbl_input_id: (i, out) => { new Uint8Array(bad.exports.memory.buffer)[out] = 65; return 1; } } });
    bad.exports.__reset();
    ok('utxo: a -1 spend TRAPS — it never becomes 2^256-1', (() => { try { bad.exports.go(); return false; } catch { return true; } })());
    let oob; oob = new WebAssembly.Instance(M, { env: { ...env, xmbl_input_id: () => -1 } });
    oob.exports.__reset();
    ok('utxo: an input index the caller never presented TRAPS (fail-closed)', (() => { try { oob.exports.go(); return false; } catch { return true; } })());
  }

  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})();
