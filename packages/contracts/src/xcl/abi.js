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
