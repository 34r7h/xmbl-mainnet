import { EventEmitter } from 'events';
import { createHash } from 'crypto';
import { Level } from 'level';

export class Mempool extends EventEmitter {
  constructor(options = {}) {
    super();
    const dbPath = options.dbPath || './data/xpc/mempool';
    this.db = new Level(dbPath);
    this._dbOpen = false;
    
    // raw_tx_mempool: { leaderId: { rawTxId: { txData, validationTimestamps, validationTasks, txTimestamp } } }
    this.rawTx = new Map();
    // validation_tasks_mempool: { leaderId: [ {task, complete} ] }
    this.validationTasks = new Map();
    // locked_utxo_mempool: Set of locked UTXO IDs
    this.lockedUtxo = new Set();
    // processing_tx_mempool: { txId: { timestamp, txData, sig, leader } }
    this.processingTx = new Map();
    // tx_mempool: { txId: txData }
    this.tx = new Map();
    // A MEMPOOL IS A WAITING ROOM, AND THIS ONE HAD NO EXIT. `this.tx` is the FINAL tier: transactions
    // that reached consensus and were handed to the ledger (workflow emits tx:finalized; xclt or the lead
    // batchSealer takes it). The copy here is spent the moment that fires — nothing in the node reads it
    // back, the only other references anywhere are `.size` for the status line and the restore that
    // reloads it. Yet nothing ever deleted from it outside restore, so every transaction the node had ever
    // finalized stayed in memory AND on disk forever: measured live at 15,249 and climbing, reported as
    // `final` and read by anyone looking as a backlog. The prune further down bounds rawTx and never
    // touched this map.
    //
    // 60 seconds, then gone. Times live in a parallel map so the persisted row shape is unchanged
    // (_saveTx writes txData verbatim).
    this._txAt = new Map();
    this._txTtlMs = Math.max(1000, Number(process.env.XPC_TX_TTL_MS) || 60000);
    this._txSweep = setInterval(() => { this.sweepFinalizedTx().catch(() => {}); }, Math.min(15000, this._txTtlMs));
    if (typeof this._txSweep.unref === "function") this._txSweep.unref();
    
    // Exposed so callers can await the stage-1..5 rehydration before using the pool. Without this the
    // task manager would hydrate from an empty map on every boot and stage 2 would be lost again.
    this.ready = this._initDb().catch(() => {});
  }
  
  async _initDb() {
    try {
      await this.db.open();
      this._dbOpen = true;
      await this._loadState();
    } catch (error) {
      this._dbOpen = false;
    }
  }
  
  async _loadState() {
    if (!this._dbOpen) return;
    // THE RESTORE PATH IS A SECOND WAY IN, AND IT WAS UNBOUNDED. addRawTransaction enforces the pool cap,
    // but _loadState writes straight into the leader Maps and never calls it — so a capped node still
    // reloaded the ENTIRE persisted backlog on every boot, and the cap only began applying to whatever
    // arrived afterwards. Measured live: a node restarted with the cap at 1000 climbed back through 12,869
    // -> 16,350 purely from this loop, on its way to the full 20,777 still sitting in LevelDB.
    //
    // That is the same defect the reaper's comment warns about from the other direction ("map AND LevelDB,
    // else _loadState reloads it") — persistence outliving the bound. A bound enforced on one of two entry
    // paths is not a bound. Pruned below, once, after the iteration completes.
    const _restored = [];

    try {
      // Load raw transactions
      for await (const [key, value] of this.db.iterator({ gt: 'rawTx:', lt: 'rawTx:\xFF' })) {
        const data = JSON.parse(value.toString());
        const [leaderId, rawTxId] = key.toString().substring(6).split(':');
        if (!this.rawTx.has(leaderId)) {
          this.rawTx.set(leaderId, new Map());
        }
        this.rawTx.get(leaderId).set(rawTxId, data);
        _restored.push([leaderId, rawTxId, (data && data.txTimestamp) || 0]);
      }
      
      // Load processing transactions
      for await (const [key, value] of this.db.iterator({ gt: 'processingTx:', lt: 'processingTx:\xFF' })) {
        const txId = key.toString().substring(14);
        this.processingTx.set(txId, JSON.parse(value.toString()));
      }
      
      // Load finalized transactions
      for await (const [key, value] of this.db.iterator({ gt: 'tx:', lt: 'tx:\xFF' })) {
        const txId = key.toString().substring(3);
        this.tx.set(txId, JSON.parse(value.toString()));
        this._txAt.set(txId, Date.now());   // a restored row ages from THIS boot — see sweepFinalizedTx
      }
      
      // Load validation tasks (stage 2 of 5). This stage was the ONE mempool tier with no persistence:
      // rawTx/processingTx/tx/lockedUtxo all round-tripped through LevelDB, validationTasks lived only in
      // ValidationTaskManager's in-memory Map. A restart therefore restored the raw pool with NO tasks
      // assigned to it, and nothing regenerates them — measured 2026-08-02 on the live node: raw 856,
      // validation_tasks 0, validations_completed 0, every entry predating the process start. Those txs
      // could never progress. Persisting stage 2 is what makes the 5-stage workflow restart-safe.
      // Keys are validationTasks:<leaderId>:<rawTxId> — ONE key per task group, never one blob per leader.
      // The blob form re-serialized a leader's ENTIRE task array on every assign, so writing n tasks cost
      // O(n^2) bytes. At 13,740 pooled txs that is ~94M entry-writes; it drove a 1GB box to load 30 and OOM.
      for await (const [key, value] of this.db.iterator({ gt: 'validationTasks:', lt: 'validationTasks:\xFF' })) {
        const rest = key.toString().substring(16);
        const i = rest.indexOf(':');
        if (i < 0) continue;                       // legacy blob row — ignored, superseded below
        const leaderId = rest.substring(0, i);
        if (!this.validationTasks.has(leaderId)) this.validationTasks.set(leaderId, []);
        try { this.validationTasks.get(leaderId).push(...JSON.parse(value.toString())); } catch { /* skip */ }
      }
      // Drop any legacy single-blob rows so they cannot resurrect the O(n^2) shape.
      for await (const [key] of this.db.iterator({ gt: 'validationTasks:', lt: 'validationTasks:\xFF' })) {
        const rest = key.toString().substring(16);
        if (!rest.includes(':')) { try { await this.db.del(key); } catch { /* ignore */ } }
      }

      // Load locked UTXOs
      const lockedUtxos = await this.db.get('lockedUtxo').catch(() => null);
      if (lockedUtxos) {
        const utxos = JSON.parse(lockedUtxos.toString());
        this.lockedUtxo = new Set(utxos);
      }

    } catch (error) {
      // Ignore load errors
    } finally {
      // PRUNE THE RESTORE TO THE CAP — IN `finally`, NOT AT THE END OF THE `try`.
      //
      // It was at the end of the try, and the try's catch is a bare "ignore load errors". So ANY throw in
      // the loaders above it — a malformed row, one bad iterator — skipped the prune silently and the node
      // came back up with the whole backlog restored and no bound applied. Observed exactly that on the live
      // node: the code was deployed and byte-identical to source, yet the pool climbed 15,400 -> 18,900
      // instead of converging to 1000. A cleanup that only runs when nothing went wrong is not a cleanup;
      // the case it exists for is precisely the case where something did.
      //
      // Keeps the NEWEST: on this path the old entries are the proven-stuck ones, since a tx that survived a
      // restart without advancing is by definition one nothing is driving. Deletes from the Map AND LevelDB,
      // or the next boot restores it again and the bound never converges. Runs once, over a set already in
      // memory — no extra scan.
      try {
        const MAX = Math.max(100, Number(process.env.XPC_MEMPOOL_MAX) || (process.env.XMBL_LITE === '1' ? 1000 : 5000));
        if (_restored.length > MAX) {
          _restored.sort((a, b) => b[2] - a[2]);                 // newest first
          const drop = _restored.slice(MAX);
          for (const [leaderId, rawTxId] of drop) {
            this.rawTx.get(leaderId)?.delete(rawTxId);
            try { await this.db.del(`rawTx:${leaderId}:${rawTxId}`); } catch { /* ignore */ }
          }
          this._rawCountAt = 0;
          console.warn(`[XPC-BOUND] restore: ${_restored.length} persisted raw tx exceeds cap ${MAX} — dropped ${drop.length} oldest from map AND disk (pool now ${this.rawCount()})`);
        }
      } catch { /* the bound must never be the thing that prevents a boot */ }
    }
  }
  
  async _saveRawTx(leaderId, rawTxId, data) {
    if (!this._dbOpen) return;
    try {
      await this.db.put(`rawTx:${leaderId}:${rawTxId}`, JSON.stringify(data));
    } catch (error) {
      // Ignore save errors
    }
  }
  
  async _saveProcessingTx(txId, data) {
    if (!this._dbOpen) return;
    try {
      await this.db.put(`processingTx:${txId}`, JSON.stringify(data));
    } catch (error) {
      // Ignore save errors
    }
  }
  
  /**
   * Drop every finalized tx past the TTL, from the Map AND from LevelDB. Deleting only the Map would leave
   * the row on disk for the next boot to restore — the exact defect the raw-tx prune warns about ("map AND
   * LevelDB, or the next boot restores it again and the bound never converges"). Returns what it dropped so
   * a caller can report a number instead of claiming a state.
   */
  async sweepFinalizedTx(now = Date.now()) {
    let dropped = 0, oldest = 0;
    for (const [txId, at] of [...this._txAt]) {
      const age = now - at;
      if (age <= this._txTtlMs) continue;
      if (age > oldest) oldest = age;
      this.tx.delete(txId);
      this._txAt.delete(txId);
      if (this._dbOpen) { try { await this.db.del(`tx:${txId}`); } catch { /* ignore */ } }
      dropped++;
    }
    // An entry with no recorded time cannot be immortal: age it from the moment it was first seen.
    for (const txId of this.tx.keys()) if (!this._txAt.has(txId)) this._txAt.set(txId, now);
    if (dropped) console.log(`[XPC-BOUND] swept ${dropped} finalized tx past the ${this._txTtlMs}ms TTL (oldest ${Math.round(oldest / 1000)}s) — pool now ${this.tx.size}`);
    return { dropped, remaining: this.tx.size, oldest_ms: oldest };
  }

  /** Stop the sweeper — clean shutdown and tests. */
  stopTxSweeper() { if (this._txSweep) { clearInterval(this._txSweep); this._txSweep = null; } }

  async _saveTx(txId, data) {
    if (!this._dbOpen) return;
    try {
      await this.db.put(`tx:${txId}`, JSON.stringify(data));
    } catch (error) {
      // Ignore save errors
    }
  }
  
  // O(1) per task group. `rawTxId` scopes the key so a write never touches other tasks.
  async _saveValidationTasks(leaderId, rawTxId, tasks) {
    if (!this._dbOpen) return;
    try {
      if (!tasks || !tasks.length) await this.db.del(`validationTasks:${leaderId}:${rawTxId}`);
      else await this.db.put(`validationTasks:${leaderId}:${rawTxId}`, JSON.stringify(tasks));
    } catch (error) {
      // Ignore save errors
    }
  }

  async _deleteValidationTasks(leaderId) {
    if (!this._dbOpen) return;
    try {
      await this.db.del(`validationTasks:${leaderId}`);
    } catch (error) {
      // Ignore delete errors
    }
  }

  // ---- validation_tasks_mempool (stage 2/5) public API, mirroring the other four stages ----
  // Persist ONLY the tasks belonging to one rawTxId. The in-memory list stays whole; the write is bounded.
  setValidationTasksFor(leaderId, rawTxId, tasksForTx, wholeList) {
    this.validationTasks.set(leaderId, wholeList);
    this._saveValidationTasks(leaderId, rawTxId, tasksForTx).catch(() => {});
  }

  getValidationTasks(leaderId) {
    return this.validationTasks.get(leaderId) || [];
  }

  getAllValidationTasks() {
    return this.validationTasks;
  }

  clearValidationTasks(leaderId) {
    this.validationTasks.delete(leaderId);
    this._deleteValidationTasks(leaderId).catch(() => {});
  }

  async clearValidationTasksFor(leaderId, rawTxId) {
    try { if (this._dbOpen) await this.db.del(`validationTasks:${leaderId}:${rawTxId}`); } catch { /* ignore */ }
  }

  async _saveLockedUtxos() {
    if (!this._dbOpen) return;
    try {
      await this.db.put('lockedUtxo', JSON.stringify(Array.from(this.lockedUtxo)));
    } catch (error) {
      // Ignore save errors
    }
  }

  async _deleteRawTx(leaderId, rawTxId) {
    if (!this._dbOpen) return;
    try {
      await this.db.del(`rawTx:${leaderId}:${rawTxId}`);
    } catch (error) {
      // Ignore delete errors
    }
  }

  // Pool size, cached with a short TTL rather than maintained as a running total.
  //
  // A maintained counter would be O(1) but WRONG: several paths outside this class delete straight from the
  // leader Maps (workflow's _evictRawTx, drainInvalidMempool, reapAbandonedRawTxs, moveToProcessing), and
  // _deleteRawTx only removes the LevelDB row. A counter incremented here would drift downward-blind and
  // either evict when it should not or stop evicting entirely — a bound that silently stops bounding is
  // worse than none.
  //
  // A recount is O(leaders), NOT O(txs) — each per-leader Map carries its own size — so it is cheap; the
  // only thing worth avoiding is doing it per admission at 15M tx/sec. Cached for XPC_COUNT_TTL_MS, it is
  // amortised to nothing and any drift self-heals on the next expiry.
  rawCount(now = Date.now()) {
    const TTL = Math.max(0, Number(process.env.XPC_COUNT_TTL_MS) || 250);
    if (this._rawCount === undefined || now - (this._rawCountAt || 0) >= TTL) {
      this._rawCount = this._recount();
      this._rawCountAt = now;
    }
    return this._rawCount;
  }
  _recount() { let n = 0; for (const m of this.rawTx.values()) n += m.size; return n; }

  // THE BOUND — AND IT MUST NOT BECOME A THROTTLE.
  //
  // Why a bound at all: addRawTransaction appended forever and nothing removed a transaction that could not
  // advance, so the pool was a one-way accumulator. Measured on production: 20,777 raw txs held with 0
  // sealed, which cost ~64% of a CPU in V8 ConcurrentMarking — a live set that only grows makes every
  // collection free nothing, so the next begins immediately.
  //
  // Why it must be AGE-FIRST, not oldest-first: at 15M tx/sec the pool is a WORKING SET, not a landfill.
  // Most of it is legitimately in flight, and a cap that evicts "the oldest N" whenever the pool is full
  // would evict transactions that are actively advancing — silently dropping valid chain writes at exactly
  // the moment the system is busiest, and getting worse the faster it runs. That is a far worse failure than
  // the one being fixed.
  //
  // So: evict ONLY what is already abandoned — older than the retry abandon age, past which validation-retry
  // has given up and no node can drive it toward quorum, so evicting it by the same age rule everywhere is
  // symmetric and can never cost this node a cube the others seal. A fresh backlog of in-flight work is left
  // alone and simply exceeds the cap; that is the correct outcome, because at that point the pool is not
  // leaking, it is loaded, and the answer to load is capacity, not silent data loss.
  _evictable(overBy, now) {
    const ABANDON_MS = Math.max(1000, Number(process.env.XPC_RETRY_MAX_AGE_MS) || 300000);
    const out = [];
    for (const [leaderId, m] of this.rawTx) {
      for (const [id, e] of m) {
        const ts = e && e.txTimestamp;
        if (typeof ts !== 'number') continue;               // unknown age is not proof of abandonment
        if (now - ts <= ABANDON_MS) continue;               // still inside the window: in flight, hands off
        out.push([leaderId, id]);
        if (out.length >= overBy) return out;               // early exit — never scans the whole pool
      }
    }
    return out;
  }

  // TOMBSTONES — what makes a bound survive contact with the mesh.
  //
  // Evicting locally achieves nothing while peers re-gossip the same transactions: measured on the live
  // node, the sweep evicted thousands per pass and the pool barely moved, because inflow replaced them
  // immediately. A node cannot bound itself if anything it drops comes straight back, and it must not depend
  // on every other node in the mesh being fixed first — that is precisely the state we are in, with three
  // peers still running older code.
  //
  // So an eviction is remembered, and re-arrival of the same rawTxId is refused. rawTxId is a deterministic
  // hash of txData, so this identifies the exact transaction, never a class of them. The set is bounded and
  // FIFO-trimmed: a tombstone is a hint about a transaction already judged abandoned, not a permanent ban —
  // if it is ever legitimately resubmitted after the window has rolled, it is admitted normally.
  _tombstone(rawTxId) {
    if (!this._tombs) { this._tombs = new Set(); this._tombOrder = []; }
    const MAXT = Math.max(1000, Number(process.env.XPC_TOMBSTONE_MAX) || 50000);
    if (this._tombs.has(rawTxId)) return;
    this._tombs.add(rawTxId);
    this._tombOrder.push(rawTxId);
    while (this._tombOrder.length > MAXT) this._tombs.delete(this._tombOrder.shift());
  }
  isTombstoned(rawTxId) { return !!(this._tombs && this._tombs.has(rawTxId)); }

  async addRawTransaction(leaderId, txData) {
    const rawTxId = this._hashTransaction(txData);

    // Refuse what this node has already evicted, unless it is still pooled (a live entry always wins).
    if (this.isTombstoned(rawTxId) && !(this.rawTx.get(leaderId)?.has(rawTxId))) {
      this._tombHits = (this._tombHits || 0) + 1;
      if (this._tombHits % 500 === 1) console.warn(`[XPC-BOUND] refused ${this._tombHits} re-gossips of evicted txs (tombstones ${this._tombs.size})`);
      return rawTxId;
    }

    if (!this.rawTx.has(leaderId)) {
      this.rawTx.set(leaderId, new Map());
    }

    // ⛔ NO SINGLE PEER MAY OWN THE POOL. The global cap alone does not prevent this: it only asks how BIG
    // the pool is, never who filled it, so one peer replaying its backlog takes every slot and every other
    // peer's real work is what gets evicted to make room. That is not a hypothetical — 2026-08-21, a dev
    // node holding 19,947 raw tx for 14 real anchors was peered into the production mesh and prod went
    // 998 -> 7,891 tx in twenty minutes, pinned at its cap, evicting one-in-one-out, while handoff's own
    // submitted count did not move at all. The flood was admitted one transaction at a time, each one
    // individually legal, and the only bound that could have seen it is this one: a share per SOURCE.
    //
    // Refusal is not a tombstone. The transaction is not condemned — this peer is simply over its share
    // right now, and a later arrival with room is admitted normally. That keeps the guard safe against a
    // legitimately busy leader while making a flood structurally impossible: with N peers connected, no
    // one of them can hold more than PEER_MAX, so the pool cannot be monopolised however hard it tries.
    const POOL_MAX = Math.max(100, Number(process.env.XPC_MEMPOOL_MAX) || (process.env.XMBL_LITE === '1' ? 1000 : 5000));
    const PEER_MAX = Math.max(50, Number(process.env.XPC_PEER_MAX) || Math.floor(POOL_MAX / 4));
    const mine = this.rawTx.get(leaderId);
    if (mine.size >= PEER_MAX && !mine.has(rawTxId)) {
      this._peerRefusals = this._peerRefusals || new Map();
      const n = (this._peerRefusals.get(leaderId) || 0) + 1;
      this._peerRefusals.set(leaderId, n);
      if (n === 1 || n % 500 === 0) {
        console.warn(`[XPC-PEER-BOUND] peer ${leaderId} is at its share (${mine.size}/${PEER_MAX} of a ${POOL_MAX} pool) — refused ${n} transactions from it. Other peers keep their slots; this one is not allowed to take them.`);
      }
      return rawTxId;
    }

    const leaderMempool0 = this.rawTx.get(leaderId);
    const prior = leaderMempool0 && leaderMempool0.get(rawTxId);
    const txEntry = {
      txData,
      validationTimestamps: [],
      validationTasks: [],
      // FIRST-SEEN, NOT LAST-SEEN. This was Date.now() unconditionally, so every re-gossip of the same
      // transaction reset its age to zero. Peers re-broadcast the backlog continuously, so a stuck pool
      // refreshed itself faster than any age-based rule could retire it: measured on the live node, an
      // age-bounded sweep with a 5-minute abandon window retired ~50 of 15,449 per pass while re-ingest
      // renewed the rest — the pool was immortal by construction, and both the reaper and the cap were
      // quietly defeated by it, which is why neither ever appeared to work.
      //
      // rawTxId is a deterministic hash of txData, so a re-arrival is the SAME transaction and its true age
      // is when this node first saw it. Keeping that makes "abandoned" mean something.
      txTimestamp: (prior && typeof prior.txTimestamp === 'number') ? prior.txTimestamp : Date.now()
    };

    const leaderMempool = this.rawTx.get(leaderId);
    leaderMempool.set(rawTxId, txEntry);
    await this._saveRawTx(leaderId, rawTxId, txEntry);

    // AMORTISED, NOT PER-TRANSACTION. Enforcement lives on the one path that grows the pool so no future
    // caller can bypass it — but it must not add per-admission work, or the bound becomes the bottleneck at
    // the throughput this chain targets. So the sweep runs only when the pool is over the cap AND at most
    // once per XPC_BOUND_SWEEP_MS; between sweeps admission stays a Map set plus a counter increment.
    // Eviction removes from the Map AND from LevelDB: dropping only the Map lets _loadState faithfully
    // restore the whole backlog at the next boot, which is how a 12k backlog once survived restarts.
    const MAX = Math.max(100, Number(process.env.XPC_MEMPOOL_MAX) || (process.env.XMBL_LITE === '1' ? 1000 : 5000));
    const now = Date.now();
    const SWEEP_MS = Math.max(0, Number(process.env.XPC_BOUND_SWEEP_MS) || 1000);
    if (this.rawCount() > MAX && now - (this._lastBoundSweep || 0) >= SWEEP_MS) {
      this._lastBoundSweep = now;
      const over = this.rawCount() - MAX;
      const victims = this._evictable(over, now);
      for (const [lid, id] of victims) {
        if (id === rawTxId) continue;                        // never evict the tx we were just handed
        this.rawTx.get(lid)?.delete(id);
        await this._deleteRawTx(lid, id);
      }
      this._rawCountAt = 0;   // force a recount: the cached size predates the eviction we just did
      // Reported, never silent — and it reports the SHORTFALL too. If the pool is over the cap but nothing
      // is old enough to evict, the pool is LOADED, not leaking, and the honest answer is capacity rather
      // than dropping live work. Saying so is what stops a future reader "fixing" it by widening eviction.
      if (victims.length) console.warn(`[XPC-BOUND] over ${MAX} by ${over} — evicted ${victims.length} abandoned raw tx (pool now ${this.rawCount()})`);
      else console.warn(`[XPC-BOUND] over ${MAX} by ${over} — nothing past the abandon age; pool is in flight, not leaking (no eviction)`);
    }

    this.emit('raw_tx:added', { leaderId, rawTxId, txData });
    return rawTxId;
  }

  async lockUtxos(utxos) {
    utxos.forEach(utxo => this.lockedUtxo.add(utxo));
    await this._saveLockedUtxos();
    this.emit('utxo:locked', utxos);
  }

  async unlockUtxos(utxos) {
    utxos.forEach(utxo => this.lockedUtxo.delete(utxo));
    await this._saveLockedUtxos();
    this.emit('utxo:unlocked', utxos);
  }

  _hashTransaction(tx) {
    // Serialize BigInt values before stringifying
    const serialized = this._serializeBigInts(tx);
    const txStr = JSON.stringify(serialized);
    return createHash('sha256').update(txStr).digest('hex');
  }

  _serializeBigInts(obj) {
    if (obj === null || obj === undefined) return obj;
    if (typeof obj === 'bigint') return obj.toString();
    if (Array.isArray(obj)) return obj.map(item => this._serializeBigInts(item));
    if (typeof obj === 'object') {
      const result = {};
      for (const [key, value] of Object.entries(obj)) {
        result[key] = this._serializeBigInts(value);
      }
      return result;
    }
    return obj;
  }
}

