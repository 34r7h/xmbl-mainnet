import { createHash } from 'node:crypto';
import {
  HOST_ABI_SOURCE, HOST_ABI_SOURCE_BYTES, XCL_WORD_MARSHAL_SOURCE, HOST_ABI_CRYPTO_INIT_SOURCE,
  HOST_ABI_UTXO_SOURCE, slotKey, byteKey, utxoKey, spendKey, XCL_WORD_BYTES,
} from './abi.js';
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
      // cryptoHost: the contract calls the §3.1 crypto verifiers (env.xmbl_cubic_sig_verify /
      // env.xmbl_mayo_verify). When set, ContractHost attaches the async crypto init hook so
      // those imports bind to the REAL @xmbl/identity verifiers, and stages the signature
      // material from the call's `opts.crypto` (chain-provided, identical on every node).
      cryptoHost: !!deployOpts.cryptoHost,
      // utxoHost: the contract SPENDS and CREATES xmbl UTXOs (env.xmbl_utxo_* / env.xmbl_input_*).
      // When set, ContractHost stages the input UTXOs named in `opts.inputs` from committed Verkle
      // state, attaches the UTXO value ABI, then enforces value conservation FAIL-CLOSED after the
      // run — a call that mints value (out > in) is refused and applies nothing.
      utxoHost: !!deployOpts.utxoHost,
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

    // UTXO input read-set (utxoHost contracts): every id in `opts.inputs`, read from committed
    // Verkle state as the ledger-produced `utxo:<id>` record. FAIL-CLOSED at staging: an input
    // that does not exist, or one already carrying a `spend:<id>` marker (a double-spend), is
    // refused before any WASM runs. inputIds is SORTED so xmbl_input_id(i) is identical on every
    // node — the read-set a contract sees must be a pure function of the presented set.
    let utxos = null; let inputIds = null;
    if (c.utxoHost) {
      utxos = {}; inputIds = [...new Set((opts.inputs || []).map(String))].sort();
      for (const uid of inputIds) {
        if (this.state.get(spendKey(uid)) !== undefined) {
          throw new Error(`ContractHost.call: input utxo ${uid} is already spent (double-spend refused)`);
        }
        const rec = this.state.get(utxoKey(uid));
        if (rec === undefined || rec === null) {
          throw new Error(`ContractHost.call: input utxo ${uid} does not exist`);
        }
        const amt = (rec && typeof rec === 'object') ? rec.amount : rec;
        if (amt === undefined || amt === null) throw new Error(`ContractHost.call: input utxo ${uid} has no amount`);
        utxos[uid] = String(amt);
      }
    }

    // The byte-pointer ABI and the v0 slot ABI collide on the names xmbl_verkle_get/set (different
    // signatures), so a call uses exactly ONE of them per the contract's kind. The UTXO value ABI
    // uses disjoint names (xmbl_utxo_* / xmbl_input_*), so it composes onto whichever state ABI the
    // contract uses — both sub-factories are eval'd over the same ctx and their bindings merged.
    const stateSource = c.byteState ? HOST_ABI_SOURCE_BYTES : HOST_ABI_SOURCE;
    const source = c.utxoHost
      ? `(ctx) => Object.assign({}, (${stateSource})(ctx), (${HOST_ABI_UTXO_SOURCE})(ctx))`
      : stateSource;

    const host = {
      source,
      // A cryptoHost contract also gets the staged signature material under `crypto`, read by
      // the crypto init bindings and identical on every node (so the verdict is deterministic).
      // A utxoHost contract gets the staged input UTXOs and their sorted id list.
      data: { slots, caller: (opts.caller | 0), kv, crypto: c.cryptoHost ? (opts.crypto || null) : null, utxos, inputIds },
      // A word-ABI (LNG-compiled) contract needs its `~u256` args marshalled into guest-memory
      // word pointers and its returned pointer decoded; a hand-encoded i32-ABI contract does not.
      marshal: c.wordAbi ? XCL_WORD_MARSHAL_SOURCE : null,
      // A cryptoHost contract needs the async crypto verifiers bound before it runs.
      init: c.cryptoHost ? HOST_ABI_CRYPTO_INIT_SOURCE : null,
    };
    // The runtime satisfies an import from the host module if the ABI provides it, and denies
    // anything else — so the ABI keys ARE the allow surface for this call, scoped to this call.
    // We deliberately do NOT widen the runtime's persistent `allowedImports`: mutating a shared
    // runtime would leak a standing allowance to later, unrelated jobs on the same instance.
    const { result, writes } = await this.runtime.execute(c.wasm, fnName, args, { host });

    // ── UTXO CONSERVATION — the security property, enforced FAIL-CLOSED before ANY write lands.
    // Value cannot be minted: the sum of the UTXOs this call spends must equal the sum it creates
    // plus the fee. This is checked BEFORE applying the write-set, so a violating call reverts
    // WHOLLY — no spend marker, no output, no slot/byte write, the state root unmoved. This is
    // where XCL refuses an unbalanced value transition, exactly as it refuses an unauthorized one.
    const spentIds = [];
    const outputs = [];
    for (const w of writes) {
      if (w[0] === 'utxo_spend') spentIds.push(w[1]);
      else if (w[0] === 'utxo_create') outputs.push({ to: w[1], amount: BigInt(w[2]) });
    }
    let created = [];
    if (spentIds.length || outputs.length) {
      let sumIn = 0n;
      for (const uid of spentIds) {
        // Re-assert every guard the ABI enforced in-worker, on the trusted side. A spend of a UTXO
        // not staged as an input, or one already spent in committed state, is refused here too.
        if (!utxos || !Object.prototype.hasOwnProperty.call(utxos, uid)) {
          throw new Error(`ContractHost.call: spent utxo ${uid} was not a staged input`);
        }
        if (this.state.get(spendKey(uid)) !== undefined) {
          throw new Error(`ContractHost.call: input utxo ${uid} is already spent (double-spend refused)`);
        }
        sumIn += BigInt(utxos[uid]);
      }
      let sumOut = 0n;
      for (const o of outputs) sumOut += o.amount;
      const fee = BigInt(opts.fee || 0);
      if (sumIn !== sumOut + fee) {
        throw new Error(`ContractHost.call: value not conserved (in=${sumIn} out=${sumOut} fee=${fee}) — mint refused`);
      }
    }

    // Apply the write-set atomically. Byte writes are tagged `['bytes', hexKey, hexVal]`
    // (entry[0] is the string 'bytes'); slot writes are `[slotNum, valNum]` (entry[0] is a
    // number). Tag-checking each entry keeps the ABIs from mis-applying each other's writes.
    for (const w of writes) {
      if (w[0] === 'utxo_spend') {
        // Spend-marker (nullifier): a SEPARATE key, never a mutation of the value record — the
        // ledger's rule (micromine.js) that spent-ness is derived from a pointer, not the datum.
        await this.state.insert(spendKey(w[1]), { by: id, spentBy: fnName });
      } else if (w[0] === 'utxo_create') {
        // A created output's id is content-addressed (same 16-hex scheme as a ledger block id), a
        // pure function of the creating contract, recipient, amount and the exact set of inputs it
        // consumed — deterministic and identical on every node, so replay reproduces the same key.
        const to = w[1]; const amount = w[2];
        const idx = created.length;
        const newId = createHash('sha256')
          .update(JSON.stringify({ from: id, to, amount, spends: [...spentIds].sort(), i: idx }))
          .digest('hex').slice(0, 16);
        await this.state.insert(utxoKey(newId), { from: id, to, amount });
        created.push({ id: newId, to, amount });
      } else if (typeof w[0] === 'string' && w[0] === 'bytes') {
        const [, hk, hv] = w;
        c.byteKeys.add(hk);
        await this.state.insert(byteKey(id, hk), hv);
      } else {
        const [slot, val] = w;
        c.slots.add(slot | 0);
        await this.state.insert(slotKey(id, slot), val | 0);
      }
    }
    const out = { result, writes, stateRoot: this.state.getRoot(), coordinates: c.coordinates };
    if (c.utxoHost) out.utxo = { spent: spentIds, created };
    return out;
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
