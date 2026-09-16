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
 * on the raw market path.
 * NOTE: `~u256` PARAMS still arrive as memory pointers; passing plain-int args through
 * ContractHost is a separate, unbuilt marshalling concern.
 *
 * CRYPTO MODE — `compile(src, { crypto: true })`: emits the §3.1 signature verifiers
 * (env.xmbl_cubic_sig_verify / env.xmbl_mayo_verify) so `~xmbl.mayo.verify('0x…')` and
 * `~xmbl.cubic.verify('0x…')` are reachable from LNG source. ONE argument, not the
 * interpreter's three: the signature and public key are CHAIN-STAGED, identical on every node,
 * which is what makes the verdict deterministic — a guest that chose its own public key would
 * be verifying nothing. MAYO's async load is the host's `init` hook, awaited before the guest
 * is instantiated, so the import itself stays synchronous.
 *
 * UTXO MODE — `compile(src, { utxo: true })`: emits the value ABI (input_count, input_id,
 * utxo_amount, utxo_spend, utxo_create), so a contract spends the UTXOs its CALLER presented —
 * ids it could not have known at compile time. The ABI's -1 error sentinel TRAPS rather than
 * widening into a 256-bit word, where it would read as an enormous legitimate amount.
 *
 * ~bytes — the byte-string type (see the layout note beside BYTES/LIT_BASE). A ~bytes value is
 * a (pointer, length) pair pushed onto the operand stack, never a 256-bit word: a LITERAL's
 * bytes sit in a data segment with a compile-time length, and a RUNTIME value (an id from
 * xmbl_input_id) is host-written into fresh memory with its length in a local. A ~bytes FIELD
 * or PARAM is REJECTED — committed state and the call ABI are both 32-byte words with nowhere
 * to put a length (the interpreter and EVM backend carry those forms).
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
// UTF-8 bytes of a name — TextEncoder is the one encoder Node and browsers both ship; this file is also the
// source of the browser build (dist/lng.browser.js), where `Buffer` does not exist.
const utf8 = (s) => [...new TextEncoder().encode(s)];
function nm(s) { const b = utf8(s); return [...uleb(b.length), ...b]; }
const I32 = 0x7F, I64 = 0x7E;
const O = {
  unreachable: 0x00, block: 0x02, loop: 0x03, if: 0x04, else: 0x05, end: 0x0b, br: 0x0c, br_if: 0x0d, ret: 0x0f, call: 0x10, drop: 0x1a,
  lget: 0x20, lset: 0x21, gget: 0x23, gset: 0x24,
  i32load: 0x28, i64load: 0x29, i32store: 0x36, i64store: 0x37,
  i32const: 0x41, i64const: 0x42,
  i32eqz: 0x45, i32ne: 0x47, i32lts: 0x48, i32gts: 0x4a, i32ges: 0x4e,
  i64eqz: 0x50, i64eq: 0x51, i64ne: 0x52, i64ltu: 0x54,
  i32add: 0x6a, i32sub: 0x6b, i32mul: 0x6c, i32and: 0x71, i32or: 0x72, i32shru: 0x76,
  i64add: 0x7c, i64sub: 0x7d, i64mul: 0x7e, i64and: 0x83, i64or: 0x84, i64xor: 0x85, i64shl: 0x86, i64shru: 0x88,
  i64extendi32u: 0xad, i32wrapi64: 0xa7,
};
const m64 = (off) => [0x03, ...uleb(off)];
const m32 = (off) => [0x02, ...uleb(off)];

const SLOT = 32;
const SCRATCH_BASE = 16;              // 16 i64 mul accumulators (128 bytes) — full product
const LIT_BASE = SCRATCH_BASE + 128;  // start of the constant data region

// ~bytes — THE BYTE-STRING LAYOUT. A 256-bit word cannot carry a message or a UTXO id: the host ABI takes a
// (pointer, length) pair, and the backend's only value shape is a 32-byte word. So a ~bytes value is NOT a
// word at all here — it is a (ptr, len) pair pushed straight onto the operand stack by emitBytes, consumed by
// the host call that needs it. A LITERAL's bytes are placed in a data segment at BYTES_BASE and its length is
// a compile-time i32; a RUNTIME value (an id the contract could not have known, from xmbl_input_id) is written
// into freshly __alloc'd memory with its length in a local. Nothing needs an in-memory length prefix, because
// a length is always either a constant or a live local. A ~bytes value is therefore usable EXACTLY where the
// host ABI takes one, and nowhere else — arithmetic on it is a hard error, never a pointer silently added to.
// A `~bytes` FIELD or PARAM is refused (see bad() below): committed state and the call ABI are both 32-byte
// words, so neither has a place to put the length. The interpreter and the EVM backend carry those forms.
const align32 = (n) => Math.ceil(n / SLOT) * SLOT;
// A ~bytes literal's bytes: `0x…` is a hex digest (the form the interpreter's ~bytes cast accepts), anything
// else is its UTF-8 bytes (a UTXO id is an ASCII string on the wire, so this is the form the host compares).
function literalBytes(v) {
  const s = String(v);
  if (/^0x[0-9a-fA-F]*$/.test(s)) {
    if ((s.length - 2) % 2 !== 0) throw new Error(`WASM backend: ~bytes literal '${s}' has an odd number of hex digits`);
    const out = []; for (let i = 2; i < s.length; i += 2) out.push(parseInt(s.slice(i, i + 2), 16));
    return out;
  }
  return utf8(s);
}

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
  // crypto / utxo (opt-in, same rule as the two above): the §3.1 signature verifiers and the UTXO value ABI.
  // They are what a ~bytes value exists FOR — a contract hands the chain a message to verify, or an id to
  // spend. Import indices are assigned in ONE fixed order (state, compose, crypto, utxo) and every emitted
  // index derives from the same bases, so a mis-ordered import list cannot silently produce a valid module
  // that calls the wrong host function.
  const crypto = !!(opts && opts.crypto);
  const utxo = !!(opts && opts.utxo);
  const CRYPTO_BASE = COMPOSE_BASE + (compose ? 2 : 0);
  const CUBIC_IDX = CRYPTO_BASE, MAYO_IDX = CRYPTO_BASE + 1;
  const UTXO_BASE = CRYPTO_BASE + (crypto ? 2 : 0);
  const UCOUNT_IDX = UTXO_BASE, UID_IDX = UTXO_BASE + 1, UAMT_IDX = UTXO_BASE + 2,
        USPEND_IDX = UTXO_BASE + 3, UCREATE_IDX = UTXO_BASE + 4;
  const IMPORT_COUNT = UTXO_BASE + (utxo ? 5 : 0);

  const bad = (t, w) => { if (t && (t in INT_WIDTHS) && INT_WIDTHS[t][0]) throw new Error(`WASM backend is unsigned-only: signed ~${t} ${w} unsupported (use the EVM backend)`); if (t === 'decimal') throw new Error(`WASM backend does not support ~decimal ${w} (use the EVM backend)`); if (t === 'bytes') throw new Error(`WASM backend: ~bytes ${w} has nowhere to carry its length — a committed field and a call argument are both 32-byte words. Pass a ~bytes LITERAL or xmbl.utxo.input_id(i) directly to the host call that consumes it (the interpreter and EVM backend carry ~bytes fields/params).`); };
  for (const f of c.fields) bad(f.type, `field \`${f.name}`);
  for (const mth of c.methods) for (const p of mth.params) bad(p.type, `param \`${p.name}`);

  const slot = new Map(); c.fields.forEach((f, i) => slot.set(f.name, i));

  // ~bytes literals are laid out FIRST, so the 32-byte word pool that follows keeps its alignment and a
  // contract with no byte literals emits a BYTE-IDENTICAL module to the one it emitted before ~bytes existed
  // (blobSize is 0, so POOL_BASE === LIT_BASE).
  const blobs = new Map(); const blobBytes = [];
  let blobsFrozen = false;   // the region's size is fixed once laid out; a literal the gatherer missed would
                             // otherwise be appended past the end of the emitted data segment and read as zeros
  const blob = (v) => {
    const key = String(v);
    if (!blobs.has(key)) {
      if (blobsFrozen) throw new Error(`WASM backend: internal — ~bytes literal '${key}' was not gathered before layout`);
      const b = literalBytes(v); blobs.set(key, { ptr: LIT_BASE + blobBytes.length, len: b.length }); blobBytes.push(...b);
    }
    return blobs.get(key);
  };
  for (const mth of c.methods) gatherBytes(mth.body.body, blob);
  const BLOB_SIZE = align32(blobBytes.length);
  const POOL_BASE = LIT_BASE + BLOB_SIZE;
  blobsFrozen = true;

  const lits = new Map();
  const lit = (v) => { v = BigInt(v); if (v < 0n) v = (1n << 256n) + v; if (!lits.has(v)) lits.set(v, POOL_BASE + lits.size * SLOT); return lits.get(v); };
  const Z = lit(0n), ONE = lit(1n), ONES = lit((1n << 256n) - 1n);
  for (const mth of c.methods) gatherLits(mth.body.body, lit);
  // State-field byte keys (hostState only) live in a data region between the literal pool
  // and the field storage, so the guest can pass (key_ptr, key_len) to the host ABI. Each
  // field's key is its own UTF-8 name; per-contract namespacing is the host's job (byteKey).
  const KEYS_BASE = POOL_BASE + lits.size * SLOT;
  const keyPtr = [], keyLen = [], keyBytes = [];
  if (hostState) {
    let off = KEYS_BASE;
    for (const f of c.fields) {
      const kb = utf8(f.name);
      keyPtr.push(off); keyLen.push(kb.length); keyBytes.push(...kb); off += kb.length;
    }
  }
  const KEYS_SIZE = hostState ? Math.ceil(keyBytes.length / SLOT) * SLOT : 0;
  const FIELD_BASE = KEYS_BASE + KEYS_SIZE;   // == POOL_BASE + lits.size*SLOT when !hostState
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
      compose: compose ? { readIdx: READ_IDX, sendIdx: SEND_IDX } : null,
      crypto: crypto ? { cubicIdx: CUBIC_IDX, mayoIdx: MAYO_IDX } : null,
      utxo: utxo ? { countIdx: UCOUNT_IDX, inputIdIdx: UID_IDX, amountIdx: UAMT_IDX, spendIdx: USPEND_IDX, createIdx: UCREATE_IDX } : null,
      blob });
    F(ti, built.locals, built.code);
    exports.push([...nm(finalName(mth)), 0x00, ...uleb(ENTRY0 + mi)]);
  });

  // Import types (hostState only) — registered after the method types so the default path's
  // type section is untouched. get: (i32,i32,i32)->i32; set: (i32,i32,i32,i32)->i32.
  const T_get = hostState ? T([I32, I32, I32], [I32]) : 0;
  const T_set = hostState ? T([I32, I32, I32, I32], [I32]) : 0;
  // xmbl_read is (peer_ptr, field_ptr, val_out_ptr)->i32, and xmbl_send is now
  // (peer_ptr, args_ptr, arg_count)->i32 — the SAME shape, so both use T_read. Registered
  // unconditionally when compose is on (NOT gated on hostState) so the stateless-compose path has a
  // live type index — T() deduplicates, so it collapses onto T_get's shape when hostState is on too.
  const T_read = compose ? T([I32, I32, I32], [I32]) : 0;
  // crypto: both verifiers are (msg_ptr, msg_len)->i32 — the same shape as T_2, which T() collapses onto.
  const T_verify = crypto ? T([I32, I32], [I32]) : 0;
  // utxo: count ()->i32, input_id (i,out)->i32 len, amount/spend (ptr,len)->i64, create (ptr,len,amount)->i64.
  const T_ucount = utxo ? T([], [I32]) : 0;
  const T_uid = utxo ? T([I32, I32], [I32]) : 0;
  const T_uamt = utxo ? T([I32, I32], [I64]) : 0;
  const T_ucreate = utxo ? T([I32, I32, I64], [I64]) : 0;
  const typeSec = section(1, vec(types));
  // Import entries in the SAME order the indices were assigned: state imports (0,1), then the
  // compose imports read THEN send — so READ_IDX / SEND_IDX above match these entries' positions.
  // xmbl_read AND xmbl_send are both (i32,i32,i32)->i32 = T_read.
  const importEntries = [];
  if (hostState) {
    importEntries.push([...nm('env'), ...nm('xmbl_verkle_get'), 0x00, ...uleb(T_get)]);
    importEntries.push([...nm('env'), ...nm('xmbl_verkle_set'), 0x00, ...uleb(T_set)]);
  }
  if (compose) {
    importEntries.push([...nm('env'), ...nm('xmbl_read'), 0x00, ...uleb(T_read)]);
    importEntries.push([...nm('env'), ...nm('xmbl_send'), 0x00, ...uleb(T_read)]);
  }
  if (crypto) {
    importEntries.push([...nm('env'), ...nm('xmbl_cubic_sig_verify'), 0x00, ...uleb(T_verify)]);
    importEntries.push([...nm('env'), ...nm('xmbl_mayo_verify'), 0x00, ...uleb(T_verify)]);
  }
  if (utxo) {
    importEntries.push([...nm('env'), ...nm('xmbl_input_count'), 0x00, ...uleb(T_ucount)]);
    importEntries.push([...nm('env'), ...nm('xmbl_input_id'), 0x00, ...uleb(T_uid)]);
    importEntries.push([...nm('env'), ...nm('xmbl_utxo_amount'), 0x00, ...uleb(T_uamt)]);
    importEntries.push([...nm('env'), ...nm('xmbl_utxo_spend'), 0x00, ...uleb(T_uamt)]);
    importEntries.push([...nm('env'), ...nm('xmbl_utxo_create'), 0x00, ...uleb(T_ucreate)]);
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
  if (blobBytes.length) dataSegs.push([0x00, O.i32const, ...sleb(LIT_BASE), O.end, ...uleb(blobBytes.length), ...blobBytes]);
  if (lits.size) dataSegs.push([0x00, O.i32const, ...sleb(POOL_BASE), O.end, ...uleb(litBytes.length), ...litBytes]);
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

// Every ~bytes literal reachable from a method body, interned into the blob region before layout. The walk
// mirrors gatherLits exactly, so the two regions are gathered by one traversal shape and neither can see a
// literal the other misses.
function gatherBytes(nodes, blob) {
  const ex = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.kind === 'str') blob(n.value);
    for (const k of ['arg', 'value', 'expr', 'operand', 'cond', 'thenB', 'elseB', 'obj', 'coll', 'callee', 'left', 'right', 'index', 'start', 'end', 'body']) if (n[k]) ex(n[k]);
    for (const k of ['elements', 'args', 'body']) if (Array.isArray(n[k])) n[k].forEach(ex);
  };
  for (const s of nodes) { if (s.kind === 'block') gatherBytes(s.body, blob); else if (s.kind === 'countedfor') { ex(s.start); ex(s.end); gatherBytes(s.body.body, blob); } else ex(s); }
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
  // Scratch for a (possibly multi-arg) xmbl_send: st = peer-index word pointer, sb = base of the
  // contiguous arg-word block, sc = per-arg copy source. Allocated ONLY under compose so the
  // default path's local section stays byte-identical (unused locals are legal for read-only
  // compose methods).
  const st = ctx.compose ? next++ : -1; if (ctx.compose) localTypes.push(I32);
  const sb = ctx.compose ? next++ : -1; if (ctx.compose) localTypes.push(I32);
  const sc = ctx.compose ? next++ : -1; if (ctx.compose) localTypes.push(I32);
  // Scratch for the UTXO value ABI: bx = the base of a fresh 256-byte buffer an id is written into, bl = the
  // length the host reported for it, bp/bq = the word a returned i64 amount is widened into. Allocated ONLY
  // under utxo, so every other path's local section stays byte-identical. The crypto verifiers need none of
  // these — their argument is a (ptr,len) pair on the stack and their result is an i32 the frombool helper
  // already turns into a word.
  const bx = ctx.utxo ? next++ : -1; if (ctx.utxo) localTypes.push(I32);
  const bl = ctx.utxo ? next++ : -1; if (ctx.utxo) localTypes.push(I32);
  const bp = ctx.utxo ? next++ : -1; if (ctx.utxo) localTypes.push(I32);
  const bq = ctx.utxo ? next++ : -1; if (ctx.utxo) localTypes.push(I64);
  ctx = Object.assign({}, ctx, { vt, rt, st, sb, sc, bx, bl, bp, bq });
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
        if (n.args.length < 2) throw new Error('WASM backend: xmbl.coord.send(peer, arg, ...) takes a peer index and at least one message argument');
        const valueArgs = n.args.slice(1);            // args[0] is the peer index; the rest are the message
        const count = valueArgs.length;
        // peer index word pointer → st
        emitP(n.args[0], code, ctx, params, get);
        code.push(O.lset, ...uleb(ctx.st));
        // Allocate `count` CONTIGUOUS 32-byte words up front. __alloc is a bump allocator, so
        // back-to-back calls with nothing between them yield a contiguous block: sb is slot 0 and
        // slot i is sb + i*32. This MUST precede any arg evaluation — an arg expression can itself
        // __alloc temporaries, which would interleave and break the block's contiguity.
        code.push(O.call, ...uleb(ctx.H.alloc), O.lset, ...uleb(ctx.sb));       // slot 0 base
        for (let i = 1; i < count; i++) code.push(O.call, ...uleb(ctx.H.alloc), O.drop); // slots 1..count-1
        // Copy each value arg's 32-byte word into its slot. emitP leaves a source word pointer; a
        // word is 4 i64 limbs, copied with fixed-offset loads/stores. The destination is sb and the
        // per-slot/per-limb byte offset (i*32 + k*8) folds into the i64.store static offset.
        for (let i = 0; i < count; i++) {
          emitP(valueArgs[i], code, ctx, params, get);
          code.push(O.lset, ...uleb(ctx.sc));                                   // sc = source word pointer
          for (let k = 0; k < 4; k++) {
            code.push(O.lget, ...uleb(ctx.sb));                                 // destination base
            code.push(O.lget, ...uleb(ctx.sc), O.i64load, ...m64(k * 8));       // limb k of the source
            code.push(O.i64store, ...m64(i * SLOT + k * 8));                    // → sb[i*32 + k*8]
          }
        }
        // xmbl_send(peer_ptr, args_ptr, arg_count) -> i32 status. The status is the call's value;
        // in statement position the exprstmt handler drops it (send is an effect, not a value).
        code.push(O.lget, ...uleb(ctx.st));
        code.push(O.lget, ...uleb(ctx.sb));
        code.push(O.i32const, ...sleb(count));
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
      // `xmbl.mayo.verify(msg)` / `xmbl.cubic.verify(msg)` — THE CONTRACT ASKS THE CHAIN TO
      // VERIFY A SIGNATURE. The signature material itself is chain-staged (ctx.data.crypto, identical on every
      // node, so the verdict is too); the guest supplies only the MESSAGE, which is exactly what ~bytes is for.
      // The import takes (msg_ptr, msg_len) — the pair emitBytes pushes — and answers i32 1/0, which frombool
      // turns into the backend's word for true/false. Never traps: an invalid signature is a 0, not a fault.
      if (path && path.length === 2 && path[1] === 'verify' && (path[0] === 'mayo' || path[0] === 'cubic')) {
        if (!ctx.crypto) throw new Error(`WASM backend: xmbl.${path[0]}.verify requires compile(src, { crypto: true })`);
        // ONE argument, not the interpreter's three. Off-chain, `xmbl.mayo.verify(msg, sig, pk)` is handed its
        // own material; on-chain the material is CHAIN-STAGED (ctx.data.crypto) precisely so every node
        // verifies against the same bytes and reaches the same verdict — a guest that could choose its own
        // public key would be verifying nothing. An interpreter-shaped call is a hard arity error here, never
        // a silent drop of the two arguments the chain supplies.
        if (n.args.length !== 1) throw new Error(`WASM backend: xmbl.${path[0]}.verify(msg) takes exactly one ~bytes argument on-chain — the signature and public key are chain-staged, not guest-supplied`);
        emitBytes(n.args[0], code, ctx, params, get);
        code.push(O.call, ...uleb(path[0] === 'mayo' ? ctx.crypto.mayoIdx : ctx.crypto.cubicIdx));
        code.push(O.call, ...uleb(ctx.H.frombool));
        return;
      }
      // `xmbl.utxo.*` — THE VALUE ABI. `count()` and `input_id(i)` enumerate the UTXOs the CALLER presented,
      // so a contract spends a content-addressed ledger id it could never have known at compile time;
      // `amount`/`spend` take that id, `create` pays an amount out to a recipient.
      if (path && path.length === 2 && path[0] === 'utxo') {
        const fn = path[1];
        if (!ctx.utxo) throw new Error(`WASM backend: xmbl.utxo.${fn} requires compile(src, { utxo: true })`);
        if (fn === 'count') {
          if (n.args.length !== 0) throw new Error('WASM backend: xmbl.utxo.count() takes no arguments');
          code.push(O.call, ...uleb(ctx.utxo.countIdx), O.i64extendi32u);
          emitI64Word(code, ctx, false);   // a count is never the -1 sentinel
          return;
        }
        if (fn === 'amount' || fn === 'spend') {
          if (n.args.length !== 1) throw new Error(`WASM backend: xmbl.utxo.${fn}(id) takes exactly one ~bytes argument`);
          emitBytes(n.args[0], code, ctx, params, get);
          code.push(O.call, ...uleb(fn === 'spend' ? ctx.utxo.spendIdx : ctx.utxo.amountIdx));
          emitI64Word(code, ctx, true);
          return;
        }
        if (fn === 'create') {
          if (n.args.length !== 2) throw new Error('WASM backend: xmbl.utxo.create(to, amount) takes a ~bytes recipient and an amount');
          emitBytes(n.args[0], code, ctx, params, get);
          emitP(n.args[1], code, ctx, params, get);
          code.push(O.i64load, ...m64(0));               // the amount's low limb — the ABI carries value as i64
          code.push(O.call, ...uleb(ctx.utxo.createIdx));
          emitI64Word(code, ctx, true);
          return;
        }
        if (fn === 'input_id') throw new Error('WASM backend: xmbl.utxo.input_id(i) is a ~bytes value — pass it straight to the host call that consumes it (xmbl.utxo.spend / amount / create, xmbl.mayo.verify, xmbl.cubic.verify), it has no 256-bit word form');
        throw new Error('WASM backend: unsupported call xmbl.utxo.' + fn);
      }
      throw new Error('WASM backend: unsupported call ' + (path ? 'xmbl.' + path.join('.') : n.callee && n.callee.kind));
    }
    default: throw new Error('WASM backend: cannot compile expression ' + n.kind);
  }
}
// A ~bytes value, pushed as the (ptr, len) pair every host call that takes bytes expects. Only two forms
// exist, and BOTH are checked here rather than inferred: a LITERAL (bytes in a data segment, length a
// compile-time constant) and `xmbl.utxo.input_id(i)` (bytes the host writes into fresh memory, length in a
// local). Anything else is a hard error — a ~bytes value is never a 256-bit word, so there is no expression
// that could be silently reinterpreted as one.
function emitBytes(n, code, ctx, params, get) {
  if (n && n.kind === 'str') {
    const b = ctx.blob(n.value);
    code.push(O.i32const, ...sleb(b.ptr), O.i32const, ...sleb(b.len));
    return;
  }
  const path = n && n.kind === 'call' ? xmblCallPath(n.callee) : null;
  if (path && path.length === 2 && path[0] === 'utxo' && path[1] === 'input_id') {
    if (!ctx.utxo) throw new Error('WASM backend: xmbl.utxo.input_id requires compile(src, { utxo: true })');
    if (n.args.length !== 1) throw new Error('WASM backend: xmbl.utxo.input_id(i) takes exactly one argument');
    // 8 contiguous 32-byte words = 256 bytes for the id. __alloc is a bump allocator, so back-to-back calls
    // with nothing between them are contiguous; this MUST precede the index expression, which may allocate
    // temporaries of its own. A ledger UTXO id is 16 hex characters, so 256 bytes is 16× the real size.
    code.push(O.call, ...uleb(ctx.H.alloc), O.lset, ...uleb(ctx.bx));
    for (let i = 1; i < 8; i++) code.push(O.call, ...uleb(ctx.H.alloc), O.drop);
    emitP(n.args[0], code, ctx, params, get);
    code.push(O.i32load, ...m32(0));                                  // the index — the word's low 32 bits
    code.push(O.lget, ...uleb(ctx.bx));                               // out pointer
    code.push(O.call, ...uleb(ctx.utxo.inputIdIdx), O.lset, ...uleb(ctx.bl));
    // The host answers -1 for an index that was never presented. Continuing with a negative length would hand
    // the next host call a nonsense region, so this TRAPS: fail-closed, the same shape as `~e`.
    code.push(O.lget, ...uleb(ctx.bl), O.i32const, ...sleb(0), O.i32lts, O.if, 0x40, O.unreachable, O.end);
    code.push(O.lget, ...uleb(ctx.bx), O.lget, ...uleb(ctx.bl));
    return;
  }
  throw new Error('WASM backend: a ~bytes argument must be a literal or xmbl.utxo.input_id(i), got ' + ((n && n.kind) || 'nothing'));
}

// An i64 on the stack → a freshly allocated 256-bit word holding it, which is the backend's value shape.
// `trapOnSentinel` covers the UTXO ABI's -1: widened to an unsigned word it would read as 2^256-1, a value
// indistinguishable from an enormous legitimate amount, so a contract could "spend" a UTXO it does not hold
// and carry the error forward as money. The guest-visible failure form is therefore a TRAP, not a number.
function emitI64Word(code, ctx, trapOnSentinel) {
  code.push(O.lset, ...uleb(ctx.bq));
  if (trapOnSentinel) code.push(O.lget, ...uleb(ctx.bq), O.i64const, ...sleb(-1), O.i64eq, O.if, 0x40, O.unreachable, O.end);
  code.push(O.call, ...uleb(ctx.H.alloc), O.lset, ...uleb(ctx.bp));
  code.push(O.lget, ...uleb(ctx.bp), O.lget, ...uleb(ctx.bq), O.i64store, ...m64(0));
  for (let k = 1; k < 4; k++) code.push(O.lget, ...uleb(ctx.bp), O.i64const, ...sleb(0), O.i64store, ...m64(k * 8));
  code.push(O.lget, ...uleb(ctx.bp));
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