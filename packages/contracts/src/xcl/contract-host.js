import { createHash } from 'node:crypto';
import {
  HOST_ABI_SOURCE, HOST_ABI_SOURCE_BYTES, XCL_WORD_MARSHAL_SOURCE, HOST_ABI_CRYPTO_INIT_SOURCE,
  HOST_ABI_UTXO_SOURCE, HOST_ABI_COMPOSE_SOURCE, slotKey, byteKey, utxoKey, spendKey, callerTag,
  XCL_WORD_BYTES,
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
      // composeHost: the contract interacts with OTHER contracts (env.xmbl_read / env.xmbl_send).
      // When set, ContractHost attaches the composition ABI, stages this contract's declared
      // foreign reads, and — for xmbl_send — enqueues a message resolved through this contract's
      // peer table. Peers/reads reference other contract ids, so they are wired AFTER deployment
      // via link() (a contract id is content-addressed from its bytes and cannot embed a peer's id).
      composeHost: !!deployOpts.composeHost,
      peers: [],   // [{id, fn}] — the targets xmbl_send(peer_idx, …) may reach, set by link()
      reads: [],   // [[peerIdx, slot]] — the declared synchronous foreign-read footprint, set by link()
    });
    return { id, coordinates };
  }

  /**
   * Wire a composeHost contract's peer table and declared read footprint. Called AFTER the peer
   * contracts are deployed (their ids are content-addressed, so a contract cannot embed a peer's
   * id at deploy time). `peers[i]` is the {id, fn} that `xmbl_send(i, …)` targets; `reads` is the
   * list of `[peerIdx, slot]` pairs the contract may read synchronously via `xmbl_read` — any read
   * outside it traps (fail-closed).
   * @param {string} id
   * @param {{peers?:Array<{id:string, fn:string}>, reads?:Array<[number,number]>}} wiring
   */
  link(id, { peers, reads } = {}) {
    const c = this.contracts.get(id);
    if (!c) throw new Error(`ContractHost.link: unknown contract ${id}`);
    if (peers) c.peers = peers.map((p) => ({ id: String(p.id), fn: String(p.fn) }));
    if (reads) c.reads = reads.map(([pi, s]) => [pi | 0, s | 0]);
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
    const entry = this.contracts.get(id);
    if (!entry) throw new Error(`ContractHost.call: unknown contract ${id}`);

    // ENFORCEMENT — the true-impute gate, load-bearing and fail-closed. A gated contract runs
    // ONLY when the delegation chain verifies for THIS contract (id as audience) and the action
    // (fnName) is in the token's scope. No authorizer configured but the contract is gated → the
    // call is refused, never silently allowed. This is where identity's verifyChain stops an
    // unauthorized state transition from ever touching the WASM or the state tree.
    // Gating authorizes the EXTERNAL entry call; internal messages the cascade emits inherit that
    // authorization (like an EVM internal call, which is not re-authorized against msg.sender).
    if (entry.gated) {
      if (!this.authorizer) throw new Error(`ContractHost.call: contract ${id} is gated but no authorizer is configured (fail-closed)`);
      const pres = opts.auth ? { ...opts.auth, action: fnName, args } : null;
      const decision = pres ? await this.authorizer.verify(pres) : { ok: false, reason: 'no-authorization-presented' };
      if (!decision.ok) throw new Error(`ContractHost.call: unauthorized (${decision.reason}) for ${fnName} on ${id}`);
    }

    // ── TRANSACTION. The entry call and EVERY message it transitively emits run as ONE atomic
    // transaction. Nothing touches committed state (this.state) until the whole cascade completes
    // AND conservation passes; any frame that throws unwinds the lot. This is what makes the
    // cascade safe: there is no partial commit for a re-entrant caller to observe or exploit.
    const tx = {
      overlay: new Map(),     // stateKey -> staged value: reads see committed state OVERLAID with
                              // writes already made in this transaction (read-your-writes across frames)
      writes: [],             // {id, kind:'slot'|'bytes', …} state writes, in order, applied once at the end
      spentIds: [],           // UNION of UTXO spends across all frames (conservation is over the union)
      outputs: [],            // UNION of UTXO creates {from, to, amount}
      spendMarkers: [],       // {id, uid, fnName} nullifiers to write at apply
      stagedUtxos: new Map(), // uid -> amount string, accumulated as frames stage their inputs
      queue: [],              // pending messages {from, to, fn, arg} — drained FIFO, never nested
      frames: 0,
    };
    const maxFrames = opts.maxFrames || 64;

    // The entry frame. Its result and raw write-set are what call() returns (back-compat: a
    // single-contract call with no messages behaves exactly as before).
    const first = await this._runFrame(tx, id, fnName, args, opts, (opts.caller | 0));

    // Drain the message queue FIFO. Each frame runs to COMPLETION before the next begins — there
    // is no nested call stack, so classic reentrancy (yielding to another contract mid-execution)
    // cannot occur by construction. A cascade that will not terminate hits the frame cap and
    // REVERTS wholly rather than draining resources or committing a partial transaction.
    while (tx.queue.length) {
      if (tx.frames >= maxFrames) {
        throw new Error(`ContractHost.call: message cascade exceeded ${maxFrames} frames — reverted`);
      }
      const msg = tx.queue.shift();
      await this._runFrame(tx, msg.to, msg.fn, [msg.arg], {}, callerTag(msg.from));
    }

    // ── UTXO CONSERVATION over the UNION of every frame — the security property, enforced
    // FAIL-CLOSED before ANY write lands. Value cannot be minted: across the whole transaction the
    // sum spent must equal the sum created plus the fee. Checked BEFORE applying, so a violating
    // cascade reverts WHOLLY — no spend marker, no output, no slot/byte write, the root unmoved.
    const created = [];
    if (tx.spentIds.length || tx.outputs.length) {
      let sumIn = 0n;
      for (const uid of tx.spentIds) {
        if (!tx.stagedUtxos.has(uid)) {
          throw new Error(`ContractHost.call: spent utxo ${uid} was not a staged input`);
        }
        if (this.state.get(spendKey(uid)) !== undefined) {
          throw new Error(`ContractHost.call: input utxo ${uid} is already spent (double-spend refused)`);
        }
        sumIn += BigInt(tx.stagedUtxos.get(uid));
      }
      let sumOut = 0n;
      for (const o of tx.outputs) sumOut += o.amount;
      const fee = BigInt(opts.fee || 0);
      if (sumIn !== sumOut + fee) {
        throw new Error(`ContractHost.call: value not conserved (in=${sumIn} out=${sumOut} fee=${fee}) — mint refused`);
      }
    }

    // ── ATOMIC APPLY (once, on success). Spend-markers first, then created outputs, then state
    // writes. A created output's id is content-addressed over (creator, recipient, amount, the
    // WHOLE transaction's sorted spend set, and its index in the transaction's creation order) —
    // deterministic and collision-free even when several frames create outputs.
    for (const m of tx.spendMarkers) {
      await this.state.insert(spendKey(m.uid), { by: m.id, spentBy: m.fnName });
    }
    const spendsSorted = [...tx.spentIds].sort();
    for (let idx = 0; idx < tx.outputs.length; idx++) {
      const o = tx.outputs[idx];
      const newId = createHash('sha256')
        .update(JSON.stringify({ from: o.from, to: o.to, amount: o.amount.toString(), spends: spendsSorted, i: idx }))
        .digest('hex').slice(0, 16);
      await this.state.insert(utxoKey(newId), { from: o.from, to: o.to, amount: o.amount.toString() });
      created.push({ id: newId, to: o.to, amount: o.amount.toString() });
    }
    for (const w of tx.writes) {
      const wc = this.contracts.get(w.id);
      if (w.kind === 'bytes') { wc.byteKeys.add(w.hk); await this.state.insert(byteKey(w.id, w.hk), w.hv); }
      else { wc.slots.add(w.slot); await this.state.insert(slotKey(w.id, w.slot), w.val); }
    }

    const out = { result: first.result, writes: first.writes, stateRoot: this.state.getRoot(), coordinates: entry.coordinates, frames: tx.frames };
    if (entry.utxoHost || tx.spentIds.length || tx.outputs.length) out.utxo = { spent: tx.spentIds, created };
    return out;
  }

  /**
   * Run ONE contract frame inside a transaction `tx`. Stages the contract's read-set from the
   * transaction view (committed state OVERLAID with this transaction's writes so far), runs the
   * WASM under the composed host ABI, and folds the frame's writes back into `tx` — state writes
   * update the overlay immediately (so a later frame reads them), UTXO ops and messages accumulate
   * for the transaction-level conservation check and queue drain. It NEVER touches committed state.
   * @returns {Promise<{result:(number|bigint), writes:Array}>} the frame's raw result + write-set
   */
  async _runFrame(tx, id, fnName, args, opts, callerI32) {
    const c = this.contracts.get(id);
    if (!c) throw new Error(`ContractHost.call: unknown message target ${id}`);
    tx.frames += 1;
    // Read through the transaction view: the overlay (this transaction's staged writes) shadows
    // committed state. This is the read-your-writes that makes a message cascade see a consistent,
    // already-updated world — the re-entrant frame reads the balance the earlier frame zeroed.
    const txGet = (k) => (tx.overlay.has(k) ? tx.overlay.get(k) : this.state.get(k));

    // Slot read-set.
    const slots = {};
    for (const slot of c.slots) {
      const v = txGet(slotKey(id, slot));
      slots[slot] = (v === undefined || v === null) ? 0 : (v | 0);
    }
    // Byte-keyed read-set (byteState contracts).
    const kv = {};
    for (const hk of c.byteKeys) {
      const v = txGet(byteKey(id, hk));
      if (v !== undefined && v !== null) kv[hk] = v;
    }
    // UTXO input read-set (utxoHost contracts). Inputs are presented on the ENTRY call only;
    // FAIL-CLOSED at staging against the transaction view (an input already spent — in committed
    // state OR earlier in this transaction — is refused before any WASM runs). inputIds is SORTED
    // so xmbl_input_id(i) is a pure function of the presented set, identical on every node.
    let utxos = null; let inputIds = null;
    if (c.utxoHost) {
      utxos = {}; inputIds = [...new Set((opts.inputs || []).map(String))].sort();
      for (const uid of inputIds) {
        if (txGet(spendKey(uid)) !== undefined) {
          throw new Error(`ContractHost.call: input utxo ${uid} is already spent (double-spend refused)`);
        }
        const rec = txGet(utxoKey(uid));
        if (rec === undefined || rec === null) {
          throw new Error(`ContractHost.call: input utxo ${uid} does not exist`);
        }
        const amt = (rec && typeof rec === 'object') ? rec.amount : rec;
        if (amt === undefined || amt === null) throw new Error(`ContractHost.call: input utxo ${uid} has no amount`);
        utxos[uid] = String(amt);
        tx.stagedUtxos.set(uid, String(amt));
      }
    }
    // Composition read-set (composeHost contracts): the peer table plus the DECLARED foreign reads,
    // each read from the transaction view so xmbl_read returns a value consistent with what earlier
    // frames wrote. A read outside this declared footprint traps in the ABI (fail-closed).
    let peers = null; let foreign = null;
    if (c.composeHost) {
      peers = c.peers;
      foreign = {};
      for (const [pIdx, slot] of c.reads) {
        const peer = c.peers[pIdx];
        if (!peer) continue;
        const v = txGet(slotKey(peer.id, slot));
        foreign[`${pIdx}|${slot}`] = (v === undefined || v === null) ? 0 : (v | 0);
      }
    }

    // The byte-pointer ABI and the v0 slot ABI collide on xmbl_verkle_get/set (different
    // signatures), so a frame uses exactly ONE state ABI. The UTXO value ABI and the composition
    // ABI use disjoint names, so each composes onto whichever state ABI the contract uses — every
    // sub-factory is eval'd over the same ctx and their bindings merged.
    const stateSource = c.byteState ? HOST_ABI_SOURCE_BYTES : HOST_ABI_SOURCE;
    const parts = [stateSource];
    if (c.utxoHost) parts.push(HOST_ABI_UTXO_SOURCE);
    if (c.composeHost) parts.push(HOST_ABI_COMPOSE_SOURCE);
    const source = parts.length === 1
      ? parts[0]
      : `(ctx) => Object.assign({}, ${parts.map((p) => `(${p})(ctx)`).join(', ')})`;

    const host = {
      source,
      data: {
        slots, caller: (callerI32 | 0), kv,
        crypto: c.cryptoHost ? (opts.crypto || null) : null,
        utxos, inputIds, peers, foreign,
      },
      marshal: c.wordAbi ? XCL_WORD_MARSHAL_SOURCE : null,
      init: c.cryptoHost ? HOST_ABI_CRYPTO_INIT_SOURCE : null,
    };
    const { result, writes } = await this.runtime.execute(c.wasm, fnName, args, { host });

    // Fold this frame's writes into the transaction. State writes go to the overlay immediately
    // (read-your-writes) and are recorded for the atomic apply; UTXO ops and messages accumulate.
    for (const w of writes) {
      if (w[0] === 'utxo_spend') {
        tx.spentIds.push(w[1]);
        tx.spendMarkers.push({ id, uid: w[1], fnName });
        tx.overlay.set(spendKey(w[1]), { by: id, spentBy: fnName });
      } else if (w[0] === 'utxo_create') {
        tx.outputs.push({ from: id, to: w[1], amount: BigInt(w[2]) });
      } else if (w[0] === 'send') {
        // Resolve the peer index against THIS contract's peer table on the trusted side and enqueue.
        // The target is NOT executed here — it runs as its own frame when the queue is drained.
        const peer = (c.peers || [])[w[1]];
        if (!peer) throw new Error(`ContractHost.call: contract ${id} sent to undefined peer index ${w[1]}`);
        tx.queue.push({ from: id, to: peer.id, fn: peer.fn, arg: w[2] | 0 });
      } else if (typeof w[0] === 'string' && w[0] === 'bytes') {
        const [, hk, hv] = w;
        tx.writes.push({ id, kind: 'bytes', hk, hv });
        tx.overlay.set(byteKey(id, hk), hv);
      } else {
        const [slot, val] = w;
        tx.writes.push({ id, kind: 'slot', slot: slot | 0, val: val | 0 });
        tx.overlay.set(slotKey(id, slot | 0), val | 0);
      }
    }
    return { result, writes };
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
