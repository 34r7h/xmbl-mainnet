import { HOST_ABI_SOURCE, HOST_ABI_SOURCE_BYTES, XCL_WORD_MARSHAL_SOURCE, slotKey, byteKey, XCL_WORD_BYTES } from './abi.js';
import { contractId, contractCoordinates } from './placement.js';
import { InMemoryState } from './in-memory-state.js';

// ContractHost — the XMBL Contract Layer runtime. It binds a compiled contract (WASM) to
// the chain WITHOUT owning any of the pieces that belong to other modules:
//   - sandboxed WASM execution is delegated to an injected runtime (storage-compute's
//     ComputeRuntime) — XCL never calls WebAssembly.* itself;
//   - state lives in an injected store (state-machine's VerkleStateTree) — XCL never
//     implements a state tree;
//   - signature/identity checks are the identity module's job — XCL only carries the
//     cubic coordinates that bind them.
// XCL's own job is the contract semantics: content-addressed placement, the storage-slot ↔
// Verkle-key mapping, staging the read-set, and applying the write-set as one atomic diff.
//
// This is why "storage-compute includes state machine and smart contracting": in the full
// node, a ComputeNode holds a ComputeRuntime + a VerkleStateTree + a ContractHost, and that
// composition IS contract execution — no module re-implements another's feature.

export class ContractHost {
  /**
   * @param {object} deps
   * @param {{execute:Function}} deps.runtime a ComputeRuntime (or anything with the same
   *   `execute(bytes, fn, args, { host })` contract). REQUIRED — XCL does not sandbox.
   * @param {{get:Function, insert:Function, getRoot:Function}} [deps.state] a VerkleStateTree
   *   or compatible store. Defaults to an in-memory store so the module works standalone.
   * @param {{verify:(presentation:object)=>Promise<{ok:boolean,reason?:string}>}} [deps.authorizer]
   *   OPTIONAL true-impute delegation authorizer (identity `makeAuthorizer`). When present, a
   *   call carrying `opts.auth` is REJECTED before any WASM runs unless the full delegation chain
   *   (root → TEE coordinator → ZSP token → agent action-sig) verifies for this contract as the
   *   audience. This is the load-bearing enforcement seam: identity checks the chain, XCL refuses
   *   the state transition. A contract deployed as `gated` with no authorizer configured cannot
   *   be called — fail closed, never open.
   */
  constructor({ runtime, state, authorizer } = {}) {
    if (!runtime || typeof runtime.execute !== 'function') {
      throw new Error('ContractHost requires a runtime with execute() (e.g. @xmbl/storage-compute ComputeRuntime)');
    }
    this.runtime = runtime;
    this.state = state || new InMemoryState();
    this.authorizer = authorizer || null;
    this.contracts = new Map(); // id -> { wasm, coordinates, slots:Set, gated:boolean }
  }

  /**
   * Place a contract at its deterministic cubic coordinates. Pure: same bytes → same id and
   * coordinates on every node. Does not touch state.
   * @param {Uint8Array} wasmBytes compiled contract (e.g. from LNG `compile`)
   * @param {number[]} [slots=[]] the storage slots this contract uses (its state footprint)
   * @returns {{id:string, coordinates:object}}
   */
  deploy(wasmBytes, slots = [], deployOpts = {}) {
    const bytes = wasmBytes instanceof Uint8Array ? wasmBytes : Uint8Array.from(wasmBytes);
    const id = contractId(bytes);
    const coordinates = contractCoordinates(id);
    this.contracts.set(id, {
      wasm: bytes, coordinates, slots: new Set(slots.map((s) => s | 0)),
      gated: !!deployOpts.gated,   // a gated contract requires a passing delegation chain on every call
      // byteState: the contract was compiled with the byte-pointer ABI (LNG `compile(src,
      // {hostState:true})`), so its `~u256` fields persist through Verkle as 32-byte words
      // under byte keys. byteKeys grows as writes are observed, exactly like `slots`.
      byteState: !!deployOpts.byteState,
      byteKeys: new Set(),
      // wordAbi: the contract uses the LNG word calling convention — `~u256` args arrive as
      // pointers to 32-byte little-endian word buffers and the return value is such a pointer.
      // When set, ContractHost hands the runtime the word marshal so plain-integer args are
      // written into guest memory and the returned pointer is decoded to a BigInt. A
      // hand-encoded i32-ABI contract leaves this off and its args/return pass through as-is.
      wordAbi: !!deployOpts.wordAbi,
    });
    return { id, coordinates };
  }

  /**
   * Call a contract entrypoint. Stages the contract's committed slot values as the read-set,
   * runs the WASM under the injected runtime with the XCL host ABI, then applies the
   * collected write-set to state as one diff and returns the new root.
   *
   * @param {string} id contract id from {@link deploy}
   * @param {string} fnName exported entrypoint
   * @param {Array<number|bigint>} [args=[]] entrypoint arguments — plain i32 for a hand-encoded
   *   contract; for a `wordAbi` (LNG-compiled) contract, `~u256` values (Number or BigInt) that
   *   are marshalled into 32-byte little-endian word pointers before the call
   * @param {object} [opts]
   * @param {number} [opts.caller=0] caller id (low 32 bits surfaced via xmbl_caller)
   * @returns {Promise<{result:(number|bigint), writes:Array, stateRoot:string, coordinates:object}>}
   *   `result` is the entrypoint return: an i32 for a hand-encoded contract, a decoded BigInt
   *   (the returned 32-byte word) for a `wordAbi` contract
   */
  async call(id, fnName, args = [], opts = {}) {
    const c = this.contracts.get(id);
    if (!c) throw new Error(`ContractHost.call: unknown contract ${id}`);

    // ENFORCEMENT — the true-impute gate, load-bearing and fail-closed. A gated contract runs
    // ONLY when the delegation chain verifies for THIS contract (id as audience) and the action
    // (fnName) is in the token's scope. No authorizer configured but the contract is gated → the
    // call is refused, never silently allowed. This is where identity's verifyChain stops an
    // unauthorized state transition from ever touching the WASM or the state tree.
    if (c.gated) {
      if (!this.authorizer) throw new Error(`ContractHost.call: contract ${id} is gated but no authorizer is configured (fail-closed)`);
      const pres = opts.auth ? { ...opts.auth, action: fnName, args } : null;
      const decision = pres ? await this.authorizer.verify(pres) : { ok: false, reason: 'no-authorization-presented' };
      if (!decision.ok) throw new Error(`ContractHost.call: unauthorized (${decision.reason}) for ${fnName} on ${id}`);
    }

    // Stage the read-set: every slot the contract declared, read from committed state.
    const slots = {};
    for (const slot of c.slots) {
      const v = this.state.get(slotKey(id, slot));
      slots[slot] = (v === undefined || v === null) ? 0 : (v | 0);
    }
    // Byte-keyed read-set (byteState contracts): every byte key the contract has touched,
    // read from committed state as its 32-byte hex word. A key never written stays absent
    // (the ABI's get zero-fills it), so a fresh contract stages nothing.
    const kv = {};
    for (const hk of c.byteKeys) {
      const v = this.state.get(byteKey(id, hk));
      if (v !== undefined && v !== null) kv[hk] = v;
    }

    const host = {
      // The byte-pointer ABI and the v0 slot ABI collide on the names xmbl_verkle_get/set
      // (different signatures), so a call uses exactly ONE of them per the contract's kind.
      source: c.byteState ? HOST_ABI_SOURCE_BYTES : HOST_ABI_SOURCE,
      data: { slots, caller: (opts.caller | 0), kv },
      // A word-ABI (LNG-compiled) contract needs its `~u256` args marshalled into guest-memory
      // word pointers and its returned pointer decoded; a hand-encoded i32-ABI contract does not.
      marshal: c.wordAbi ? XCL_WORD_MARSHAL_SOURCE : null,
    };
    // The runtime satisfies an import from the host module if the ABI provides it, and denies
    // anything else — so the ABI keys ARE the allow surface for this call, scoped to this call.
    // We deliberately do NOT widen the runtime's persistent `allowedImports`: mutating a shared
    // runtime would leak a standing allowance to later, unrelated jobs on the same instance.
    const { result, writes } = await this.runtime.execute(c.wasm, fnName, args, { host });

    // Apply the write-set atomically. Byte writes are tagged `['bytes', hexKey, hexVal]`
    // (entry[0] is the string 'bytes'); slot writes are `[slotNum, valNum]` (entry[0] is a
    // number). Tag-checking each entry keeps the two ABIs from mis-applying each other's writes.
    for (const w of writes) {
      if (typeof w[0] === 'string' && w[0] === 'bytes') {
        const [, hk, hv] = w;
        c.byteKeys.add(hk);
        await this.state.insert(byteKey(id, hk), hv);
      } else {
        const [slot, val] = w;
        c.slots.add(slot | 0);
        await this.state.insert(slotKey(id, slot), val | 0);
      }
    }
    return { result, writes, stateRoot: this.state.getRoot(), coordinates: c.coordinates };
  }

  /** Read a contract's committed slot value (0 if never written). */
  getSlot(id, slot) {
    const v = this.state.get(slotKey(id, slot));
    return (v === undefined || v === null) ? 0 : (v | 0);
  }

  /**
   * Read a byteState contract's committed field as a BigInt (0n if never written). The field
   * name is the byte key; its value is the 32-byte little-endian XCL word. This is how a caller
   * observes an LNG-compiled contract's persisted state without re-entering the WASM (whose
   * return value is only an in-worker memory pointer).
   * @param {string} id
   * @param {string} name field name (as written in the LNG `~state` block)
   * @returns {bigint}
   */
  getBytes(id, name) {
    const hk = Buffer.from(name, 'utf8').toString('hex');
    const hv = this.state.get(byteKey(id, hk));
    if (hv === undefined || hv === null) return 0n;
    let v = 0n;
    for (let i = 0; i < XCL_WORD_BYTES; i++) v |= BigInt(parseInt(hv.slice(i * 2, i * 2 + 2), 16)) << BigInt(i * 8);
    return v;
  }
}
