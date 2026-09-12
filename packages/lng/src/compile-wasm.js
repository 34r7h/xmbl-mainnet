/*
 * LNG → WASM compiler (XCL backend) — full 256-bit integers; import-free by default,
 * with an OPT-IN Verkle-backed state mode.
 *
 * DEPLOY TARGET: @xmbl/storage-compute's hardened ComputeRuntime, driven by @xmbl/contracts'
 * ContractHost. That runtime is deny-by-default on imports and REFUSES unbounded memory, so
 * this backend emits a module with a BOUNDED memory maximum and — in the DEFAULT mode — NO
 * imports at all:
 *   - values are unsigned 256-bit integers, 32 little-endian bytes (4×i64 limbs) in memory;
 *   - the full ALU (add sub mul div mod cmp and or xor not shl shr) is emitted WASM, fuzzed
 *     against BigInt in the compile-wasm test;
 *   - checked overflow / underflow / ÷0 → `unreachable` (a trap = the interpreter's revert);
 *   - state fields live at fixed 32-byte slots in memory (persist for the INSTANCE lifetime);
 *   - `~emit` bumps an exported event counter (coordinator host binding is future work).
 * Exports: entrypoints, `memory`, `__alloc()`, `__reset()`, `__field(i)`, `__events()`.
 *
 * HOST-STATE MODE — `compile(src, { hostState: true })`: emits the XCL byte-pointer state ABI
 * (agentic-contracts-proto.md §3.1) so a `~u256` field PERSISTS ACROSS CALLS through Verkle
 * instead of living only in per-instance memory. The module then imports env.xmbl_verkle_get/
 * set (indices 0/1); every entrypoint loads its fields from the host on entry and flushes each
 * field to the host immediately on assignment (so early `return` never drops a write). This is
 * strictly opt-in: the default stays import-free so it still clears the deny-by-default runtime
 * on the raw market path. The §3.1 crypto host calls (cubic_sig/mayo/lwe verify) are NOT
 * emitted — see abi.js for why (sync host imports vs async MAYO; eval'd-source growth).
 * NOTE: `~u256` PARAMS still arrive as memory pointers; passing plain-int args through
 * ContractHost is a separate, unbuilt marshalling concern.
 *
 * Signed integer types (~i8..~i256) and ~decimal are REJECTED with a clear error (the
 * interpreter and EVM backend support them; this backend is unsigned-only) — never silently
 * mis-computed.
 *
 * API:    import { compile } from '@xmbl/lng';  // compile(src, opts?) -> Uint8Array (WASM)
 */
import { lex, parse, INT_WIDTHS } from './lng.js';
import { assertDeterministic } from './typecheck.js';
// ---- binary encoding ----
function uleb(n) { n = BigInt(n); const b = []; do { let x = Number(n & 0x7Fn); n >>= 7n; if (n !== 0n) x |= 0x80; b.push(x); } while (n !== 0n); return b; }
function sleb(n) { n = BigInt(n); const b = []; let more = true; while (more) { let byte = Number(n & 0x7Fn); n >>= 7n; if ((n === 0n && (byte & 0x40) === 0) || (n === -1n && (byte & 0x40) !== 0)) more = false; else byte |= 0x80; b.push(byte); } return b; }
function vec(items) { return [...uleb(items.length), ...items.flat()]; }
function section(id, payload) { return [id, ...uleb(payload.length), ...payload]; }
function nm(s) { const b = [...Buffer.from(s, 'utf8')]; return [...uleb(b.length), ...b]; }
const I32 = 0x7F, I64 = 0x7E;
const O = {
  unreachable: 0x00, block: 0x02, loop: 0x03, if: 0x04, else: 0x05, end: 0x0b, br: 0x0c, br_if: 0x0d, ret: 0x0f, call: 0x10, drop: 0x1a,
  lget: 0x20, lset: 0x21, gget: 0x23, gset: 0x24,
  i32load: 0x28, i64load: 0x29, i32store: 0x36, i64store: 0x37,
  i32const: 0x41, i64const: 0x42,
  i32eqz: 0x45, i32ne: 0x47, i32lts: 0x48, i32gts: 0x4a, i32ges: 0x4e,
  i64eqz: 0x50, i64ne: 0x52, i64ltu: 0x54,
  i32add: 0x6a, i32sub: 0x6b, i32mul: 0x6c, i32and: 0x71, i32or: 0x72, i32shru: 0x76,
  i64add: 0x7c, i64sub: 0x7d, i64mul: 0x7e, i64and: 0x83, i64or: 0x84, i64xor: 0x85, i64shl: 0x86, i64shru: 0x88,
  i64extendi32u: 0xad, i32wrapi64: 0xa7,
};
const m64 = (off) => [0x03, ...uleb(off)];
const m32 = (off) => [0x02, ...uleb(off)];

const SLOT = 32;
const SCRATCH_BASE = 16;              // 16 i64 mul accumulators (128 bytes) — full product
const LIT_BASE = SCRATCH_BASE + 128;

function compile(src, opts = {}) {
  assertDeterministic(src, 'WASM compile');
  const ast = parse(lex(src));
  const c = ast.body.find(n => n.kind === 'contract');
  if (!c) throw new Error('no ~contract found to compile');

  // hostState (opt-in): emit the XCL byte-pointer state ABI so committed state persists
  // across calls through Verkle. DEFAULT stays import-free and byte-identical — the mainnet
  // -safe gate (no imports, bounded memory) must not regress. When on, the module imports
  // env.xmbl_verkle_get/set at indices 0/1, so EVERY defined-function index shifts by
  // IMPORT_COUNT (imports occupy the low indices). We carry that shift through `fi` below.
  const hostState = !!(opts && opts.hostState);
  // compose (opt-in): emit the XCL word-ABI composition primitives so a contract can interact with
  // another contract from `~contract` source — env.xmbl_read (synchronous cross-contract read) and
  // env.xmbl_send (asynchronous message). Imports occupy the LOW function indices, so the state
  // imports (if any) come first and the compose imports come AFTER them — every defined function
  // index is shifted by the TOTAL import count. The two compose imports are pushed in a FIXED order
  // (read, then send) and BOTH indices derive from the same base, so a swapped pair can never
  // silently miscompile (a wrong index yields a valid module calling the wrong function).
  const compose = !!(opts && opts.compose);
  const COMPOSE_BASE = hostState ? 2 : 0;   // compose imports sit just above the state imports
  const READ_IDX = COMPOSE_BASE;            // env.xmbl_read is first
  const SEND_IDX = COMPOSE_BASE + 1;        // env.xmbl_send follows it
  const IMPORT_COUNT = COMPOSE_BASE + (compose ? 2 : 0);

  const bad = (t, w) => { if (t && (t in INT_WIDTHS) && INT_WIDTHS[t][0]) throw new Error(`WASM backend is unsigned-only: signed ~${t} ${w} unsupported (use the EVM backend)`); if (t === 'decimal') throw new Error(`WASM backend does not support ~decimal ${w} (use the EVM backend)`); };
  for (const f of c.fields) bad(f.type, `field \`${f.name}`);
  for (const mth of c.methods) for (const p of mth.params) bad(p.type, `param \`${p.name}`);

  const slot = new Map(); c.fields.forEach((f, i) => slot.set(f.name, i));
  const lits = new Map();
  const lit = (v) => { v = BigInt(v); if (v < 0n) v = (1n << 256n) + v; if (!lits.has(v)) lits.set(v, LIT_BASE + lits.size * SLOT); return lits.get(v); };
  const Z = lit(0n), ONE = lit(1n), ONES = lit((1n << 256n) - 1n);
  for (const mth of c.methods) gatherLits(mth.body.body, lit);
  // State-field byte keys (hostState only) live in a data region between the literal pool
  // and the field storage, so the guest can pass (key_ptr, key_len) to the host ABI. Each
  // field's key is its own UTF-8 name; per-contract namespacing is the host's job (byteKey).
  const KEYS_BASE = LIT_BASE + lits.size * SLOT;
  const keyPtr = [], keyLen = [], keyBytes = [];
  if (hostState) {
    let off = KEYS_BASE;
    for (const f of c.fields) {
      const kb = [...Buffer.from(f.name, 'utf8')];
      keyPtr.push(off); keyLen.push(kb.length); keyBytes.push(...kb); off += kb.length;
    }
  }
  const KEYS_SIZE = hostState ? Math.ceil(keyBytes.length / SLOT) * SLOT : 0;
  const FIELD_BASE = KEYS_BASE + KEYS_SIZE;   // == LIT_BASE + lits.size*SLOT when !hostState
  const EVENTS_ADDR = FIELD_BASE + c.fields.length * SLOT;
  const HEAP_BASE = EVENTS_ADDR + 8;

  const types = []; const tmap = new Map();
  const T = (p, r) => { const t = [0x60, ...vec(p), ...vec(r)]; const k = t.join(','); if (!tmap.has(k)) { tmap.set(k, types.length); types.push(t); } return tmap.get(k); };
  const T_v_i32 = T([], [I32]), T_v = T([], []), T_1 = T([I32], [I32]), T_2 = T([I32, I32], [I32]), T_2n = T([I32, I64], [I32]);

  const H = {}; let fi = IMPORT_COUNT;   // defined functions start ABOVE the imported ones
  ['alloc', 'add', 'sub', 'cmp', 'and', 'or', 'xor', 'not', 'shl', 'shr', 'mul', 'div', 'mod', 'isz', 'reset', 'field', 'events', 'frombool'].forEach(h => H[h] = fi++);
  const ENTRY0 = fi;
  const defined = [];
  const F = (ti, locals, code) => defined.push({ ti, locals, code });

  F(T_v_i32, [], [O.gget, ...uleb(0), O.gget, ...uleb(0), O.i32const, ...sleb(SLOT), O.i32add, O.gset, ...uleb(0), O.end]);
  F(T_2, [I32, I64, I64, I64, I64, I64], addSub(true, H));
  F(T_2, [I32, I64, I64, I64, I64, I64], addSub(false, H));
  F(T_2, [], cmpBody());
  F(T_2, [I32], bitBody(O.i64and, H));
  F(T_2, [I32], bitBody(O.i64or, H));
  F(T_2, [I32], bitBody(O.i64xor, H));
  F(T_1, [I32], notBody(H));
  F(T_2n, [I32], shiftBody(true, H));
  F(T_2n, [I32], shiftBody(false, H));
  F(T_2, [I32, I64, I64], mulBody(H));
  F(T_2, [I32, I32, I32], divBody(H, ONE, Z));
  F(T_2, [], modBody(H));                 // mod = a - (a/b)*b
  F(T_1, [], iszBody());
  F(T_v, [], [O.i32const, ...sleb(HEAP_BASE), O.gset, ...uleb(0), O.end]);
  F(T_1, [], [O.i32const, ...sleb(FIELD_BASE), O.lget, 0, O.i32const, ...sleb(SLOT), O.i32mul, O.i32add, O.end]);
  F(T_v_i32, [], [O.i32const, ...sleb(EVENTS_ADDR), O.i64load, ...m64(0), O.i32wrapi64, O.end]);
  F(T_1, [], [O.lget, 0, O.if, I32, O.i32const, ...sleb(ONE), O.else, O.i32const, ...sleb(Z), O.end, O.end]);

  const nameCount = {}; for (const mth of c.methods) nameCount[mth.name] = (nameCount[mth.name] || 0) + 1;
  const used = {};
  const finalName = (mth) => { let b = nameCount[mth.name] > 1 ? `${mth.name}__${mth.params.length}` : mth.name; while (used[b]) b += '_'; used[b] = 1; return b; };
  const exports = [];
  c.methods.forEach((mth, mi) => {
    const ti = T(new Array(mth.params.length).fill(I32), [I32]);
    const built = compileMethod(mth, { slot, FIELD_BASE, lit, Z, ONE, ONES, H, EVENTS_ADDR,
      fields: c.fields.length,
      hostState: hostState ? { vget: 0, vset: 1, keyPtr, keyLen } : null,
      compose: compose ? { readIdx: READ_IDX, sendIdx: SEND_IDX } : null });
    F(ti, built.locals, built.code);
    exports.push([...nm(finalName(mth)), 0x00, ...uleb(ENTRY0 + mi)]);
  });

  // Import types (hostState only) — registered after the method types so the default path's
  // type section is untouched. get: (i32,i32,i32)->i32; set: (i32,i32,i32,i32)->i32.
  const T_get = hostState ? T([I32, I32, I32], [I32]) : 0;
  const T_set = hostState ? T([I32, I32, I32, I32], [I32]) : 0;
  // xmbl_read is (peer_ptr, field_ptr, val_out_ptr)->i32. Registered unconditionally when compose
  // is on (NOT gated on hostState) so the stateless-compose path has a live type index — T()
  // deduplicates, so it collapses onto T_get's shape when hostState is also on.
  const T_read = compose ? T([I32, I32, I32], [I32]) : 0;
  const typeSec = section(1, vec(types));
  // Import entries in the SAME order the indices were assigned: state imports (0,1), then the
  // compose imports read THEN send — so READ_IDX / SEND_IDX above match these entries' positions.
  // xmbl_read is T_read (i32,i32,i32)->i32; xmbl_send is the already-registered T_2 shape.
  const importEntries = [];
  if (hostState) {
    importEntries.push([...nm('env'), ...nm('xmbl_verkle_get'), 0x00, ...uleb(T_get)]);
    importEntries.push([...nm('env'), ...nm('xmbl_verkle_set'), 0x00, ...uleb(T_set)]);
  }
  if (compose) {
    importEntries.push([...nm('env'), ...nm('xmbl_read'), 0x00, ...uleb(T_read)]);
    importEntries.push([...nm('env'), ...nm('xmbl_send'), 0x00, ...uleb(T_2)]);
  }
  const importSec = importEntries.length ? section(2, vec(importEntries)) : [];
  const funcSec = section(3, vec(defined.map(f => uleb(f.ti))));
  // Memory: 16 pages min (1 MiB), with a BOUNDED maximum. A contract that ships to the
  // storage-compute market must declare a hard maximum — an unbounded memory is refused by
  // the hardened runtime (an untrusted guest may not grow without limit). 256 pages (16 MiB)
  // is generous for on-chain contract state and well within the default compute caps.
  const MEM_MIN_PAGES = 16, MEM_MAX_PAGES = 256;
  const memSec = section(5, vec([[0x01, ...uleb(MEM_MIN_PAGES), ...uleb(MEM_MAX_PAGES)]]));
  const globalSec = section(6, vec([[I32, 0x01, O.i32const, ...sleb(HEAP_BASE), O.end]]));
  exports.push([...nm('memory'), 0x02, ...uleb(0)], [...nm('__alloc'), 0x00, ...uleb(H.alloc)], [...nm('__reset'), 0x00, ...uleb(H.reset)], [...nm('__field'), 0x00, ...uleb(H.field)], [...nm('__events'), 0x00, ...uleb(H.events)]);
  const exportSec = section(7, vec(exports));
  const codeSec = section(10, vec(defined.map(f => { const body = [...vec(groupLocals(f.locals)), ...f.code]; return [...uleb(body.length), ...body]; })));
  const litBytes = [];
  [...lits.entries()].sort((a, b) => a[1] - b[1]).forEach(([v]) => { for (let i = 0; i < 32; i++) litBytes.push(Number((v >> BigInt(i * 8)) & 0xffn)); });
  const dataSegs = [];
  if (lits.size) dataSegs.push([0x00, O.i32const, ...sleb(LIT_BASE), O.end, ...uleb(litBytes.length), ...litBytes]);
  if (hostState && keyBytes.length) dataSegs.push([0x00, O.i32const, ...sleb(KEYS_BASE), O.end, ...uleb(keyBytes.length), ...keyBytes]);
  const dataSec = dataSegs.length ? section(11, vec(dataSegs)) : [];
  return Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, ...typeSec, ...importSec, ...funcSec, ...memSec, ...globalSec, ...exportSec, ...codeSec, ...dataSec]);
}

// ===== helper bodies (a=0,b=1) =====
function addSub(isAdd, H) {
  const co = [O.call, ...uleb(H.alloc), O.lset, 2, O.i64const, 0, O.lset, 3];
  for (let i = 0; i < 4; i++) {
    co.push(O.lget, 0, O.i64load, ...m64(i * 8), O.lset, 4, O.lget, 1, O.i64load, ...m64(i * 8), O.lset, 5);
    if (isAdd) {
      co.push(O.lget, 4, O.lget, 5, O.i64add, O.lset, 6, O.lget, 6, O.lget, 3, O.i64add, O.lset, 7);
      co.push(O.lget, 2, O.lget, 7, O.i64store, ...m64(i * 8));
      co.push(O.lget, 6, O.lget, 4, O.i64ltu, O.lget, 7, O.lget, 6, O.i64ltu, O.i32or, O.i64extendi32u, O.lset, 3);
    } else {
      co.push(O.lget, 4, O.lget, 5, O.i64sub, O.lset, 6, O.lget, 6, O.lget, 3, O.i64sub, O.lset, 7);
      co.push(O.lget, 2, O.lget, 7, O.i64store, ...m64(i * 8));
      co.push(O.lget, 4, O.lget, 5, O.i64ltu, O.lget, 6, O.lget, 3, O.i64ltu, O.i32or, O.i64extendi32u, O.lset, 3);
    }
  }
  co.push(O.lget, 3, O.i64eqz, O.i32eqz, O.if, 0x40, O.unreachable, O.end, O.lget, 2, O.end);
  return co;
}
function cmpBody() {
  const co = [];
  for (let i = 3; i >= 0; i--) {
    co.push(O.lget, 0, O.i64load, ...m64(i * 8), O.lget, 1, O.i64load, ...m64(i * 8), O.i64ne, O.if, 0x40);
    co.push(O.lget, 0, O.i64load, ...m64(i * 8), O.lget, 1, O.i64load, ...m64(i * 8), O.i64ltu, O.if, I32, O.i32const, ...sleb(-1), O.else, O.i32const, ...sleb(1), O.end, O.ret, O.end);
  }
  co.push(O.i32const, 0, O.end);
  return co;
}
function bitBody(op, H) {
  const co = [O.call, ...uleb(H.alloc), O.lset, 2];
  for (let i = 0; i < 4; i++) co.push(O.lget, 2, O.lget, 0, O.i64load, ...m64(i * 8), O.lget, 1, O.i64load, ...m64(i * 8), op, O.i64store, ...m64(i * 8));
  co.push(O.lget, 2, O.end); return co;
}
function notBody(H) {
  const co = [O.call, ...uleb(H.alloc), O.lset, 1];
  for (let i = 0; i < 4; i++) co.push(O.lget, 1, O.lget, 0, O.i64load, ...m64(i * 8), O.i64const, ...sleb(-1), O.i64xor, O.i64store, ...m64(i * 8));
  co.push(O.lget, 1, O.end); return co;
}
function shiftBody(left, H) {
  const co = [O.call, ...uleb(H.alloc), O.lset, 2];
  for (let i = 0; i < 4; i++) co.push(O.lget, 2, O.lget, 0, O.i64load, ...m64(i * 8), O.i64store, ...m64(i * 8));
  co.push(O.block, 0x40, O.loop, 0x40, O.lget, 1, O.i64eqz, O.br_if, ...uleb(1));
  if (left) {
    for (let i = 3; i >= 1; i--) co.push(O.lget, 2, O.lget, 2, O.i64load, ...m64(i * 8), O.i64const, 1, O.i64shl, O.lget, 2, O.i64load, ...m64((i - 1) * 8), O.i64const, 63, O.i64shru, O.i64or, O.i64store, ...m64(i * 8));
    co.push(O.lget, 2, O.lget, 2, O.i64load, ...m64(0), O.i64const, 1, O.i64shl, O.i64store, ...m64(0));
  } else {
    for (let i = 0; i <= 2; i++) co.push(O.lget, 2, O.lget, 2, O.i64load, ...m64(i * 8), O.i64const, 1, O.i64shru, O.lget, 2, O.i64load, ...m64((i + 1) * 8), O.i64const, 63, O.i64shl, O.i64or, O.i64store, ...m64(i * 8));
    co.push(O.lget, 2, O.lget, 2, O.i64load, ...m64(24), O.i64const, 1, O.i64shru, O.i64store, ...m64(24));
  }
  co.push(O.lget, 1, O.i64const, 1, O.i64sub, O.lset, 1, O.br, ...uleb(0), O.end, O.end, O.lget, 2, O.end);
  return co;
}
function mulBody(H) {
  // 32-bit schoolbook into 16 output limbs with immediate carry folding (each t fits i64):
  //   t = a32[i]*b32[j] + out[i+j] + carry ; out[i+j]=t&0xffffffff ; carry=t>>32
  // then normalize, trap if any of limbs 8..15 nonzero (product ≥ 2^256), pack low 8 → out.
  const SB = SCRATCH_BASE, MASK32 = 0xffffffff;
  const acc = (k) => SB + k * 8;
  const co = [O.call, ...uleb(H.alloc), O.lset, 2];              // out=2 (i32)
  for (let k = 0; k < 16; k++) co.push(O.i32const, ...sleb(acc(k)), O.i64const, 0, O.i64store, ...m64(0));
  for (let i = 0; i < 8; i++) {
    co.push(O.i64const, 0, O.lset, 3);                          // carry=3
    for (let j = 0; j < 8; j++) {
      // t = a[i]*b[j] + out[i+j] + carry
      co.push(O.lget, 0, O.i32load, ...m32(i * 4), O.i64extendi32u, O.lget, 1, O.i32load, ...m32(j * 4), O.i64extendi32u, O.i64mul);
      co.push(O.i32const, ...sleb(acc(i + j)), O.i64load, ...m64(0), O.i64add, O.lget, 3, O.i64add, O.lset, 4); // t=4
      co.push(O.i32const, ...sleb(acc(i + j)), O.lget, 4, O.i64const, ...sleb(MASK32), O.i64and, O.i64store, ...m64(0));
      co.push(O.lget, 4, O.i64const, 32, O.i64shru, O.lset, 3);
    }
    // out[i+8] += carry
    co.push(O.i32const, ...sleb(acc(i + 8)), O.i32const, ...sleb(acc(i + 8)), O.i64load, ...m64(0), O.lget, 3, O.i64add, O.i64store, ...m64(0));
  }
  // normalize all 16 limbs
  co.push(O.i64const, 0, O.lset, 3);
  for (let k = 0; k < 16; k++) {
    co.push(O.i32const, ...sleb(acc(k)), O.i64load, ...m64(0), O.lget, 3, O.i64add, O.lset, 4);
    co.push(O.i32const, ...sleb(acc(k)), O.lget, 4, O.i64const, ...sleb(MASK32), O.i64and, O.i64store, ...m64(0));
    co.push(O.lget, 4, O.i64const, 32, O.i64shru, O.lset, 3);
  }
  // overflow: any of limbs 8..15 nonzero → trap
  for (let k = 8; k < 16; k++) co.push(O.i32const, ...sleb(acc(k)), O.i64load, ...m64(0), O.i64eqz, O.i32eqz, O.if, 0x40, O.unreachable, O.end);
  // pack low 8 u32 → 4 i64
  for (let k = 0; k < 4; k++) co.push(O.lget, 2, O.i32const, ...sleb(acc(2 * k)), O.i64load, ...m64(0), O.i32const, ...sleb(acc(2 * k + 1)), O.i64load, ...m64(0), O.i64const, 32, O.i64shl, O.i64or, O.i64store, ...m64(k * 8));
  co.push(O.lget, 2, O.end);
  return co;
}
// div(a,b)->q via binary long division, using helper calls only. locals: q=2,r=3,i=4(i32),t=5(i32)
function divBody(H, ONE, Z) {
  const co = [];
  co.push(O.lget, 1, O.call, ...uleb(H.isz), O.if, 0x40, O.unreachable, O.end);          // ÷0
  co.push(O.i32const, ...sleb(Z), O.lset, 2);                                             // q = &ZERO (copied on first or)
  co.push(O.i32const, ...sleb(Z), O.lset, 3);                                             // r = &ZERO
  co.push(O.i32const, ...sleb(255), O.lset, 4);
  co.push(O.block, 0x40, O.loop, 0x40);
  co.push(O.lget, 4, O.i32const, ...sleb(0), O.i32lts, O.br_if, ...uleb(1));              // i<0 done
  // r = shl(r,1)
  co.push(O.lget, 3, O.i64const, 1, O.call, ...uleb(H.shl), O.lset, 3);
  // abit = and(shr(a,i), ONE) ; if !isz(abit): r = or(r, ONE)
  co.push(O.lget, 0, O.lget, 4, O.i64extendi32u, O.call, ...uleb(H.shr), O.i32const, ...sleb(ONE), O.call, ...uleb(H.and), O.call, ...uleb(H.isz), O.i32eqz, O.if, 0x40);
  co.push(O.lget, 3, O.i32const, ...sleb(ONE), O.call, ...uleb(H.or), O.lset, 3, O.end);
  // if cmp(r,b) >= 0: r = sub(r,b); q = or(q, shl(ONE,i))
  co.push(O.lget, 3, O.lget, 1, O.call, ...uleb(H.cmp), O.i32const, ...sleb(0), O.i32ges, O.if, 0x40);
  co.push(O.lget, 3, O.lget, 1, O.call, ...uleb(H.sub), O.lset, 3);
  co.push(O.lget, 2, O.i32const, ...sleb(ONE), O.lget, 4, O.i64extendi32u, O.call, ...uleb(H.shl), O.call, ...uleb(H.or), O.lset, 2, O.end);
  co.push(O.lget, 4, O.i32const, ...sleb(1), O.i32sub, O.lset, 4, O.br, ...uleb(0), O.end, O.end);
  co.push(O.lget, 2, O.end);
  return co;
}
// mod(a,b) = a - (a/b)*b   (a=0,b=1)
function modBody(H) {
  return [O.lget, 0, O.lget, 0, O.lget, 1, O.call, ...uleb(H.div), O.lget, 1, O.call, ...uleb(H.mul), O.call, ...uleb(H.sub), O.end];
}
function iszBody() {
  return [O.lget, 0, O.i64load, ...m64(0), O.lget, 0, O.i64load, ...m64(8), O.i64or, O.lget, 0, O.i64load, ...m64(16), O.i64or, O.lget, 0, O.i64load, ...m64(24), O.i64or, O.i64eqz, O.end];
}
function groupLocals(localTypes) {
  if (!localTypes || !localTypes.length) return [];
  const g = []; let cur = localTypes[0], n = 0;
  for (const t of localTypes) { if (t === cur) n++; else { g.push([...uleb(n), cur]); cur = t; n = 1; } }
  g.push([...uleb(n), cur]); return g;
}
function gatherLits(nodes, lit) {
  const ex = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.kind === 'num') { if (!Number.isInteger(n.value)) throw new Error('WASM backend: non-integer literal (decimal is EVM-backend only)'); lit(BigInt(n.value)); }
    if (n.kind === 'bool') lit(n.value ? 1n : 0n);
    for (const k of ['arg', 'value', 'expr', 'operand', 'cond', 'thenB', 'elseB', 'obj', 'coll', 'callee', 'left', 'right', 'index', 'start', 'end', 'body']) if (n[k]) ex(n[k]);
    for (const k of ['elements', 'args', 'body']) if (Array.isArray(n[k])) n[k].forEach(ex);
  };
  for (const s of nodes) { if (s.kind === 'block') gatherLits(s.body, lit); else if (s.kind === 'countedfor') { ex(s.start); ex(s.end); gatherLits(s.body.body, lit); } else ex(s); }
}

// ===== codegen =====
const BINCALL = { '+': 'add', '-': 'sub', '*': 'mul', '/': 'div', '%': 'mod', 'b&': 'and', 'b|': 'or', 'b^': 'xor' };
function compileMethod(m, ctx) {
  const params = new Map(); m.params.forEach((p, i) => params.set(p.name, i));
  const idx = new Map(); const localTypes = []; let next = m.params.length;
  const declare = (name) => { if (params.has(name)) return params.get(name); if (!idx.has(name)) { idx.set(name, next++); localTypes.push(I32); } return idx.get(name); };
  collectLocals(m.body.body, ctx, params, declare);
  const vt = next++; localTypes.push(I32); // scratch for field writes
  // Scratch for an xmbl_read result pointer — allocated ONLY when compose is on, so the default
  // path's local section stays byte-identical. A read leaves its freshly-__alloc'd word buffer in
  // this local just long enough to pass it as the val_out arg and then re-push it as the
  // expression value; because each read fully consumes-and-reloads the local before returning the
  // pointer, two reads in ONE expression never alias (their buffers differ — __alloc bumps).
  const rt = ctx.compose ? next++ : -1; if (ctx.compose) localTypes.push(I32);
  ctx = Object.assign({}, ctx, { vt, rt });
  const code = []; let ret = false;
  const get = (name) => params.has(name) ? params.get(name) : idx.get(name);
  // hostState prologue: load every committed field from Verkle into its memory word BEFORE
  // the body runs, so a read sees the state persisted by an earlier call (not just this
  // instance's zero-initialised memory). Absent keys yield 32 zero bytes — the same value an
  // unset field already holds. Persist is eager (on each field assign, below), so early
  // `return` never skips a write.
  if (ctx.hostState) {
    for (let i = 0; i < ctx.fields; i++) {
      code.push(O.i32const, ...sleb(ctx.hostState.keyPtr[i]),
                O.i32const, ...sleb(ctx.hostState.keyLen[i]),
                O.i32const, ...sleb(ctx.FIELD_BASE + i * SLOT),
                O.call, ...uleb(ctx.hostState.vget), O.drop);
    }
  }
  for (const s of m.body.body) { emitStmt(s, code, ctx, params, get); if (isReturn(s)) ret = true; }
  if (!ret) code.push(O.i32const, ...sleb(ctx.Z));
  code.push(O.end);
  return { locals: localTypes, code };
}
function isReturn(s) { return s.kind === 'return' || (s.kind === 'exprstmt' && s.expr && s.expr.kind === 'return'); }
function collectLocals(nodes, ctx, params, declare) {
  for (const s of nodes) {
    if (s.kind === 'assign' && !ctx.slot.has(s.name) && !params.has(s.name)) declare(s.name);
    if (s.kind === 'countedfor') { declare(s.varName); collectLocals(s.body.body, ctx, params, declare); }
    if (s.kind === 'block') collectLocals(s.body, ctx, params, declare);
    if (s.kind === 'exprstmt' && s.expr && s.expr.kind === 'ternary') tern(s.expr, ctx, params, declare);
  }
}
// A ternary else-branch written as `{ ... }` parses as `anonfn` (a block in expression
// position), while a then-branch `{ ... }` parses as `block`. Both denote a statement block
// here, so unwrap anonfn to its block — otherwise a block else-branch (e.g. from an imported
// Solidity if/else) reaches emitP as an uncompilable `anonfn`.
function asBlock(x) { return x && x.kind === 'anonfn' ? x.body : x; }
function tern(t, ctx, params, dl) { const b = (x0) => { const x = asBlock(x0); if (!x) return; if (x.kind === 'block') collectLocals(x.body, ctx, params, dl); else if (x.kind === 'ternary') tern(x, ctx, params, dl); }; b(t.thenB); b(t.elseB); }

function fieldAddr(ctx, name) { return ctx.FIELD_BASE + ctx.slot.get(name) * SLOT; }

function emitStmt(s, code, ctx, params, get) {
  switch (s.kind) {
    case 'assign': {
      if (ctx.slot.has(s.name)) {
        emitP(s.value, code, ctx, params, get); code.push(O.lset, ...uleb(ctx.vt)); // vt = value ptr
        const addr = fieldAddr(ctx, s.name);
        for (let k = 0; k < 4; k++) code.push(O.i32const, ...sleb(addr), O.lget, ...uleb(ctx.vt), O.i64load, ...m64(k * 8), O.i64store, ...m64(k * 8));
        // hostState: flush this field to Verkle immediately after the memory write, so the
        // write survives to the next call even if a later `return` exits before other fields.
        if (ctx.hostState) {
          const fidx = ctx.slot.get(s.name);
          code.push(O.i32const, ...sleb(ctx.hostState.keyPtr[fidx]),
                    O.i32const, ...sleb(ctx.hostState.keyLen[fidx]),
                    O.i32const, ...sleb(addr),
                    O.i32const, ...sleb(SLOT),
                    O.call, ...uleb(ctx.hostState.vset), O.drop);
        }
      } else {
        emitP(s.value, code, ctx, params, get); code.push(O.lset, ...uleb(get(s.name)));
      }
      break;
    }
    case 'return': emitP(s.value, code, ctx, params, get); code.push(O.ret); break;
    case 'exprstmt': {
      const e = s.expr;
      if (e.kind === 'return') { emitP(e.value, code, ctx, params, get); code.push(O.ret); break; }
      if (e.kind === 'ternary') { emitIf(e, code, ctx, params, get); break; }
      if (e.kind === 'emit') { code.push(O.i32const, ...sleb(ctx.EVENTS_ADDR), O.i32const, ...sleb(ctx.EVENTS_ADDR), O.i64load, ...m64(0), O.i64const, 1, O.i64add, O.i64store, ...m64(0)); break; }
      if (e.kind === 'print') break;
      emitP(e, code, ctx, params, get); code.push(O.drop); break;
    }
    case 'countedfor': {
      const iIdx = get(s.varName);
      emitP(s.start, code, ctx, params, get); code.push(O.lset, ...uleb(iIdx));
      code.push(O.block, 0x40, O.loop, 0x40);
      code.push(O.lget, ...uleb(iIdx)); emitP(s.end, code, ctx, params, get); code.push(O.call, ...uleb(ctx.H.cmp), O.i32const, ...sleb(0), O.i32gts, O.br_if, ...uleb(1));
      for (const b of s.body.body) emitStmt(b, code, ctx, params, get);
      code.push(O.lget, ...uleb(iIdx), O.i32const, ...sleb(ctx.ONE), O.call, ...uleb(ctx.H.add), O.lset, ...uleb(iIdx));
      code.push(O.br, ...uleb(0), O.end, O.end);
      break;
    }
    case 'block': for (const b of s.body) emitStmt(b, code, ctx, params, get); break;
    // `~e` (LNG error/revert — what an imported Solidity require()/revert lowers to) is a trap,
    // exactly like the overflow/÷0 guards above: it aborts the call and rolls back, the on-chain
    // equivalent of the interpreter throwing LError. Without this an imported require() contract
    // could only ever run in the interpreter, never compile to WASM.
    case 'error': code.push(O.unreachable); break;
    default: throw new Error('cannot compile statement: ' + s.kind);
  }
}
function emitIf(t, code, ctx, params, get) {
  emitTruth(t.cond, code, ctx, params, get); code.push(O.if, 0x40);
  branch(t.thenB, code, ctx, params, get);
  if (t.elseB) { code.push(O.else); const e = asBlock(t.elseB); if (e.kind === 'ternary') emitIf(e, code, ctx, params, get); else branch(e, code, ctx, params, get); }
  code.push(O.end);
}
function branch(b0, code, ctx, params, get) { const b = asBlock(b0); if (b.kind === 'block') for (const s of b.body) emitStmt(s, code, ctx, params, get); else emitStmt({ kind: 'exprstmt', expr: b }, code, ctx, params, get); }
function emitTruth(n, code, ctx, params, get) { emitP(n, code, ctx, params, get); code.push(O.i32const, ...sleb(ctx.Z), O.call, ...uleb(ctx.H.cmp)); } // cmp(ptr,0)∈{0,1} for unsigned

function emitP(n, code, ctx, params, get) {
  if (!n) { code.push(O.i32const, ...sleb(ctx.Z)); return; }
  switch (n.kind) {
    case 'num': code.push(O.i32const, ...sleb(ctx.lit(BigInt(n.value)))); return;
    case 'bool': code.push(O.i32const, ...sleb(ctx.lit(n.value ? 1n : 0n))); return;
    case 'null': code.push(O.i32const, ...sleb(ctx.Z)); return;
    case 'group': emitP(n.expr, code, ctx, params, get); return;
    case 'ref': {
      if (params.has(n.name)) { code.push(O.lget, ...uleb(params.get(n.name))); return; }
      if (ctx.slot.has(n.name)) { code.push(O.i32const, ...sleb(fieldAddr(ctx, n.name))); return; }
      code.push(O.lget, ...uleb(get(n.name))); return;
    }
    case 'unary': {
      if (n.op === '-') { code.push(O.i32const, ...sleb(ctx.Z)); emitP(n.operand, code, ctx, params, get); code.push(O.call, ...uleb(ctx.H.sub)); return; }
      if (n.op === 'b~') { emitP(n.operand, code, ctx, params, get); code.push(O.call, ...uleb(ctx.H.not)); return; }
      if (n.op === '!') { emitTruth(n.operand, code, ctx, params, get); code.push(O.i32eqz, O.call, ...uleb(ctx.H.frombool)); return; }
      throw new Error('WASM backend: unary ' + n.op);
    }
    case 'binary': {
      const op = n.op;
      if (op in BINCALL) { emitP(n.left, code, ctx, params, get); emitP(n.right, code, ctx, params, get); code.push(O.call, ...uleb(ctx.H[BINCALL[op]])); return; }
      if (op === 'b<' || op === 'b>') { emitP(n.left, code, ctx, params, get); emitShiftCount(n.right, code, ctx, params, get); code.push(O.call, ...uleb(op === 'b<' ? ctx.H.shl : ctx.H.shr)); return; }
      const cp = { '==': [O.i32eqz], '!==': [O.i32const, 0, O.i32ne], '>': [O.i32const, 0, O.i32gts], '<': [O.i32const, 0, O.i32lts], '!>': [O.i32const, 0, 0x4c /*i32.le_s*/], '!<': [O.i32const, 0, O.i32ges] };
      if (op in cp) { emitP(n.left, code, ctx, params, get); emitP(n.right, code, ctx, params, get); code.push(O.call, ...uleb(ctx.H.cmp), ...cp[op], O.call, ...uleb(ctx.H.frombool)); return; }
      if (op === '&' || op === '|') { emitTruth(n.left, code, ctx, params, get); emitTruth(n.right, code, ctx, params, get); code.push(op === '&' ? O.i32and : O.i32or, O.call, ...uleb(ctx.H.frombool)); return; }
      throw new Error('WASM backend: operator ' + op);
    }
    case 'ternary': {
      const isBlk = (x) => x && (x.kind === 'block' || x.kind === 'anonfn');
      emitTruth(n.cond, code, ctx, params, get); code.push(O.if, I32);
      emitP(isBlk(n.thenB) ? blockValue(n.thenB) : n.thenB, code, ctx, params, get);
      code.push(O.else); emitP(n.elseB ? (isBlk(n.elseB) ? blockValue(n.elseB) : n.elseB) : { kind: 'num', value: 0 }, code, ctx, params, get);
      code.push(O.end); return;
    }
    // `~e` in value position (e.g. a require-guarded value-ternary's else branch): trap. `unreachable`
    // is stack-polymorphic, so it satisfies the branch's i32 result type without pushing a value.
    case 'error': code.push(O.unreachable); return;
    // Host-stdlib call — the ONLY calls the WASM backend lowers are the `xmbl.*` host primitives
    // (no general user-function calls on this backend). `xmbl.coord.send(peer, amount)` lowers to
    // the env.xmbl_send import: both args are ~u256 word POINTERS (the backend's value model), the
    // import reads the peer index and the full amount from those words, and returns an i32 status.
    // The status is the call's value here (dropped in statement position); compose calls are
    // statement-level effects, not word-producing expressions. Any other `xmbl.*` call (or any
    // non-xmbl call) is a hard error — never silently miscompiled.
    case 'call': {
      const path = xmblCallPath(n.callee);
      if (path && path.length === 2 && path[0] === 'coord' && path[1] === 'send') {
        if (!ctx.compose) throw new Error('WASM backend: xmbl.coord.send requires compile(src, { compose: true })');
        if (n.args.length !== 2) throw new Error('WASM backend: xmbl.coord.send(peer, amount) takes exactly 2 arguments');
        emitP(n.args[0], code, ctx, params, get);   // peer index word pointer
        emitP(n.args[1], code, ctx, params, get);   // amount word pointer
        code.push(O.call, ...uleb(ctx.compose.sendIdx));
        return;
      }
      // `xmbl.coord.read(peer, field)` — SYNCHRONOUS cross-contract read, a word-producing
      // expression. Both args are word pointers (peer index, field index). The host writes the
      // peer's committed field word into a result buffer we allocate and leaves that buffer
      // pointer as the expression value. Any error traps in the host (fail-closed), so the i32
      // status is always 0 and is dropped.
      if (path && path.length === 2 && path[0] === 'coord' && path[1] === 'read') {
        if (!ctx.compose) throw new Error('WASM backend: xmbl.coord.read requires compile(src, { compose: true })');
        if (n.args.length !== 2) throw new Error('WASM backend: xmbl.coord.read(peer, field) takes exactly 2 arguments');
        emitP(n.args[0], code, ctx, params, get);               // peer index word pointer
        emitP(n.args[1], code, ctx, params, get);               // field index word pointer
        code.push(O.call, ...uleb(ctx.H.alloc), O.lset, ...uleb(ctx.rt)); // rt = fresh result buffer
        code.push(O.lget, ...uleb(ctx.rt));                     // val_out arg
        code.push(O.call, ...uleb(ctx.compose.readIdx), O.drop); // read writes into rt, status dropped
        code.push(O.lget, ...uleb(ctx.rt));                     // expression value = the result word pointer
        return;
      }
      throw new Error('WASM backend: unsupported call ' + (path ? 'xmbl.' + path.join('.') : n.callee && n.callee.kind));
    }
    default: throw new Error('WASM backend: cannot compile expression ' + n.kind);
  }
}
// A call callee that is a member chain rooted at the `xmbl` stdlib ref → the member path
// (e.g. `xmbl.coord.send` → ['coord','send']); anything else → null (not a host call).
function xmblCallPath(callee) {
  const parts = [];
  let node = callee;
  while (node && node.kind === 'member') { parts.unshift(node.name); node = node.obj; }
  return (node && node.kind === 'ref' && node.name === 'xmbl') ? parts : null;
}
// shift count is an i64 (low limb of the operand value)
function emitShiftCount(n, code, ctx, params, get) { emitP(n, code, ctx, params, get); code.push(O.i64load, ...m64(0)); }
function blockValue(b0) { const b = asBlock(b0); const last = b.body[b.body.length - 1]; if (last && last.kind === 'exprstmt') return last.expr; if (last && last.kind === 'error') return last; /* a revert branch: emitP traps */ throw new Error('WASM backend: value-ternary branch must end in an expression'); }

// contractFields(src) — the peer's ordered field names, DERIVED from source rather than
// re-typed by the operator. A word-read names a peer field by INDEX; the host resolves that
// index against the peer's deploy-declared `fields` list to a byte key. If that list were
// hand-typed it could be transposed (['b','a']) and index 0 would silently resolve to the
// wrong real field — a plausible, undetectable wrong value. Deriving it here makes the list
// authoritative by construction: it is EXACTLY the compiler's own field slot order (line 90,
// `c.fields.forEach((f,i) => slot.set(f.name,i))`), so a read index means the same field the
// peer commits under. The only way to get it wrong is to pass a different contract's source —
// which compiles to different bytes and therefore a different content-addressed id.
function contractFields(src) {
  const c = parse(lex(src)).body.find(n => n.kind === 'contract');
  if (!c) throw new Error('contractFields: no ~contract found in source');
  return c.fields.map(f => f.name);
}

export { compile, contractFields };