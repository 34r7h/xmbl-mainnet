// XCL host ABI — the seam between a compiled contract (WASM) and the running XMBL chain.
//
// A contract's WASM declares imports under the module name "env"; the host provides them.
// This is the v0 SLOT ABI: state is addressed by integer slot, values are i32. It is a
// real, working subset of the byte-pointer ABI described in docs/agentic-contracts-proto.md
// §3.1 (xmbl_verkle_get/set with key_ptr/key_len). The slot form needs no linear-memory
// marshalling, so it runs today and is fully testable; the byte-pointer form is the
// documented next extension (it changes only this file + the LNG WASM backend, not the
// executor or the state binding).
//
// Imports a contract may declare (deny-by-default — anything else is refused by the runtime):
//   xmbl_verkle_get(slot: i32) -> i32     read this contract's committed state at `slot`
//   xmbl_verkle_set(slot: i32, val: i32)  stage a write to `slot` for this call's diff
//   xmbl_caller()             -> i32      low 32 bits of the (staged) caller id hash
//
// The host functions run INSIDE the compute worker (see ComputeRuntime's host hook) over a
// staged read-set (`ctx.data`) and collect a write-set (`ctx.writes`) posted back to the
// parent, which applies it to real Verkle state. The guest never touches parent state.

/** The import names this ABI defines, as "env.<name>" — the deny-by-default allow surface. */
export const HOST_IMPORT_KEYS = ['env.xmbl_verkle_get', 'env.xmbl_verkle_set', 'env.xmbl_caller'];

/**
 * The host-module factory, as source (it is evaluated inside the worker thread). Given
 * `ctx`, returns the import bindings. `ctx.data` is the staged read-set:
 *   { slots: { [slot:number]: number }, caller: number }
 * `ctx.writes` collects `[slot, value]` pairs; `ctx.log` collects `[op, ...]` traces.
 * @type {string}
 */
export const HOST_ABI_SOURCE = `(ctx) => {
  const slots = (ctx.data && ctx.data.slots) || {};
  const caller = (ctx.data && ctx.data.caller) | 0;
  return {
    'env.xmbl_verkle_get': (slot) => { ctx.log.push(['get', slot]); return slots[slot] | 0; },
    'env.xmbl_verkle_set': (slot, val) => { ctx.writes.push([slot | 0, val | 0]); return 0; },
    'env.xmbl_caller': () => caller,
  };
}`;

/**
 * The Verkle key a contract's storage slot maps to. Namespaced per contract so two
 * contracts never collide, and stable across nodes so every node derives the same key.
 * @param {string} contractId
 * @param {number} slot
 * @returns {string}
 */
export function slotKey(contractId, slot) {
  return `xcl/${contractId}/slot/${slot | 0}`;
}

// ────────────────────────────────────────────────────────────────────────────
// BYTE-POINTER ABI (agentic-contracts-proto.md §3.1) — the extension of the v0
// slot ABI. State is addressed by a BYTE KEY (key_ptr/key_len in the guest's
// linear memory) and the value is the XCL 256-bit word: exactly 32 bytes,
// little-endian, the same layout the LNG WASM backend uses for a `~u256`. This is
// the ABI a full LNG-compiled contract drives, so its state persists across calls
// through Verkle instead of living only in per-instance module memory.
//
// Scope: this is the STATE half of §3.1. The crypto host calls (xmbl_cubic_sig_verify
// / xmbl_mayo_verify / xmbl_lwe_decrypt) are deliberately NOT provided here — the
// compute worker binds host imports SYNCHRONOUSLY from an eval'd source string
// (compute.js), and MAYO needs async Emscripten instantiation that a sync import
// cannot serve without a runtime change; inlining Cubic-SIG/LWE math would grow the
// eval'd-source surface flagged as finding C2 in COMPUTE-ISOLATION-THREAT-MODEL.md.
// Those calls are tracked as the open half of the gate (T6.1-b).
//
//   xmbl_verkle_get(key_ptr:i32, key_len:i32, val_out_ptr:i32) -> u32
//     writes exactly 32 bytes to val_out_ptr (the committed word, or 32 zero bytes
//     if the key was never written), returns 0 ok / 1 key-region OOB / 2 val-region OOB.
//   xmbl_verkle_set(key_ptr:i32, key_len:i32, val_ptr:i32, val_len:i32) -> u32
//     stages a write of the 32-byte word at val_ptr (zero-extended if val_len<32)
//     under the byte key, returns 0 ok / 1 key-region OOB / 2 val-region OOB / 3 val_len>32.
//
// Both functions return a STATUS and never trap on a bad pointer/length (a trap would
// abort the whole call; a contract can check the status). The Uint8Array view is rebuilt
// on EVERY call because ctx.mem().buffer detaches if the guest grows memory.

/** The import names the byte-pointer ABI defines — the deny-by-default allow surface. */
export const HOST_IMPORT_KEYS_BYTES = ['env.xmbl_verkle_get', 'env.xmbl_verkle_set'];

/** The fixed XCL state-word width, in bytes (256-bit little-endian). */
export const XCL_WORD_BYTES = 32;

// ────────────────────────────────────────────────────────────────────────────
// WORD-ABI ARGUMENT / RETURN MARSHALLING — the calling convention for LNG-compiled
// entrypoints. An LNG `~u256` parameter does NOT arrive as a plain integer: the WASM
// backend passes each parameter as an i32 POINTER to a 32-byte little-endian word buffer
// in guest memory, and returns an i32 pointer to a 32-byte word. So a caller that hands
// ContractHost `[7, 3]` for `add(a, b)` would, without marshalling, have 7 and 3 read as
// memory ADDRESSES — the empirical break (`add(7,3)` returns a garbage pointer, not 10).
//
// This is the missing half of the LNG↔XCL seam: the byte-pointer STATE ABI above lets a
// `~u256` FIELD persist through Verkle; this lets a `~u256` ARGUMENT and RETURN VALUE cross
// the ComputeRuntime boundary. It is the exact convention proven by @xmbl/lng's own WASM
// harness (compile-wasm.test.mjs): `__reset()`, then per arg `p = __alloc(); write 32 LE
// bytes at p`, pass the pointers, and decode the returned pointer's 32 LE bytes back to a
// value. It MUST run inside the compute worker — only there is guest memory reachable
// (`ctx.instance.exports.__alloc` / `memory`) — so it is shipped as source and applied by
// the worker's arg/return hook, exactly like the host ABIs above.
//
// It is OPT-IN per contract (ContractHost's `wordAbi` deploy flag): a hand-encoded i32-ABI
// contract must NOT be marshalled (its args and return are plain i32). A word-ABI contract
// that is missing `__alloc` (i.e. was not produced by @xmbl/lng) fails LOUDLY rather than
// silently passing integers through — the fail-closed idiom, never a hidden fallback.

/**
 * Word-ABI marshalling factory, as source (eval'd inside the worker, given the same `ctx`
 * as the host ABIs so it can reach `ctx.instance` after instantiation). Returns:
 *   $args(args)  → maps plain-integer args to pointers to freshly-allocated 32-byte LE words
 *   $result(ptr) → decodes a returned 32-byte LE word pointer back to a BigInt (pass-through
 *                  for a non-pointer return, so a void/i32 entrypoint is unaffected)
 * @type {string}
 */
export const XCL_WORD_MARSHAL_SOURCE = `(ctx) => {
  var WORD = ${XCL_WORD_BYTES};
  var LIMBS = WORD / 8;
  var MASK64 = (1n << 64n) - 1n;
  var FULL = (1n << BigInt(WORD * 8)) - 1n;
  var dv = function () { return new DataView(ctx.instance.exports.memory.buffer); };
  return {
    $args: function (args) {
      var ex = ctx.instance.exports;
      if (typeof ex.__alloc !== 'function') throw new Error('XCL word-abi contract is missing the __alloc export (was it compiled by @xmbl/lng?)');
      if (typeof ex.__reset === 'function') ex.__reset();
      return (args || []).map(function (a) {
        var p = ex.__alloc();
        var v = BigInt(a) & FULL;
        var d = dv();
        for (var i = 0; i < LIMBS; i++) { d.setBigUint64(p + i * 8, v & MASK64, true); v >>= 64n; }
        return p;
      });
    },
    $result: function (ptr) {
      if (typeof ptr !== 'number') return ptr;
      var d = dv();
      var v = 0n;
      for (var i = LIMBS - 1; i >= 0; i--) v = (v << 64n) | d.getBigUint64(ptr + i * 8, true);
      return v;
    },
  };
}`;

/**
 * Byte-pointer host-module factory, as source (eval'd inside the worker). `ctx.data.kv`
 * is the staged read-set: `{ [hexKey:string]: hexValue64chars }`. `ctx.writes` collects
 * tagged byte writes `['bytes', hexKey, hexValue64chars]`; `ctx.mem()` gives the guest's
 * linear memory. Values are 32-byte little-endian words, hex-encoded in byte order.
 * @type {string}
 */
export const HOST_ABI_SOURCE_BYTES = `(ctx) => {
  var VAL = 32;
  var kv = (ctx.data && ctx.data.kv) || {};
  var H = '0123456789abcdef';
  var hexOf = function (u8, a, b) { var s = ''; for (var i = a; i < b; i++) s += H[u8[i] >> 4] + H[u8[i] & 15]; return s; };
  var view = function () { var m = ctx.mem && ctx.mem(); return m ? new Uint8Array(m.buffer) : null; };
  var byteAt = function (hex, i) { return hex ? ((parseInt(hex[i*2],16) << 4) | parseInt(hex[i*2+1],16)) : 0; };
  return {
    'env.xmbl_verkle_get': function (keyPtr, keyLen, valOutPtr) {
      var v = view(); if (!v) return 1;
      if (keyPtr < 0 || keyLen < 0 || keyPtr + keyLen > v.length) return 1;
      if (valOutPtr < 0 || valOutPtr + VAL > v.length) return 2;
      var k = hexOf(v, keyPtr, keyPtr + keyLen);
      var stored = kv[k];
      for (var i = 0; i < VAL; i++) v[valOutPtr + i] = byteAt(stored, i);
      ctx.log.push(['vget', k, stored ? 1 : 0]);
      return 0;
    },
    'env.xmbl_verkle_set': function (keyPtr, keyLen, valPtr, valLen) {
      var v = view(); if (!v) return 1;
      if (keyPtr < 0 || keyLen < 0 || keyPtr + keyLen > v.length) return 1;
      if (valLen > VAL) return 3;
      if (valPtr < 0 || valLen < 0 || valPtr + valLen > v.length) return 2;
      var k = hexOf(v, keyPtr, keyPtr + keyLen);
      var val = '';
      for (var i = 0; i < VAL; i++) { var b = i < valLen ? v[valPtr + i] : 0; val += H[b >> 4] + H[b & 15]; }
      ctx.writes.push(['bytes', k, val]);
      ctx.log.push(['vset', k]);
      return 0;
    },
  };
}`;

/**
 * The Verkle key a contract's BYTE-keyed state entry maps to. Same per-contract
 * namespacing as {@link slotKey}: the guest emits a raw byte key (hex), the host binds
 * it under the contract id so two contracts never collide.
 * @param {string} contractId
 * @param {string} hexKey hex of the guest's key bytes
 * @returns {string}
 */
export function byteKey(contractId, hexKey) {
  return `xcl/${contractId}/bkey/${hexKey}`;
}

// ────────────────────────────────────────────────────────────────────────────
// CRYPTO HOST CALLS (agentic-contracts-proto.md §3.1) — a contract asks the chain to
// VERIFY a signature. Unlike the state ABIs above (whose bindings are pure synchronous
// JS eval'd from a source string), the crypto verifiers are REAL modules from
// @xmbl/identity: this factory `import()`s the package inside the worker rather than
// inlining Cubic-SIG/MAYO math into the eval'd string — the "capability by real module,
// not eval'd source" direction the isolation threat model's finding C2 asks for, so this
// path SHRINKS the eval surface instead of growing it.
//
// ASYNC, resolved: a WASM import must return synchronously, and it does — the only async
// step is MAYO's one-time Emscripten instantiation. This factory is the worker's `host.init`
// hook: it is `await`ed BEFORE the guest is instantiated, loads MAYO once (and ONLY if the
// guest declares env.xmbl_mayo_verify), and returns SYNCHRONOUS import bindings that call the
// already-loaded verifiers. Cubic-SIG verification is pure synchronous JS, no load needed.
//
// DETERMINISM (consensus-critical — ContractHost drives a shared state root): the signature
// MATERIAL (Cubic-SIG {sig, pk, cubeContext}; MAYO {signature, publicKey}) is CHAIN-STAGED
// through `ctx.data.crypto`, identical on every node, so the verdict is identical on every
// node. The guest supplies only the MESSAGE bytes (a pointer+len into its own memory) to
// check against that staged material. Both calls return 1 (valid) / 0 (invalid) and never
// trap. `xmbl_lwe_decrypt` is deliberately NOT here: decryption needs a SECRET key, which is
// neither chain-derivable nor safe to place in a guest's reach — it is carried as an open item.

/** The import names the crypto ABI defines — the deny-by-default allow surface. */
export const HOST_IMPORT_KEYS_CRYPTO = ['env.xmbl_cubic_sig_verify', 'env.xmbl_mayo_verify'];

/**
 * Crypto host-call initializer, as source (eval'd inside the worker and AWAITED before the
 * guest is instantiated). Signature `async (ctx, declared) => ({ "env.name": fn, ... })`:
 * `declared` is the guest's declared import keys (so MAYO is loaded only when needed), `ctx`
 * is the same context object the state ABIs get (`ctx.mem()` gives guest memory after
 * instantiation, `ctx.data.crypto` is the staged signature material, `ctx.log` collects a
 * trace). Returns synchronous verify bindings.
 * @type {string}
 */
export const HOST_ABI_CRYPTO_INIT_SOURCE = `async (ctx, declared) => {
  var id = await import('@xmbl/identity');
  var need = declared || [];
  var mayo = null;
  if (need.indexOf('env.xmbl_mayo_verify') !== -1) mayo = await id.MAYOWasm.load();
  var crypto = (ctx.data && ctx.data.crypto) || {};
  var readBytes = function (ptr, len) {
    var m = ctx.mem && ctx.mem(); if (!m) return null;
    if (ptr < 0 || len < 0 || ptr + len > m.buffer.byteLength) return null;
    return new Uint8Array(m.buffer.slice(ptr, ptr + len));
  };
  var out = {};
  out['env.xmbl_cubic_sig_verify'] = function (msgPtr, msgLen) {
    var msg = readBytes(msgPtr, msgLen); if (!msg) return 0;
    var c = crypto.cubicSig; if (!c || !c.sig || !c.pk || !c.cubeContext) return 0;
    var ok = id.cubicSigVerify(msg, c.sig, c.pk, c.cubeContext) ? 1 : 0;
    ctx.log.push(['cubic_sig_verify', msgLen, ok]);
    return ok;
  };
  out['env.xmbl_mayo_verify'] = function (msgPtr, msgLen) {
    if (!mayo) return 0;
    var msg = readBytes(msgPtr, msgLen); if (!msg) return 0;
    var c = crypto.mayo; if (!c || !c.signature || !c.publicKey) return 0;
    var ok = mayo.verifySync(msg, c.signature, c.publicKey) ? 1 : 0;
    ctx.log.push(['mayo_verify', msgLen, ok]);
    return ok;
  };
  return out;
}`;

// ────────────────────────────────────────────────────────────────────────────
// UTXO VALUE ABI — the seam that LINKS xmbl UTXOs to the Verkle state machine.
//
// An xmbl UTXO is a ledger record the state machine already commits to the SAME Verkle
// tree XCL writes into: state-machine.js maps a `utxo` block to the key `utxo:<id>` with
// value `{ from, to, amount }` (id = the block's content hash). This ABI lets a contract
// SPEND those committed UTXOs and CREATE new ones, so contract execution and value
// transfer share one provable state root.
//
// The spend model matches the ledger's type-6/type-7 rule (micromine.js): spent-ness is
// DERIVED FROM A SEPARATE POINTER, never by mutating the value datum. Spending a UTXO does
// not touch its `utxo:<id>` record — it writes a distinct nullifier key `spend:<id>`. So
// the record stays immutable and a double-spend is a key that already exists.
//
// A contract does NOT hardcode the ids it spends: it enumerates the inputs the caller
// PRESENTED (xmbl_input_count / xmbl_input_id), so the same bytecode spends a
// content-addressed ledger id it could never have known at compile time.
//
//   xmbl_input_count() -> i32            number of UTXOs staged as this call's inputs
//   xmbl_input_id(i:i32, out:i32) -> i32 writes input i's id bytes to `out`, returns its
//                                        byte length (-1 if i is out of range / region OOB)
//   xmbl_utxo_amount(id_ptr, id_len:i32) -> i64  the staged amount of input `id`
//                                        (-1 if `id` was not presented as an input)
//   xmbl_utxo_spend(id_ptr, id_len:i32)  -> i64  mark input `id` spent for this call and
//                                        return its amount (-1 if not an input, or already
//                                        spent in THIS call)
//   xmbl_utxo_create(to_ptr, to_len:i32, amount:i64) -> i64  create an output UTXO to
//                                        recipient `to` of `amount` (0 ok, -1 if amount<=0)
//
// Amounts cross as i64 (BigInt at the JS boundary). The host COLLECTS spends and creates in
// ctx.writes tagged ['utxo_spend', id] / ['utxo_create', to, amountDecimalString]; it does
// NOT check conservation here (a WASM import cannot abort the whole call cleanly). ContractHost
// enforces conservation (sum(spent) === sum(created) + fee) FAIL-CLOSED after the run, applying
// nothing on a mint — see contract-host.js.

/** The import names the UTXO value ABI defines — the deny-by-default allow surface. */
export const HOST_IMPORT_KEYS_UTXO = [
  'env.xmbl_input_count', 'env.xmbl_input_id',
  'env.xmbl_utxo_amount', 'env.xmbl_utxo_spend', 'env.xmbl_utxo_create',
];

// ────────────────────────────────────────────────────────────────────────────
// COMPOSITION ABI — contract-to-contract interaction WITHOUT synchronous nested
// execution. This is the seam that makes XCL ≥ Ethereum in composition power while
// being STRICTLY safer: classic reentrancy is impossible BY CONSTRUCTION, not by a
// developer-supplied guard (the EVM `nonReentrant` mutex / checks-effects-interactions
// discipline that every drained contract forgot). There is no primitive by which a
// contract yields control to another contract's code mid-execution, so the DAO pattern
// (call out → get re-entered before state is updated) cannot be expressed.
//
// Two primitives, split by whether they run code:
//
//   xmbl_read(peer_idx:i32, slot:i32) -> i32   SYNCHRONOUS cross-contract state read.
//     Reads NO code — it returns peer[peer_idx]'s committed/staged slot value, which the
//     host PRE-STAGES into ctx.data.foreign before the guest starts (exactly as utxos/kv
//     are staged). A read executes nothing in the peer, so it carries ZERO reentrancy risk
//     — this is the balanceOf/oracle-read/allowance case that makes composition usable, and
//     it is safe to serve synchronously. The read footprint is DECLARED up front (the
//     contract's `reads`), so an undeclared (peer, slot) pair TRAPS — fail-closed, and the
//     footprint is statically bounded (stronger than an EVM STATICCALL, which can read
//     anything at any depth with no static bound).
//
//   xmbl_send(peer_idx:i32, amount:i32) -> i32  ASYNCHRONOUS message to peer[peer_idx].
//     Does NOT execute the peer. It records `['send', peer_idx, amount]` in the write-set;
//     the host resolves peer_idx → {id, fn} from THIS contract's peer table and enqueues a
//     message. The target runs as a SEPARATE frame AFTER this one completes — never nested.
//     Returns 0 ok / -1 if peer_idx is out of range. The message carries one i32 argument
//     (the value/amount); the sender is surfaced to the target via xmbl_caller.
//
// The host runs the whole cascade (the entry call plus every message it transitively emits)
// as ONE atomic transaction: nothing commits until it completes, any frame that throws
// reverts everything, and the frame count is capped so a message loop terminates in a revert
// rather than draining resources. Conservation (UTXO) is checked once over the UNION of all
// frames. This is the i32-slot subset (mirrors the v0 slot ABI being a working subset of the
// byte-pointer ABI): the ~u256/byte-key form is the documented next extension and changes only
// this file, not the cascade machinery in contract-host.js.

/** The import names the composition ABI defines — the deny-by-default allow surface. */
export const HOST_IMPORT_KEYS_COMPOSE = ['env.xmbl_read', 'env.xmbl_send'];

/**
 * Composition host-module factory, as source (eval'd inside the worker). `ctx.data.peers` is
 * THIS contract's peer table `[{id, fn}]` (only its length is consulted here — the host maps
 * an index to {id, fn} on the trusted side when it drains the queue). `ctx.data.foreign` is the
 * pre-staged read-set `{ 'peerIdx|slot': i32value }`. `ctx.writes` collects `['send', idx, amt]`.
 * @type {string}
 */
export const HOST_ABI_COMPOSE_SOURCE = `(ctx) => {
  var peers = (ctx.data && ctx.data.peers) || [];
  var foreign = (ctx.data && ctx.data.foreign) || {};
  var has = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };
  return {
    'env.xmbl_read': function (peerIdx, slot) {
      var key = (peerIdx | 0) + '|' + (slot | 0);
      // Undeclared foreign read → TRAP (fail-closed). The whole transaction reverts: a read
      // outside the declared footprint is a malformed transaction, not a recoverable status.
      if (!has(foreign, key)) throw new Error('xcl compose: undeclared foreign read (peer ' + (peerIdx|0) + ' slot ' + (slot|0) + ')');
      ctx.log.push(['read', peerIdx | 0, slot | 0]);
      return foreign[key] | 0;
    },
    'env.xmbl_send': function (peerIdx, amount) {
      if ((peerIdx | 0) < 0 || (peerIdx | 0) >= peers.length) return -1;
      ctx.writes.push(['send', peerIdx | 0, amount | 0]);
      ctx.log.push(['send', peerIdx | 0, amount | 0]);
      return 0;
    },
  };
}`;

// ────────────────────────────────────────────────────────────────────────────
// WORD-ABI COMPOSITION — the `~u256` form of the composition ABI, for LNG-compiled
// contracts. Mirrors the relationship between the v0 slot ABI (HOST_ABI_SOURCE, plain
// i32) and the byte-pointer state ABI (HOST_ABI_SOURCE_BYTES, 32-byte words): an
// LNG-compiled (wordAbi) contract's values are POINTERS to 32-byte little-endian words in
// guest memory, so its composition primitives take pointers, not plain integers. The
// cascade machinery in contract-host.js is UNCHANGED — only the argument encoding differs,
// exactly as the T6.2c gate row predicted ("the ~u256/byte-key form … changes only this
// file, not the cascade machinery").
//
//   xmbl_send(peer_ptr:i32, amount_ptr:i32) -> i32   ASYNCHRONOUS message. Reads the peer
//     INDEX from the low 32 bits of the 32-byte word at peer_ptr and the FULL 256-bit amount
//     from the word at amount_ptr. Records ['send', peerIdx, amountDecimalString]; the host
//     resolves peerIdx → {id, fn} from this contract's peer table and enqueues a SEPARATE
//     frame (never nested — reentrancy stays impossible by construction). Returns 0 ok / -1
//     on out-of-range peer or a bad pointer. The full word value crosses the message boundary
//     faithfully (decimal string → BigInt → the target's word marshal), so a `~u256` amount is
//     NOT truncated to i32.
//
//   xmbl_read(peer_ptr:i32, field_ptr:i32, val_out_ptr:i32) -> i32   SYNCHRONOUS word-valued
//     cross-contract read. Reads NO peer code (reentrancy-free, like the i32 read). peer_ptr and
//     field_ptr are 32-byte words: the peer INDEX and the peer's FIELD INDEX (its position in the
//     peer's ordered public-field list). The host PRE-STAGES the declared (peer, field) words into
//     ctx.data.foreign before the guest starts, keyed "peerIdx|fieldIdx"; this call writes the
//     staged 32-byte word into val_out_ptr and returns 0. Unlike send (which returns a status the
//     guest may ignore), read produces a VALUE the guest consumes, so every error condition TRAPS
//     (fail-closed) rather than returning a status + a silent-zero word: an out-of-range pointer,
//     an out-of-range peer index, or an UNDECLARED (peer, field) pair reverts the whole cascade. A
//     word contract keys state by field NAME (byteKey), so the host resolves fieldIdx → the peer's
//     field name → that peer's committed word when it stages — the reader names only indices, and
//     link() range-checks fieldIdx against the peer's deployed field list (typo-proof, fail-closed).

/** The import names the word-ABI composition ABI defines — the deny-by-default allow surface. */
export const HOST_IMPORT_KEYS_COMPOSE_WORD = ['env.xmbl_read', 'env.xmbl_send'];

/**
 * Word-ABI composition host-module factory, as source (eval'd inside the worker). Reads its
 * arguments as 32-byte little-endian words from guest memory via `ctx.mem()` (same mechanism as
 * HOST_ABI_SOURCE_BYTES). `ctx.data.peers` is this contract's peer table (only its length is
 * consulted here). `ctx.data.foreign` is the pre-staged read-set `{ "peerIdx|fieldIdx": hex64LE }`
 * (each value the peer's committed 32-byte little-endian word, 32 zero bytes if unwritten).
 * `ctx.writes` collects `['send', peerIdx, amountDecimalString]`; reads mutate no state.
 * @type {string}
 */
export const HOST_ABI_COMPOSE_SOURCE_WORD = `(ctx) => {
  var WORD = ${XCL_WORD_BYTES};
  var peers = (ctx.data && ctx.data.peers) || [];
  var foreign = (ctx.data && ctx.data.foreign) || {};
  var has = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };
  var view = function () { var m = ctx.mem && ctx.mem(); return m ? new Uint8Array(m.buffer) : null; };
  var wordAt = function (v, ptr) { var x = 0n; for (var i = WORD - 1; i >= 0; i--) x = (x << 8n) | BigInt(v[ptr + i]); return x; };
  return {
    'env.xmbl_send': function (peerPtr, amountPtr) {
      var v = view(); if (!v) return -1;
      if (peerPtr < 0 || peerPtr + WORD > v.length) return -1;
      if (amountPtr < 0 || amountPtr + WORD > v.length) return -1;
      // Read the peer index as the FULL 256-bit word and range-check it — NEVER mask to the low
      // limb. Masking would be FAIL-OPEN: a word with nonzero high bits (a buggy or adversarial
      // peer-index computation) would silently land on peers[lowBits] instead of being refused.
      var peerWord = wordAt(v, peerPtr);
      if (peerWord < 0n || peerWord >= BigInt(peers.length)) return -1;
      var peerIdx = Number(peerWord);
      var amount = wordAt(v, amountPtr).toString();
      ctx.writes.push(['send', peerIdx, amount]);
      ctx.log.push(['send', peerIdx, amount]);
      return 0;
    },
    'env.xmbl_read': function (peerPtr, fieldPtr, valOutPtr) {
      var v = view();
      // Every failure TRAPS (reverts the cascade) — a read yields a value the guest consumes, so a
      // status + zero word would be FAIL-OPEN (the guest would read 0 and likely ignore the status).
      if (!v) throw new Error('xcl compose: guest memory unavailable during xmbl_read');
      if (peerPtr < 0 || peerPtr + WORD > v.length) throw new Error('xcl compose: xmbl_read peer pointer out of bounds');
      if (fieldPtr < 0 || fieldPtr + WORD > v.length) throw new Error('xcl compose: xmbl_read field pointer out of bounds');
      if (valOutPtr < 0 || valOutPtr + WORD > v.length) throw new Error('xcl compose: xmbl_read result pointer out of bounds');
      var peerWord = wordAt(v, peerPtr);
      if (peerWord < 0n || peerWord >= BigInt(peers.length)) throw new Error('xcl compose: xmbl_read peer index out of range');
      var fieldWord = wordAt(v, fieldPtr);
      var key = peerWord.toString() + '|' + fieldWord.toString();
      if (!has(foreign, key)) throw new Error('xcl compose: undeclared foreign read (peer ' + peerWord.toString() + ' field ' + fieldWord.toString() + ')');
      var hex = foreign[key];
      for (var i = 0; i < WORD; i++) v[valOutPtr + i] = (parseInt(hex[i * 2], 16) << 4) | parseInt(hex[i * 2 + 1], 16);
      ctx.log.push(['read', peerWord.toString(), fieldWord.toString()]);
      return 0;
    },
  };
}`;

/** Derive a stable i32 caller tag from a (hex) contract id — surfaced to a message target via xmbl_caller. */
export function callerTag(id) { return parseInt(String(id).slice(0, 8), 16) | 0; }

/** The Verkle key an xmbl UTXO record maps to — the SAME namespace state-machine.js writes. */
export function utxoKey(id) { return `utxo:${id}`; }

/** The Verkle key a UTXO's spend-marker (nullifier) maps to. Spending writes THIS, never the record. */
export function spendKey(id) { return `spend:${id}`; }

/**
 * UTXO value host-module factory, as source (eval'd inside the worker). `ctx.data.utxos` is the
 * staged input read-set `{ [id:string]: amountDecimalString }`; `ctx.data.inputIds` is the
 * deterministic (sorted) list of those ids. `ctx.writes` collects tagged UTXO ops; `ctx.mem()`
 * gives guest memory. i64 amounts arrive/return as BigInt.
 * @type {string}
 */
export const HOST_ABI_UTXO_SOURCE = `(ctx) => {
  var utxos = (ctx.data && ctx.data.utxos) || {};
  var ids = (ctx.data && ctx.data.inputIds) || [];
  var spent = {};
  var view = function () { var m = ctx.mem && ctx.mem(); return m ? new Uint8Array(m.buffer) : null; };
  var strAt = function (ptr, len) {
    var v = view(); if (!v) return null;
    if (ptr < 0 || len < 0 || ptr + len > v.length) return null;
    var s = ''; for (var i = 0; i < len; i++) s += String.fromCharCode(v[ptr + i]); return s;
  };
  var has = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };
  return {
    'env.xmbl_input_count': function () { return ids.length | 0; },
    'env.xmbl_input_id': function (i, outPtr) {
      if (i < 0 || i >= ids.length) return -1;
      var v = view(); if (!v) return -1;
      var id = ids[i];
      if (outPtr < 0 || outPtr + id.length > v.length) return -1;
      for (var k = 0; k < id.length; k++) v[outPtr + k] = id.charCodeAt(k) & 0xff;
      return id.length | 0;
    },
    'env.xmbl_utxo_amount': function (idPtr, idLen) {
      var id = strAt(idPtr, idLen); if (id === null) return -1n;
      if (!has(utxos, id)) return -1n;
      return BigInt(utxos[id]);
    },
    'env.xmbl_utxo_spend': function (idPtr, idLen) {
      var id = strAt(idPtr, idLen); if (id === null) return -1n;
      if (!has(utxos, id)) return -1n;
      if (spent[id]) return -1n;
      spent[id] = true;
      ctx.writes.push(['utxo_spend', id]);
      ctx.log.push(['utxo_spend', id]);
      return BigInt(utxos[id]);
    },
    'env.xmbl_utxo_create': function (toPtr, toLen, amount) {
      var to = strAt(toPtr, toLen); if (to === null) return -1n;
      var amt = BigInt(amount);
      if (amt <= 0n) return -1n;
      ctx.writes.push(['utxo_create', to, amt.toString()]);
      ctx.log.push(['utxo_create', to, amt.toString()]);
      return 0n;
    },
  };
}`;
