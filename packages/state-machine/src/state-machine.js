import { VerkleStateTree } from './verkle-tree.js';
import { StateDiff } from './state-diff.js';
import { StateShard } from './sharding.js';
import { StateAssembler } from './state-assembly.js';
import { Level } from 'level';
import { EventEmitter } from 'events';

// ⛔ StateMachine WAS a plain class, and _handleCubeComplete called `this.emit?.('state:committed', ...)`.
// `this.emit` was undefined, so the optional call swallowed itself and the event never existed: the one
// moment the chain commits a state root to a cube was unobservable to anything outside this file. Optional
// chaining on a method you own is not defensive, it is a silent no-op with a `?.` in front of it.
export class StateMachine extends EventEmitter {
  constructor(options = {}) {
    super();
    const dbPath = options.dbPath || './data/xvsm';
    this.db = new Level(dbPath);
    this._dbOpen = false;
    
    this.stateTree = new VerkleStateTree({ db: this.db });
    this.assembler = new StateAssembler();
    this.shards = [];
    this.totalShards = options.totalShards || 4;
    this.diffs = [];
    this.transactionLog = [];
    
    // Initialize shards
    for (let i = 0; i < this.totalShards; i++) {
      this.shards.push(new StateShard(i, this.totalShards));
    }
    
    // Integration: xclt for state commitments from ledger
    this.xclt = options.xclt || null;
    
    // Initialize database
    this._initDb().catch(() => {});
    
    // Listen to ledger events if available
    if (this.xclt) {
      this.xclt.on('block:added', async (block) => {
        await this._handleLedgerBlock(block);
      });
      
      // NAMED evt, NOT cube, because it is not one: the ledger emits
      // { cube, cubeId, validatorAverageTimestamp, level }. Calling the parameter `cube` here is what made
      // the envelope defect invisible for as long as it lasted — the wiring read as a promise the emitter
      // never made. _handleCubeComplete unwraps either shape; this name stops the next reader re-deriving it.
      this.xclt.on('cube:complete', (evt) => {
        this._handleCubeComplete(evt);
      });
    }
  }
  
  async _initDb() {
    try {
      await this.db.open();
      this._dbOpen = true;
      await this._loadDiffs();
      await this._loadTransactionLog();
    } catch (error) {
      this._dbOpen = false;
    }
  }
  
  async _loadDiffs() {
    if (!this._dbOpen) return;
    
    try {
      // ⛔ REPLAY, don't just collect. This loop used to restore `this.diffs` and stop there, leaving
      // `this.stateTree` EMPTY — so the Verkle root reset to 64 zeros on every restart even with every diff
      // sitting on disk. Same bug class as validation_tasks_mempool: persisted but never rehydrated.
      // Replay is safe to do in iterator order because the tree is a key->value map: the root is a function
      // of the final key set, not of application order (proven in verkle-integration.test.mjs, "same set in
      // any order yields the SAME root"). Later diffs for the same key legitimately overwrite earlier ones.
      const loaded = [];
      for await (const [key, value] of this.db.iterator({ gt: 'diff:', lt: 'diff:\xFF' })) {
        const diffData = JSON.parse(value.toString());
        const diff = new StateDiff(diffData.txId, diffData.changes);
        diff.timestamp = diffData.timestamp;
        this.diffs.push(diff);
        loaded.push(diff);
      }
      loaded.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0) || String(a.txId).localeCompare(String(b.txId)));
      let replayed = 0;
      for (const diff of loaded) {
        for (const [k, v] of Object.entries(diff.changes || {})) {
          if (v === null) { await this.stateTree.delete?.(k); continue; }
          await this.stateTree.insert(k, v);
          replayed++;
        }
      }
      if (replayed) console.log(`[XVSM] verkle tree rehydrated: ${replayed} change(s) from ${loaded.length} diff(s), root=${this.stateTree.getRoot().slice(0, 16)}…`);
    } catch (error) {
      // Ignore load errors
    }
  }
  
  async _loadTransactionLog() {
    if (!this._dbOpen) return;
    
    try {
      const logData = await this.db.get('transactionLog').catch(() => null);
      if (logData) {
        this.transactionLog = JSON.parse(logData.toString());
      }
    } catch (error) {
      // Ignore load errors
    }
  }
  
  async _saveDiff(diff) {
    if (!this._dbOpen) return;
    
    try {
      await this.db.put(`diff:${diff.txId}`, JSON.stringify({
        txId: diff.txId,
        changes: diff.changes,
        timestamp: diff.timestamp
      }));
    } catch (error) {
      // Ignore save errors
    }
  }
  
  async _saveTransactionLog() {
    if (!this._dbOpen) return;
    
    try {
      await this.db.put('transactionLog', JSON.stringify(this.transactionLog));
    } catch (error) {
      // Ignore save errors
    }
  }
  
  // Derive the sparse Verkle state diff for ANY finalized transaction type.
  //
  // ⛔ THE BUG THIS FIXES: this handler used to apply a block only when `block.tx.type === 'state_diff'`.
  // Nothing in the system emits that type — every real transaction is an `anchor`, a `tx` (type-6), a `utxo`,
  // an `identity`, a `token_creation` or a `contract`. So the Verkle tree received NOTHING: measured live
  // 2026-08-02, state_root was 64 zeros with applied_tx_count 0 and state_diffs 0 while the ledger held 396
  // blocks and 14 cubes. A fully implemented state tree that no transaction could ever reach.
  //
  // Every transaction type IS a state change, so each maps to its natural key space. Keys are namespaced by
  // type so two kinds can never collide, and values carry only consensus-derived fields — nothing node-local,
  // because the state root is a cross-node commitment.
  _stateChangesFor(block) {
    const tx = block?.tx;
    if (!tx || typeof tx !== 'object') return null;
    switch (tx.type) {
      case 'state_diff':
        // Explicit diffs keep their existing contract: args ARE the changes.
        return tx.args && typeof tx.args === 'object' ? { ...tx.args } : null;
      case 'anchor':
        // An anchor asserts "this event hash existed at this time". The assertion is the state.
        if (!tx.event || !tx.hash) return null;
        return { [`anchor:${tx.event}:${tx.hash}`]: { ts: tx.ts ?? null } };
      case 'tx': {
        // Type-6 value tx: the xid is content-addressed, so it is its own key.
        if (!tx.xid) return null;
        return { [`tx:${tx.xid}`]: {
          chain: tx.chain ?? null, from: tx.from ?? null, to: tx.to ?? null,
          asset: tx.asset ?? null, amount: tx.amount ?? null, unspent: tx.unspent ?? null } };
      }
      case 'utxo':
        if (!tx.from || !tx.to) return null;
        return { [`utxo:${block.id}`]: { from: tx.from, to: tx.to, amount: tx.amount ?? null } };
      case 'identity':
        if (!tx.publicKey) return null;
        return { [`identity:${tx.from ?? block.id}`]: { publicKey: tx.publicKey } };
      case 'token_creation':
        if (!tx.tokenId) return null;
        return { [`token:${tx.tokenId}`]: { creator: tx.creator ?? null } };
      case 'contract':
        if (!tx.contractHash) return null;
        return { [`contract:${tx.contractHash}`]: { abi: tx.abi ?? null } };
      default:
        return null;
    }
  }

  async _handleLedgerBlock(block) {
    const changes = this._stateChangesFor(block);
    if (!changes || !Object.keys(changes).length) return;
    try {
      const diff = new StateDiff(block.id, changes);
      this.diffs.push(diff);
      for (const [key, value] of Object.entries(changes)) {
        await this.stateTree.insert(key, value);
      }
      if (this._dbOpen !== false) {
        // StateDiff.serialize() ALREADY returns a JSON string — wrapping it in JSON.stringify again
        // double-encodes, so _loadDiffs parses back a string instead of an object and `changes` comes out
        // undefined, silently replaying nothing. Store the serialized form directly.
        try { await this.db.put(`diff:${block.id}`, diff.serialize()); }
        catch { /* in-memory fallback */ }
      }
    } catch (error) {
      console.warn('Failed to apply ledger block to state tree:', error.message);
    }
  }

  // BACKFILL — apply every block the LEDGER already holds on disk, without waiting for a seal round.
  //
  // WHY THIS EXISTS AND IS NOT MERELY A CONVENIENCE. The `block:added` doorbell was missing entirely, so on a
  // deployment that has been running for weeks the tree is empty while the ledger holds thousands of blocks
  // (measured 2026-08-17: 711 txs, 5,594 block rows, 202 cubes, applied_tx_count 0). Restoring the emit fixes
  // the FUTURE; it cannot recover the past, because a diff is DERIVED at apply time and none were ever
  // derived — _loadDiffs replays an empty set no matter how long it runs. Worse, the emit rides the sealed
  // path, and sealing needs a validation quorum: where a node cannot reach `required` leads, no seal round
  // agrees, the emit never fires, and apply stays at 0 with a correct patch installed. This walks the
  // persisted rows directly, so it depends on neither the doorbell nor the quorum.
  //
  // IDEMPOTENT BY CONSTRUCTION, safe to run repeatedly and concurrently with live applies: the Verkle root is
  // a function of the final key SET, not of application order (proven in verkle-integration.test.mjs, "same
  // set in any order yields the SAME root"), and re-inserting a key with the same value is a no-op on the
  // root. Blocks whose type maps to nothing are skipped, not failed.
  //
  // `ledgerDb` defaults to the ledger this state machine was constructed with. Returns counts rather than
  // logging them, so a caller (control socket, test, ops script) reports the real number instead of a claim.
  async backfillFromLedger(ledgerDb = null) {
    const db = ledgerDb || (this.xclt && this.xclt.db) || null;
    const out = { scanned: 0, applied: 0, skipped: 0, failed: 0, state_root: null, started: true };
    if (!db) { out.started = false; out.error = 'no ledger db available to backfill from'; return out; }
    for await (const [, value] of db.iterator({ gte: 'block:', lt: 'block;' })) {
      out.scanned++;
      let block;
      try { block = JSON.parse(value.toString()); }
      catch { out.failed++; continue; }
      // The persisted row is plain JSON, and _stateChangesFor only reads block.tx / block.id — no Block
      // instance is needed, and constructing one would risk re-deriving a hash that must not change.
      const changes = this._stateChangesFor(block);
      if (!changes || !Object.keys(changes).length) { out.skipped++; continue; }
      try {
        const diff = new StateDiff(block.id, changes);
        this.diffs.push(diff);
        for (const [key, val] of Object.entries(changes)) await this.stateTree.insert(key, val);
        if (this._dbOpen !== false) {
          try { await this.db.put(`diff:${block.id}`, diff.serialize()); } catch { /* in-memory fallback */ }
        }
        out.applied++;
      } catch { out.failed++; }
    }
    out.state_root = this.stateTree.getRoot();
    return out;
  }

  // AUTHORITATIVE REBUILD from the broker's canonical anchor set. The nodes sit on separate private networks
  // and cannot gossip blocks to each other, so their ledgers drift and their roots diverge. Every node CAN
  // reach the broker over HTTPS, so it fetches the ONE canonical set and rebuilds its verkle state from
  // exactly that — clearing first so no stale/extra key survives. The root is a pure function of the applied
  // set (apply-path.test.mjs), so every node that runs this lands on the identical root. Returns counts + the
  // resulting root. `anchors` is [{event,hash,ts}] — the shape GET /xmbl/anchors/canonical serves.
  async rebuildFromCanonical(anchors) {
    const list = Array.isArray(anchors) ? anchors : [];
    const out = { requested: list.length, applied: 0, skipped: 0, state_root: null, started: true };
    await this.stateTree.clear();
    this.diffs = [];
    for (const a of list) {
      if (!a || !a.event || !a.hash) { out.skipped++; continue; }
      try {
        await this.stateTree.insert(`anchor:${a.event}:${a.hash}`, { ts: a.ts ?? null });
        out.applied++;
      } catch { out.skipped++; }
    }
    out.state_root = this.stateTree.getRoot();
    return out;
  }

  // COMMIT the state root INTO the cube. Previously this only console.logged it, so a cube carried no state
  // commitment at all and the Verkle root was unverifiable from the chain structure. The root is a pure
  // function of the applied diffs, so two nodes that applied the same finalized set produce the same value —
  // making it a legitimate cross-node check, and a mismatch a real divergence signal.
  // ⛔ SECOND HALF OF THE SAME BUG. The ledger emits cube:complete with an ENVELOPE —
  // { cube, cubeId, validatorAverageTimestamp, level } — not the Cube itself. This handler took the argument
  // to BE the cube, so on the real wiring it set `stateRoot` on a throwaway envelope and read `.id` off it as
  // undefined. The Cube the ledger then re-persists (ledger.js, "COMMIT THE VERKLE STATE ROOT INTO THE
  // PERSISTED CUBE") checks `cube.stateRoot` — which was never set — so the re-put was skipped and no cube
  // ever carried a state commitment. The existing unit test passed throughout because it calls this method
  // DIRECTLY with a Cube, which is the one shape production never sends. Accept both, and commit to the real
  // cube whichever arrives.
  _handleCubeComplete(evt) {
    const stateRoot = this.stateTree.getRoot();
    const cube = (evt && typeof evt === 'object' && evt.cube && typeof evt.cube === 'object') ? evt.cube : evt;
    if (cube && typeof cube === 'object') {
      cube.stateRoot = stateRoot;
      this.emit('state:committed', { cubeId: cube.id ?? (evt && evt.cubeId) ?? null, stateRoot });
    }
    return stateRoot;
  }

  // executeTransaction(...) was REMOVED. It ran contract WASM through the deleted
  // WASMExecutor — whose only working path was a fake fallback that fabricated a state
  // transition (counter += input.increment) when the "WASM" failed to compile, which on a
  // chain is a silent correctness hole. Contract execution now lives where it belongs: the
  // hardened sandbox in @xmbl/storage-compute, driven by @xmbl/contracts' ContractHost,
  // which reads and writes THIS module's VerkleStateTree via the XCL host ABI. The state
  // machine no longer executes WASM.

  getState(key, timestamp = null) {
    if (timestamp) {
      return this.assembler.getStateAtTimestamp(this.diffs, timestamp);
    }
    
    // Try shard first
    const shardIndex = StateShard.getShardForKey(key, this.totalShards);
    const shard = this.shards[shardIndex];
    const shardState = shard.get(key);
    
    if (shardState) {
      return shardState;
    }
    
    // Assemble from diffs
    return this.assembler.assemble(this.diffs);
  }

  generateProof(key) {
    // Check if key exists in tree first
    const value = this.stateTree.get(key);
    if (value === undefined) {
      throw new Error(`Key ${key} not found in state tree`);
    }
    return this.stateTree.generateProof(key);
  }

  verifyProof(key, value, proof) {
    return VerkleStateTree.verifyProof(key, value, proof);
  }

  getStateRoot() {
    return this.stateTree.getRoot();
  }

  getStatistics() {
    return {
      // applied_tx_count — count applied state diffs (the ledger-block application path).
      // transactionLog holds only legacy persisted entries now that executeTransaction is
      // gone; it no longer grows here.
      totalTransactions: this.transactionLog.length + this.diffs.length,
      appliedDiffs: this.diffs.length,
      totalDiffs: this.diffs.length,
      stateRoot: this.stateTree.getRoot(),
      shards: this.shards.map((s, i) => ({
        index: i,
        keyCount: s.getAllKeys().length
      }))
    };
  }
}

