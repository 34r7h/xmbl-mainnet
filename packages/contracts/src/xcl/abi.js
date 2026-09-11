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
