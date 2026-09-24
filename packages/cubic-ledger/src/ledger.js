import { EventEmitter } from 'events';
import { createHash } from 'crypto';
import { Block, consensusBody, contentKey, contentIdOf } from './block.js';
import { Face } from './face.js';
import { Cube } from './cube.js';
import { SuperCube } from './super-cube.js';
import { sortFacesByHash } from './placement.js';
import { sealBlocksIntoFaces } from './face-sealing.js';
import { verifyPlacement } from './deterministic-placement.js';
import { micromineBody } from './transaction-validator.js';   // the forged-bytes eviction key (see _forgedKey)
import { Level } from 'level';
import { anchorTimestampNanos, blockTimestampNanos } from './timestamps.js';
export { anchorTimestampNanos, blockTimestampNanos };
export { consensusBody, contentKey } from './block.js';

export class Ledger extends EventEmitter {
  constructor(options = {}) {
    super();
    const dbPath = options.dbPath || './data/ledger';
    this.db = new Level(dbPath);
    this._dbOpen = false;
    this.cubes = new Map(); // cubeTimestamp (nanoseconds) -> Cube (keyed by timestamp for deterministic placement)
    this.blocks = new Map(); // blockId -> Block
    this.pendingFaces = new Map(); // faceTimestamp (nanoseconds) -> Face (keyed by timestamp, gossiped for deterministic placement)
    this.nextCubeId = 0;
    this.cubesByFaceIndex = new Map(); // faceIndex -> Cube[] (all cubes with this face index, ordered by timestamp - earliest first)
    this.superCubes = new Map(); // level -> Map<cubeTimestamp, SuperCube> (keyed by timestamp)
    this.completedCubesByLevel = new Map(); // level -> Array<Cube> - tracks completed cubes at each level for recursive formation
    this.pendingFacesByLevel = new Map(); // level -> Map<faceTimestamp, Face> - tracks pending faces at each level
    // D3a: pool of blocks awaiting DETERMINISTIC face-membership sealing (used by
    // addSealedBatch, NOT the legacy incremental addTransaction path). Blocks
    // accumulate here until sealReadyFaces() partitions them by global hash-sort.
    this._membershipPool = [];
    // 2b (ab5932a5) CONSENSUS-V2: when on, sealing is CROSS-NODE AGREED, not local-count. addSealedBatch stops
    // auto-sealing local-9; instead _membershipPool is the L1 candidate pool (getMembershipPool) that a
    // SealRoundManager agrees, then sealAgreedBlocks seals EXACTLY the agreed 9 into a face and queues it in
    // _pendingCubeFaces — the L2 candidate pool (getPendingCubeFaces) a second SealRoundManager agrees before
    // sealAgreedCube assembles a content-keyed cube. OFF (default) = the legacy local-seal path, byte-unchanged.
    this._consensusV2 = !!options.consensusV2;
    this._pendingCubeFaces = [];
    // ⛔ ANCHOR DEDUP BY CONTENT KEY. An anchor asserts "event:hash existed"; that is its identity. But blocks
    // were deduped by block.id, which is derived from the SUBMISSION (from/validationTimestamp/sig), so the
    // SAME anchor re-submitted through the fan-out or a retry minted a NEW block every time — measured 86,056
    // blocks for 31,065 distinct anchors (~2.8× the real count), and every duplicate re-seals, re-applies and
    // re-inflates applied_tx_count into the hundreds of thousands for a system that has only ~3–4k real
    // actions. Track the anchor content keys we already hold and drop a re-submission before it becomes a
    // block. Populated from disk on rehydrate so it survives restarts.
    this._anchorKeys = new Set();
    // EVICTED FOR GOOD. A tx this node has rejected as invalid is recorded by content key and refused on
    // every later path — a resubmission is not re-validated, not re-logged and never written. The set is a
    // keyspace of its own (`evicted:`), so it survives a restart AND a canonical rebuild: rebuildFromAnchors
    // clears block:/cube:/pool: and deliberately does not touch this one. Operator's rule, verbatim:
    // "if a tx is invalid, it's evicted and never seen again."
    this._evicted = new Set();
    
    // Integration: xid for signature verification
    this.xid = options.xid || null;
    
    // Function to lookup public key by address (for signature verification)
    this.getPublicKeyByAddress = options.getPublicKeyByAddress || null;
    
    // Integration: xn for block propagation
    this.xn = options.xn || null;
    this.blockTopic = options.blockTopic || 'blocks';
    // faceTopic + cubeTopic were USED (subscribe below, publish in _gossipFace/_gossipCube) but never assigned —
    // so they were undefined and every face/cube gossip threw libp2p "Topic is required", silently killing the
    // deterministic-placement consensus. Without cube gossip the peers never agree on a cube, so nothing seals to
    // applied state (cubes_persisted stayed 0 even with a full 3/3 validation quorum). Assign them like blockTopic.
    this.faceTopic = options.faceTopic || 'faces';
    this.cubeTopic = options.cubeTopic || 'cubes';

    // Open database (async, but don't block constructor)
    // Hold the boot promise. _initDb opens the store AND rehydrates the pools, the anchor-dedup set and the
    // eviction list; without a handle on it every caller is racing a sleep, and a count taken mid-rehydration
    // reads as "empty" rather than "not ready yet" — which is how an unmeasured claim gets made.
    this._ready = this._initDb().catch(() => {});
    
    // Subscribe to topics if network available
    if (this.xn && this.xn.started) {
      this.xn.subscribe(this.blockTopic).catch(() => {});
      this.xn.on(`message:${this.blockTopic}`, (data) => {
        this._handleIncomingBlock(data);
      });
      
      // Subscribe to face and cube gossip topics
      this.xn.subscribe(this.faceTopic).catch(() => {});
      this.xn.on(`message:${this.faceTopic}`, (data) => {
        this._handleIncomingFace(data);
      });
      
      this.xn.subscribe(this.cubeTopic).catch(() => {});
      this.xn.on(`message:${this.cubeTopic}`, (data) => {
        this._handleIncomingCube(data);
      });
    }
  }
  
  /** Resolves once the store is open and the pools, anchor keys and eviction list are loaded. */
  ready() { return this._ready || Promise.resolve(); }

  /**
   * Release the store. A Ledger OWNS a LevelDB but had no way to give it back: every consumer had to reach
   * into `ledger.db` and close it by hand (`@xmbl/core`'s stop() does exactly that), and anything that forgot
   * left the LOCK held — the next process to open that directory gets `LEVEL_DATABASE_NOT_OPEN` and silently
   * runs with no persistence. Idempotent, and safe on an in-memory ledger.
   */
  async close() {
    const db = this.db;
    this._dbOpen = false;
    if (!db || typeof db.close !== 'function') return;
    if (db.status === 'closed' || db.status === 'closing') return;
    await db.close();
  }

  async _initDb() {
    // A STORE THAT FAILED TO OPEN IS NOT OPEN. This used to set _dbOpen = true on the catch branch too ("might
    // already be open"), so a LevelDB held by another process (its LOCK file), a missing directory or a corrupt
    // manifest left a ledger that reported itself durable while every put/get failed silently into the in-memory
    // fallback — MEASURED 2026-09-16: a CLI `tx add` returned a block id, and the next process could not find the
    // row, because a stale daemon held the lock and the "open" never happened. The truth is the handle's own
    // status, and a failed open is said out loud with its reason.
    this._dbError = null;
    try {
      await this.db.open();
    } catch (error) {
      this._dbError = error;
    }
    this._dbOpen = this.db.status === 'open';
    if (!this._dbOpen) {
      console.error(`[XCLT] ledger store did NOT open (${this._dbError?.code || this._dbError?.message || this.db.status}) — running WITHOUT persistence; nothing added now survives this process`);
      this.emit('store:unavailable', { error: this._dbError, status: this.db.status });
    }
    // ORPHAN FIX: _membershipPool and _pendingCubeFaces are in-memory. Before this, a restart dropped both and
    // the already-persisted blocks were NEVER re-pooled — so they could never join a face and were orphaned for
    // good (measured 2026-07-30 on prod: 2925 blocks persisted, 18 cubes = 486 accounted, 2439 orphaned = 83.4%).
    await this._rehydratePools();
  }

  // Persist the L1 candidate pool as an ID LIST (bodies already live at block:<id>). Cheap: the pool is tens of
  // entries, and rewriting the list is atomic w.r.t. a crash — a partial list would resurrect a partial pool.
  async _persistMembershipPool() {
    if (!this._dbOpen) return;
    try { await this.db.put('pool:membership', JSON.stringify(this._membershipPool.map(b => b.id))); } catch { /* in-memory fallback */ }
  }

  // Persist the L2 candidate pool as {root, ids[]} — getMerkleRoot() recomputes from the member blocks, so the
  // root is never trusted from disk; it is only the dedup key.
  async _persistPendingFaces() {
    if (!this._dbOpen) return;
    const rows = this._pendingCubeFaces.map(f => ({ root: f.getMerkleRoot(), ids: Array.from(f.blocks.values()).map(b => b.id) }));
    try { await this.db.put('pool:pendingfaces', JSON.stringify(rows)); } catch { /* in-memory fallback */ }
  }

  async _loadBlock(id) {
    if (this.blocks.has(id)) return this.blocks.get(id);
    try {
      const data = await this.db.get(`block:${id}`);
      const b = Block.deserialize(data);
      this.blocks.set(b.id, b);
      return b;
    } catch { return null; }
  }

  // Restore both v2 pools. A member whose body is missing is SKIPPED, never faked — a partially-restored face is
  // dropped entirely rather than sealed short, because sealBlocksIntoFaces needs exactly 9 and a short face would
  // change the merkle root and fork.
  async _rehydratePools() {
    if (!this._dbOpen) return;
    // 1. SCAN THE STORE FIRST. Seeds the anchor-dedup set from every block on disk (so a re-submission after a
    //    restart is still a duplicate), notices rows keyed by something other than their content id (written
    //    before block ids addressed consensus content), and — EVERY TRANSACTION IS TYPED BY ITS XID (operator,
    //    2026-09-16) — DELETES every row whose tx carries no micromined xid. MEASURED before the rule: 16,313 of
    //    17,628 anchors on the audited node were untyped. They are counted (`untyped`) and removed, not evicted:
    //    the same anchor re-anchored WITH its identity is welcome. One O(blocks) pass; bodies are plain JSON.
    let legacyKeyed = 0, untyped = 0;
    const doomed = [];
    try {
      for await (const [key, value] of this.db.iterator({ gte: 'block:', lt: 'block;' })) {
        let b; try { b = JSON.parse(value.toString()); } catch { continue; }
        const tx = b && b.tx;
        const body = consensusBody(tx);
        if (body === null) { untyped++; doomed.push(key.toString()); continue; }
        if (tx && tx.type === 'anchor' && tx.event && tx.hash) this._anchorKeys.add(`${tx.event}:${tx.hash}`);
        if (key.toString().slice('block:'.length) !== contentIdOf(body)) legacyKeyed++;
      }
    } catch { /* no blocks yet */ }
    for (const key of doomed) { try { await this.db.del(key); } catch { /* gone */ } this.blocks.delete(key.slice('block:'.length)); }
    if (untyped > 0) console.warn(`[XCLT] boot: deleted ${untyped} untyped block row(s) — every transaction carries its xmbl type as a micromined xid`);
    // 2. The eviction list. Cheap (one short keyspace) and it is what makes "never seen again" outlive this
    //    process rather than being a decision the node forgets the moment it restarts.
    try {
      for await (const [key] of this.db.iterator({ gte: 'evicted:', lt: 'evicted;' })) {
        this._evicted.add(key.toString().slice('evicted:'.length));
      }
    } catch { /* no evictions yet */ }
    // 3. CONVERGE THE STORE TO CONTENT IDS, ONCE. Runs only when the scan found a row keyed by an envelope hash,
    //    so a store that is already content-keyed pays nothing; the second boot finds 0 and skips.
    let rekey = null;
    if (legacyKeyed > 0) {
      try { rekey = await this.compactToContentIds(); }
      catch (e) { console.warn(`[XCLT] content-id compaction failed, store left as found: ${e?.message || e}`); }
    }
    // 4. Restore both v2 pools from what SURVIVED. A member whose body is missing is SKIPPED, never faked — a
    //    partially-restored face is dropped entirely rather than sealed short, because sealBlocksIntoFaces needs
    //    exactly 9 and a short face would change the merkle root and fork.
    if (!rekey) {
      try {
        const raw = await this.db.get('pool:membership');
        const ids = JSON.parse(raw);
        const have = new Set(this._membershipPool.map(b => b.id));
        for (const id of ids) {
          if (have.has(id)) continue;
          const b = await this._loadBlock(id);
          if (b) this._membershipPool.push(b);
        }
      } catch { /* no saved pool yet */ }
      if (untyped > 0) await this._persistMembershipPool();   // the pool no longer names the deleted rows
    }
    try {
      const raw = await this.db.get('pool:pendingfaces');
      const rows = JSON.parse(raw);
      const haveRoots = new Set(this._pendingCubeFaces.map(f => f.getMerkleRoot()));
      for (const row of rows) {
        const blocks = [];
        for (const id of row.ids || []) { const b = await this._loadBlock(id); if (b) blocks.push(b); }
        if (blocks.length !== 9) continue;                 // never seal a short face — it would fork the root
        const { faces } = sealBlocksIntoFaces(blocks);
        const face = faces[0];
        if (face && !haveRoots.has(face.getMerkleRoot())) this._pendingCubeFaces.push(face);
      }
    } catch { /* no saved pending faces yet */ }
    this.emit('pools:rehydrated', { pooled: this._membershipPool.length, pendingFaces: this._pendingCubeFaces.length, anchorKeys: this._anchorKeys.size, evicted: this._evicted.size, legacyKeyed, untyped, rekey });
  }

  /**
   * Add a transaction to the ledger
   * @param {Object} tx - Transaction object
   * @returns {Promise<Object>} Block information
   * @emits block:added
   * @emits face:complete
   * @emits cube:complete
   */
  /**
   * The eviction key for a datum whose claimed xid is NOT its content address: a digest of the exact bytes
   * offered (the claimed identity plus the body it actually carries). Refuses that forgery forever without
   * ever touching the xid it impersonates.
   */
  _forgedKey(tx) {
    let body = null;
    try { body = micromineBody(tx); } catch { body = null; }
    const material = JSON.stringify({ xid: tx?.xid ?? null, nonce: tx?.nonce ?? null, type: tx?.type ?? null, body });
    return `forged:${createHash('sha256').update(material).digest('hex')}`;
  }

  async addTransaction(tx, opts = {}) {
    // Integration: Verify signature if xid available and tx has signature and from address
    if (this.xid && tx.sig && tx.from) {
      try {
        const { Identity } = await import('@xmbl/identity');
        
        // Look up public key from address
        let publicKey = null;
        if (this.getPublicKeyByAddress && typeof this.getPublicKeyByAddress === 'function') {
          publicKey = this.getPublicKeyByAddress(tx.from);
        }
        
        if (publicKey) {
          const isValid = await Identity.verifyTransaction(tx, publicKey);
          if (!isValid) {
            throw new Error('Invalid transaction signature or address mismatch');
          }
        } else {
          // If we can't get public key, skip verification (should not happen in production)
          console.warn('[XCLT] Could not lookup public key for address:', tx.from);
        }
      } catch (error) {
        // If xid module not available, skip verification
        if (error.code !== 'ERR_MODULE_NOT_FOUND' && !error.message.includes('Base64')) {
          throw error;
        }
      }
    }
    
    // EVICTED MEANS EVICTED. Checked before anything else so a tx this node has already rejected by its own
    // identity — content key or xid — costs one set lookup and touches neither the validator nor the disk.
    // A FORGERY IS DELIBERATELY NOT IN THIS SET under any key it can present: it is evicted under
    // `forged:<sha256 of its own bytes>` (see _forgedKey), which by construction cannot be recognised without
    // hashing the body. So a resubmitted forgery is refused by the VALIDATOR, one stage later, not here —
    // that is the price of never letting a forgery hold a key that belongs to the datum it impersonates.
    const ckey = contentKey(tx);
    const xkey = tx && typeof tx.xid === 'string' ? `xid:${tx.xid}` : null;
    if ((ckey && this._evicted.has(ckey)) || (xkey && this._evicted.has(xkey))) return { pooled: this._membershipPool.length, sealedFaces: 0, evicted: true };
    // CONTENT DEDUP: one anchor (event:hash) is one block, forever. A re-submission of an anchor we already
    // hold is a no-op, not a new block — this is what stops the ledger inflating to 3× its real size and the
    // applied counter running to 100k+. Non-anchor txs are unaffected (they carry their own identity).
    if (tx && tx.type === 'anchor' && tx.event && tx.hash) {
      const akey = `${tx.event}:${tx.hash}`;
      if (this._anchorKeys.has(akey)) return { pooled: this._membershipPool.length, sealedFaces: 0, duplicate: true };
      this._anchorKeys.add(akey);
    }
    let block;
    try {
      block = Block.fromTransaction(tx, opts);
    } catch (error) {
      // ⛔ THE SPECULATIVE CONTENT KEY IS TAKEN BACK ON EVERY FAILURE, not just on UNTYPED. The key above is
      // claimed BEFORE the datum is validated, so a forgery that keeps a genuine anchor's `event` and `hash`
      // and breaks anything else (its nonce, its type prefix, its body) left that key claimed forever — and
      // the genuine anchor arriving later was answered `duplicate: true` and never stored. The same
      // denial-of-service as the xid eviction below, through the dedup door instead of the eviction door.
      if (ckey && this._anchorKeys.has(ckey)) this._anchorKeys.delete(ckey);
      // An invalid tx is evicted here, at the door, and recorded so it is never examined again. Without the
      // record the same bad tx is re-validated and re-logged on every resubmission for the life of the node.
      // UNTYPED is the one refusal that is NOT an eviction: the datum simply has no identity yet, and the same
      // anchor (same event:hash) may arrive typed a moment later — evicting its content key would refuse that too.
      if (error && error.code === 'UNTYPED') { throw error; }   // no identity yet: refused, never evicted
      // ⛔ NEVER EVICT BY A CLAIMED-BUT-UNPROVEN XID. This evicted by `xid:<claimed>` whenever a typed datum
      // failed — and a datum fails validateXid precisely when its body does NOT hash to that xid, i.e. when the
      // xid belongs to SOMEBODY ELSE'S datum. So anyone could take a genuine anchor's xid, change one byte of
      // the body, submit it, and the genuine anchor was evicted-for-good on every node that saw the forgery —
      // refused forever if it had not arrived yet, and its stored rows DELETED by evict() if it had. A
      // denial-of-service against any transaction whose xid is public, which is all of them.
      // MEASURED by reproductions/three-nodes.mjs before this fix: three nodes given the identical 36-anchor
      // set plus one forgery ended with 36 / 35 / 36 blocks — the node that happened to receive the forgery
      // first was the one that lost the genuine anchor.
      // The forgery is still refused forever, under a key derived from ITS OWN bytes, which no genuine datum
      // can collide with because those bytes do not content-address to anything.
      const ekey = (error && error.code === 'XID_MISMATCH') ? this._forgedKey(tx) : (ckey || null);
      if (ekey) await this.evict(ekey, error.message);
      throw error;
    }
    // ⛔ DETERMINISTIC FACE MEMBERSHIP — replaces "join the oldest pending face with room, seal on the 9th
    // ARRIVAL". That rule made WHICH nine blocks form a face depend on arrival order, so two nodes given the
    // identical transaction set partitioned it differently and produced different faces, cubes and digests.
    // Measured 2026-08-03 after a full wipe + identical replay: prod and laptop both reached 5,145 blocks /
    // 190 cubes with DIFFERENT set_digests.
    //
    // The rule (operator-specified): pool the block, then seal HASH-SORTED chunks of 9. The hash carries the
    // quorum-averaged validator timestamp, so the partition is a pure function of the SET — identical on every
    // node, with no coordination. _sealReadyFaces() already implements exactly this; addTransaction simply
    // stopped bypassing it.
    if (!this._membershipPool.some(b => b.id === block.id)) {
      this._membershipPool.push(block);
      if (this._dbOpen) { try { await this.db.put(`block:${block.id}`, block.serialize()); } catch { /* in-memory fallback */ } }
      await this._persistMembershipPool();
    }
    // Under consensus-v2 the pool is the candidate set a seal round agrees; otherwise seal every full 9 now.
    // Either way the caller learns WHICH block it just pooled (content id + whole-tx hash) — a CLI, a devnet
    // or a bridge that submits a tx needs its id to look it up, and had no way to get it from this reply.
    const sealed = this._consensusV2 ? { pooled: this._membershipPool.length, sealedFaces: 0 } : await this._sealReadyFaces();
    return { id: block.id, hash: block.hash, ...sealed };
  }

  async addSealedBatch(txs, opts = {}) {
    if (!Array.isArray(txs)) {
      throw new Error('addSealedBatch: txs must be an array');
    }
    // ⛔ A REFUSAL REFUSES ONE TRANSACTION, NOT THE BATCH. This loop used to let the first invalid entry throw
    // straight out, so every genuine transaction BEHIND it in the list was dropped on the floor, unsealed and
    // unrecorded — a denial of service needing no xid collision at all, just a forgery sent ahead of real
    // traffic. The refusal is still raised to the caller (after the genuine entries are admitted and sealed),
    // because a finalized transaction the ledger will not take is a fault consensus must hear about.
    let firstError = null;
    for (const tx of txs) {
      // Same eviction check and content dedup as addTransaction — this path is not a way around either.
      const ckey = contentKey(tx);
      const xkey = tx && typeof tx.xid === 'string' ? `xid:${tx.xid}` : null;
      if ((ckey && this._evicted.has(ckey)) || (xkey && this._evicted.has(xkey))) continue;
      if (tx && tx.type === 'anchor' && tx.event && tx.hash) {
        const akey = `${tx.event}:${tx.hash}`;
        if (this._anchorKeys.has(akey)) continue;
        this._anchorKeys.add(akey);
      }
      // Mirror addTransaction's optional signature verification — IDENTICALLY. This used to
      // call `this.xid.verify(tx, tx.sig, publicKey)`, a method that does not exist on an
      // Identity instance (the only thing ever assigned to ledger.xid) → TypeError, so this
      // check had never actually verified a signature (DEVNET-SEAM-FINDING defect (b)). The
      // correct, consistent call is the static Identity.verifyTransaction used by
      // addTransaction, which also enforces derivedAddress===from sig-ownership.
      if (this.xid && tx.sig && tx.from) {
        try {
          const { Identity } = await import('@xmbl/identity');
          let publicKey = null;
          if (this.getPublicKeyByAddress && typeof this.getPublicKeyByAddress === 'function') {
            publicKey = await this.getPublicKeyByAddress(tx.from);
          }
          if (publicKey) {
            const isValid = await Identity.verifyTransaction(tx, publicKey);
            if (!isValid) {
              throw new Error(`Invalid signature for transaction from ${tx.from}`);
            }
          }
        } catch (error) {
          if (error.code !== 'ERR_MODULE_NOT_FOUND' && !error.message.includes('Base64')) {
            throw error;
          }
        }
      }
      // ⛔ THE SAME TWO DOORS addTransaction CLOSES, CLOSED HERE TOO — and this is the path that carries real
      // node traffic (consensus `tx:finalized` → lead-worker.handleFinalizedTx → here), while addTransaction
      // is the legacy incremental one. There was no failure handling at all on this side, so a forgery that
      // kept a genuine anchor's event:hash left that content key claimed forever (the genuine anchor arriving
      // later was skipped as a duplicate), and nothing was ever evicted. Release the speculative key on EVERY
      // failure, and record the refusal under a key derived from the forgery's OWN bytes when its claimed xid
      // is not its content address — never under the xid it impersonated, which belongs to somebody else.
      let block;
      try {
        block = Block.fromTransaction(tx, opts);
      } catch (error) {
        if (ckey && this._anchorKeys.has(ckey)) this._anchorKeys.delete(ckey);
        // UNTYPED is a refusal, not an eviction: the datum has no identity yet and the same anchor may arrive
        // typed a moment later — exactly as in addTransaction.
        if (!(error && error.code === 'UNTYPED')) {
          const ekey = (error && error.code === 'XID_MISMATCH') ? this._forgedKey(tx) : (ckey || null);
          if (ekey) await this.evict(ekey, error.message);
        }
        if (!firstError) firstError = error;
        continue;
      }
      // THE POOL IS A SET, AND push() DOES NOT KNOW THAT. block.id is derived from the transaction content,
      // so re-admitting the same tx yields the SAME id — `this.blocks.set` above silently overwrites and the
      // caller never notices, while this line appended a phantom duplicate. That is not an over-count: the
      // L1 candidate is `candidatePrefix(getMembershipPool())`, which sorts the whole pool and takes the
      // lowest 9 by hash, so a node holding entries its peers do not can never propose their set-hash. It
      // races ahead, they stall, and three ledgers settle on three different cube sets — the exact divergence
      // measured on the container testnet (submitter 81 blocks from 69 finalizations, peers ~59, pooled 5).
      // Dedup by id makes double-admission harmless from ANY path, not just the one that was fixed upstream.
      const already = this._membershipPool.some((b) => b.id === block.id);
      this.blocks.set(block.id, block);
      if (already) continue;
      this._membershipPool.push(block);
      // ORPHAN FIX: persist the BODY at admit, not only at seal. Rehydration needs block:<id> to exist for a
      // pooled-but-unsealed block; without this, a restart mid-round loses it permanently.
      if (this._dbOpen) { try { await this.db.put(`block:${block.id}`, block.serialize()); } catch { /* in-memory fallback */ } }
      await this._persistMembershipPool();
    }
    // CONSENSUS-V2: do NOT auto-seal local-9. The pool is the L1 candidate; a SealRoundManager agrees the set
    // cross-node, then calls sealAgreedBlocks. Sealing on a local count is the fork bug this fixes.
    if (this._consensusV2) {
      if (firstError) throw firstError;
      return { sealedFaces: 0, pooled: this._membershipPool.length };
    }
    const sealed = await this._sealReadyFaces();
    if (firstError) throw firstError;
    return sealed;
  }

  // DETERMINISTIC REBUILD — the cube ledger becomes a PURE FUNCTION of the canonical anchor set, so it can
  // NEVER drift between nodes: there is no independent per-node ledger history left to diverge, no gossip and
  // no seal round to stall. Every node handed the same anchors wipes its ledger and rebuilds byte-identical
  // blocks (id = sha256(tx)), hash-sorts them into 9-block faces and 3-face cubes (already a pure function of
  // the set, per sealBlocksIntoFaces / sortFacesByHash), and seals ALL complete faces immediately — the
  // canonical set IS the agreement the seal round used to negotiate. This is the same convergence primitive as
  // xvsm.rebuildFromCanonical, extended from the verkle STATE root to the CUBE LEDGER.
  async rebuildFromAnchors(anchors) {
    const list = Array.isArray(anchors) ? anchors : [];

    // ⛔ 0a. A REBUILD THAT WOULD EMPTY THE CHAIN IS REFUSED, AND NOTHING IS TOUCHED.
    //
    // This is a DRY PASS over the set before a single row is deleted. Every anchor is typed by its xid now, so
    // a canonical set minted before typing rebuilds to NOTHING — measured on the live broker's default feed:
    // 0 of 4008 rebuilt, 3991 untyped, 17 rejected. The wipe used to run first regardless, so handing an old
    // feed to a typed-only node destroyed its chain and accurately reported the zero afterwards. That cannot be
    // left to the caller's version: a coordinator process still holding pre-gate code, or restarted in the
    // wrong order during an OTA roll, would drive exactly that call. So the NODE refuses it. The rule is
    // deliberately narrow — it only refuses when the rebuild would produce no blocks at all while this ledger
    // still holds some. A canonical rebuild that legitimately SHRINKS a divergent chain is untouched, which is
    // the whole point of the primitive.
    const held = this.blocks.size + (Array.isArray(this._membershipPool) ? this._membershipPool.length : 0);
    if (held > 0) {
      let wouldRebuild = 0, dryUntyped = 0, dryRejected = 0, dryEvicted = 0;
      const dryKeys = new Set();
      for (const a of list) {
        if (!a || !a.event || !a.hash) continue;
        const k = `${a.event}:${a.hash}`;
        if (dryKeys.has(k)) continue;
        dryKeys.add(k);
        if (this._evicted.has(k)) { dryEvicted++; continue; }   // an evicted anchor is not a block this rebuild would produce
        if (typeof a.xid !== 'string' || !a.xid) { dryUntyped++; continue; }
        const probe = { type: 'anchor', event: a.event, hash: a.hash, ts: a.ts ?? 0, xid: a.xid, nonce: a.nonce, prior: typeof a.prior === 'string' ? a.prior : undefined };
        if (probe.prior === undefined) delete probe.prior;
        try { Block.fromTransaction(probe); wouldRebuild++; } catch { dryRejected++; }
      }
      if (wouldRebuild === 0) {
        const reason = `refusing to rebuild: the ${list.length} anchor(s) offered rebuild to 0 blocks (${dryUntyped} untyped, ${dryRejected} rejected) while this ledger holds ${held} — that is a wipe, not a rebuild. This node requires anchors typed by their xid; ask the broker for the epoch-scoped feed (?from_epoch=1) or check ledger_capabilities.requires_typed_anchors first.`;
        console.warn(`[XCLT] ${reason}`);
        return { refused: 'would-empty-the-chain', reason, requested: list.length, would_rebuild: 0, untyped: dryUntyped, rejected: dryRejected, evicted_skipped: dryEvicted, blocks_held: held, anchors: [], faces_sealed: 0, wiped: 0, cubes: this.cubes.size };
      }
    }

    // 0. RESCUE WHAT THE ANCHOR SET CANNOT RE-DERIVE, BEFORE THE WIPE.
    //
    // ⛔ THIS FUNCTION DESTROYED VALUE TRANSACTIONS EVERY 90 SECONDS. Step 1 clears the whole `block:`
    // keyspace and step 2 rebuilds it from the broker's canonical ANCHORS — so any block that is not an
    // anchor had no source to come back from and was simply gone. MEASURED on this node 2026-09-15: 14,890
    // block rows, of which 249 were type-6 value txs (`tx`), none of them in the canonical set. The
    // convergence timer calls this every ~90s. SirKit measured the ledger from the outside over the same day:
    // 17,901 block rows / 51M on disk at 10:16Z, 4,149 at 16:04Z, 6,740 at 17:04Z — a truncate-and-regrow, not
    // compaction, with nothing logged by the node or the coordinator to say a row had been deleted.
    //
    // A canonical rebuild is allowed to discard a DIVERGENT chain. It is not allowed to discard state the
    // canonical set does not describe: the broker's anchor set contains anchors and nothing else, so every
    // utxo, identity, contract, token and type-6 tx this node holds is outside it by construction. Those are
    // re-admitted below, in deterministic id order after the anchors, so two nodes holding the same canonical
    // set and the same local txs still rebuild to the same chain.
    const preserved = [];
    let wipedBlocks = 0;
    let evictedSkipped = 0;   // anchors AND rescued txs refused by the durable `evicted:` set, counted once for the reply
    if (this._dbOpen) {
      try {
        for await (const [, value] of this.db.iterator({ gte: 'block:', lt: 'block;' })) {
          wipedBlocks++;
          let raw; try { raw = JSON.parse(value.toString()); } catch { continue; }
          if (!raw || !raw.tx || raw.tx.type === 'anchor') continue;
          // An evicted tx is not rescued — the rescue exists to save state the canonical set cannot describe,
          // not to carry a row this node has already ruled out back across the wipe.
          const rk = contentKey(raw.tx);
          if (rk && this._evicted.has(rk)) { evictedSkipped++; continue; }
          let b; try { b = Block.deserialize(value.toString()); } catch { continue; /* unreadable row, leave it */ }
          // RESTORE THE BLOCK'S OWN TIME, NEVER THIS NODE'S CLOCK. Rows written before Block.serialize()
          // carried `timestamp` have no timestamp field at all, and Block's constructor defaults an absent
          // one to Date.now() — so the rescue pass was re-stamping every preserved block with the instant
          // the rebuild ran. MEASURED on a rebuild of this node's real ledger: all 276 value-tx blocks came
          // back with times inside a 58ms window at 2026-09-16T03:47:58Z, 56 distinct values, i.e. the wall
          // clock. That makes the rebuilt chain a function of WHEN a node rebuilt, which is exactly what a
          // canonical rebuild exists to eliminate. validationTimestamp is the consensus time the rest of the
          // ledger already prefers for these blocks (face.getAverageTimestamp reads it first), so it is the
          // deterministic answer; a block that carries neither gets 0n rather than a borrowed clock.
          const own = blockTimestampNanos(raw);
          if (own !== null) b.timestamp = own;
          preserved.push(b);
        }
      } catch { /* no blocks yet */ }
      preserved.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    }
    // 1. WIPE — in-memory + persisted. Nothing of the old divergent chain survives.
    this.blocks = new Map();
    this.cubes = new Map();
    if (this.cubesByFaceIndex instanceof Map) this.cubesByFaceIndex = new Map();
    this._membershipPool = [];
    if (Array.isArray(this._pendingCubeFaces)) this._pendingCubeFaces = [];
    this._anchorKeys = new Set();
    this._chainCounts = null;
    // ⛔ RESET THE CUBE-FORMATION ACCUMULATORS TOO — this is what stalled cubes_persisted at 0. The convergence
    // timer calls rebuild_ledger every ~90s, but the wipe above reset this.cubes WITHOUT resetting _slotFaces
    // (the per-slot face counter _finalizeFace uses to pick `cube#k`: k = _slotFaces[slot].length). Left stale,
    // _slotFaces kept growing every rebuild, so each rebuild's faces were assigned to ever-higher, ever-more-
    // divergent cube ordinals that could never collect 3 faces — cubes stopped finalizing after ~8 rebuilds
    // (proven: cubes_persisted 31 → 0, then 0 forever) and the 3D landmark read "none finalized". A rebuild is a
    // PURE FUNCTION of the anchor set, so ALL derived in-memory formation state must reset with the ledger, not
    // just this.cubes. Everything here is re-derived deterministically from the same anchors on the next pass.
    this._slotFaces = [[], [], []];
    this.pendingFaces = new Map();
    this.superCubes = new Map();
    this.completedCubesByLevel = new Map();
    this.pendingFacesByLevel = new Map();
    this.nextCubeId = 0;
    if (this._dbOpen) {
      // FACES ARE DERIVED STATE, NOT A KEYSPACE. No code path has ever written a `face:` row — blocks are
      // persisted, cubes are persisted, and a face is re-sealed deterministically from its nine blocks on
      // every boot and every rebuild (that determinism is the whole convergence argument). Clearing a
      // keyspace nobody writes is a phantom: it read as durable face state that a rebuild had to discard,
      // which is exactly backwards. The in-memory formation state above IS the reset.
      for (const pfx of ['block:', 'cube:', 'pool:']) {
        try { await this.db.clear({ gte: pfx, lt: pfx.slice(0, -1) + ';' }); } catch { /* in-memory fallback */ }
      }
    }
    // 2. Content-dedup (one anchor event:hash = one block) and DETERMINISTIC order (by hash then event), so
    //    admission order is identical on every node regardless of how the anchors were delivered.
    const seen = new Set();
    const uniq = [];
    for (const a of list) {
      if (!a || !a.event || !a.hash) continue;
      const k = `${a.event}:${a.hash}`;
      if (seen.has(k)) continue;
      seen.add(k);
      // ⛔ AN EVICTION THAT A REBUILD UNDOES IS NOT AN EVICTION. The `evicted:` keyspace is deliberately not
      // cleared by the wipe below — the comment on `this._evicted` has always claimed the set survives a
      // canonical rebuild — but this loop never CONSULTED it, so a feed that still carried the anchor minted
      // the block straight back on the next ~90s convergence tick. Every one of the three admission paths
      // (addTransaction, addSealedBatch, and this) must refuse an evicted key, or the other two are theatre.
      if (this._evicted.has(k)) { evictedSkipped++; continue; }
      uniq.push(a);
    }
    uniq.sort((x, y) => (x.hash < y.hash ? -1 : x.hash > y.hash ? 1 : (x.event < y.event ? -1 : x.event > y.event ? 1 : 0)));
    let untyped = 0, rejected = 0, rebuilt = 0;
    for (const a of uniq) {
      // EVERY TRANSACTION IS TYPED BY ITS XID (operator, 2026-09-16). An anchor is a type-7 pointer datum whose
      // {xid, nonce, prior} the broker mined at submit time; the xid chains to the prior anchor, so it is NOT a
      // pure function of this set and this node cannot re-derive it. A canonical row that arrives WITHOUT its
      // identity is not rebuilt — it is counted here, and the count is the feed's defect to fix (the canonical
      // feed must carry xid + nonce + prior). Nothing is back-mined into a chain position nobody recorded.
      if (typeof a.xid !== 'string' || !a.xid) { untyped++; continue; }
      const tx = { type: 'anchor', event: a.event, hash: a.hash, ts: a.ts ?? 0, xid: a.xid, nonce: a.nonce, prior: typeof a.prior === 'string' ? a.prior : undefined };
      if (tx.prior === undefined) delete tx.prior;
      let block;
      try { block = Block.fromTransaction(tx); }   // a rebuilt anchor's time is pinned from its own `ts` below, never a caller's
      catch (e) { rejected++; continue; }   // a typed row the rule refuses (bad prefix, body does not mine): not rebuilt
      this._anchorKeys.add(`${a.event}:${a.hash}`);
      rebuilt++;
      // Pin the block timestamp to the anchor ts (a BigInt, as the rest of the ledger expects for its
      // validator-average math) so cube placement is identical across nodes instead of falling back to a
      // per-node hrtime. Face membership is already deterministic via the content hash; this makes the CUBE
      // key deterministic too, so the whole sealed chain is one function of the canonical set.
      block.timestamp = anchorTimestampNanos(a.ts);
      this.blocks.set(block.id, block);
      this._membershipPool.push(block);
    }
    // 2b. RE-ADMIT the rescued non-anchor blocks. They are appended AFTER the anchors and in id order, so the
    //     rebuilt chain stays a pure function of (canonical set, local non-anchor set) rather than of the
    //     order rows happened to come off disk.
    for (const block of preserved) {
      if (this.blocks.has(block.id)) continue;
      this.blocks.set(block.id, block);
      this._membershipPool.push(block);
      if (this._dbOpen) { try { await this.db.put(`block:${block.id}`, block.serialize()); } catch { /* in-memory fallback */ } }
    }
    // 3. Seal every complete 9-block face deterministically. Loop because a future _sealReadyFaces may seal one
    //    face per call; today it drains the whole pool in one pass, so the second iteration returns 0 and stops.
    let faces = 0, guard = 0;
    for (;;) {
      const r = await this._sealReadyFaces();
      faces += (r && r.sealedFaces) || 0;
      if (!r || r.sealedFaces === 0 || ++guard > 200000) break;
    }
    await this._persistMembershipPool();
    // SAY WHAT WAS DESTROYED. A rebuild clears the whole block/cube/face/pool keyspace and nothing anywhere
    // wrote a line about it: SirKit watched this box lose 13,750 block rows and regain 10,500 over one day
    // with no prune, rebuild, compact or delete entry in node.log or coordinator.log. A box can lose most of
    // its ledger invisibly. This is the only place that knows both numbers, so it is the place to print them.
    console.log(`[XCLT] canonical rebuild: wiped ${wipedBlocks} block row(s), rebuilt ${rebuilt} of ${uniq.length} anchor(s) `
      + `(${untyped} untyped, ${rejected} rejected, ${evictedSkipped} evicted), preserved ${preserved.length} non-anchor block(s), sealed ${faces} face(s), ${this.cubes.size} cube(s)`);
    return {
      anchors: rebuilt,
      untyped,
      rejected,
      evicted_skipped: evictedSkipped,
      blocks: this.blocks.size,
      wiped: wipedBlocks,
      preserved: preserved.length,
      faces_sealed: faces,
      cubes: this.cubes.size,
      pooled: this._membershipPool.length,
    };
  }

  /**
   * IS THIS CONTENT KEY EVICTED? The public predicate over the durable `evicted:` set, so a caller that is
   * about to apply anchors SOMEWHERE ELSE — the verkle tree, most of all — can refuse the same rows this
   * ledger refuses. Without it the two stores disagree by construction: `rebuild_ledger` declines to mint an
   * evicted anchor as a block and then hands the SAME unfiltered list to xvsm.rebuildFromCanonical, which
   * knows nothing about eviction and writes the key straight back. MEASURED before this existed: the key was
   * absent from the ledger and present in the tree after one convergence tick.
   * Accepts `<event>:<hash>`, `anchor:<event>:<hash>`, or `xid:<xid>`.
   */
  isEvicted(key) {
    if (typeof key !== 'string' || !key) return false;
    if (this._evicted.has(key)) return true;
    return key.startsWith('anchor:') && this._evicted.has(key.slice('anchor:'.length));
  }

  // ---- CONSENSUS-V2 (2b) seal hooks. STATE lives here; the SealRoundManager (in core, with the gossip) injects
  // getMembershipPool as getItems and calls sealAgreedBlocks as sealSet. block.hash is the node-consistent L1 key. ----
  getMembershipPool() { return this._membershipPool; }
  getPendingCubeFaces() { return this._pendingCubeFaces; }
  // ADOPT resolution: return the pool items matching the agreed member ids/roots. If fewer than requested are
  // present, the caller (core adoptSet) STALLS — the missing member hasn't arrived yet; commit-2's retry delivers
  // it, and the next tick retries. This is how a minority node converges on the quorum set instead of forking.
  /**
   * EVICT A TRANSACTION FOR GOOD. Records the content key durably, deletes any block row still carrying it,
   * and drops it from the pool and the anchor-dedup set so nothing re-seals it. Returns what it actually
   * removed, never a claim of success.
   */
  async evict(key, reason = 'invalid') {
    if (!key) return { evicted: false, rows_deleted: 0 };
    this._evicted.add(key);
    if (this._dbOpen) {
      try { await this.db.put(`evicted:${key}`, JSON.stringify({ reason, at: new Date().toISOString() })); }
      catch { /* in-memory fallback */ }
    }
    this._anchorKeys.delete(key);
    // Scan the keyspace, not this.blocks: addTransaction persists a block and pools it WITHOUT putting it in
    // this.blocks (that map is populated by seal/rebuild paths), so an in-memory sweep alone deletes nothing.
    let rows = 0;
    if (this._dbOpen) {
      const doomed = [];
      try {
        for await (const [k, v] of this.db.iterator({ gte: 'block:', lt: 'block;' })) {
          let raw; try { raw = JSON.parse(v.toString()); } catch { continue; }
          if (contentKey(raw && raw.tx) === key) doomed.push(k.toString().slice('block:'.length));
        }
      } catch { /* no blocks yet */ }
      for (const id of doomed) {
        try { await this.db.del(`block:${id}`); rows++; } catch { /* already gone */ }
        this.blocks.delete(id);
      }
    }
    for (const [id, block] of [...this.blocks]) {
      if (contentKey(block.tx) === key) this.blocks.delete(id);
    }
    const before = this._membershipPool.length;
    this._membershipPool = this._membershipPool.filter(b => contentKey(b.tx) !== key);
    if (before !== this._membershipPool.length) await this._persistMembershipPool();
    return { evicted: true, rows_deleted: rows, pooled: this._membershipPool.length };
  }

  /**
   * RE-KEY THE BLOCK STORE TO CONTENT IDS AND DROP THE REDUNDANT ROWS.
   *
   * Rows written before the id addressed consensus content (block.js consensusBody) are keyed by a hash of
   * the whole tx, envelope included — so the SAME anchor sits on disk under several ids, one per node that
   * relayed it and per time it was resubmitted. MEASURED here 2026-09-16: 17,908 rows over 13,783 distinct
   * (event:hash) pairs, 13,665 carrying node-local fields in the id, 1,273 keys duplicated across 3,849
   * redundant rows.
   *
   * This is a targeted DELETE, not a rebuild: it keeps exactly one row per content key — preferring the row
   * whose tx is already the bare consensus shape, then the lowest id for determinism — writes it under its
   * content id, and deletes the rest. Rows outside the broker's canonical set are NOT touched; they may be
   * real local events the broker has not canonicalised, and nothing here can tell the difference.
   *
   * Returns real counts. Nothing is evicted by content: the content was valid, only the extra rows were junk.
   */
  async compactToContentIds() {
    if (!this._dbOpen) return { scanned: 0, kept: 0, rekeyed: 0, deleted: 0, unaddressed: 0 };
    const ENVELOPE = ['from', 'sig', 'validationTimestamp', 'id', 'agent', 'agent_xmbl_address'];
    const groups = new Map();           // content key -> [{ oldId, raw, envelopeFields }]
    let scanned = 0, unaddressed = 0;
    for await (const [key, value] of this.db.iterator({ gte: 'block:', lt: 'block;' })) {
      scanned++;
      let raw; try { raw = JSON.parse(value.toString()); } catch { continue; }
      const ck = contentKey(raw && raw.tx);
      if (!ck) { unaddressed++; continue; }
      const oldId = key.toString().slice('block:'.length);
      if (!groups.has(ck)) groups.set(ck, []);
      groups.get(ck).push({ oldId, value: value.toString(), raw,
                            envelope: ENVELOPE.filter(f => f in raw.tx).length });
    }
    let kept = 0, rekeyed = 0, deleted = 0, removed = 0, evicted = 0, untyped = 0;
    for (const [ck, rows] of groups) {
      // EVICTED MEANS EVICTED, here too: a content key on the eviction list keeps no row at all.
      if (this._evicted.has(ck)) {
        for (const r of rows) { try { await this.db.del(`block:${r.oldId}`); deleted++; removed++; } catch { /* gone */ } this.blocks.delete(r.oldId); }
        evicted++;
        continue;
      }
      // the row closest to bare consensus shape wins; ties broken by id so every node picks the same one
      rows.sort((a, b) => (a.envelope - b.envelope) || (a.oldId < b.oldId ? -1 : a.oldId > b.oldId ? 1 : 0));
      const keep = rows[0];
      let block, newId;
      try {
        block = Block.deserialize(keep.value);
        newId = Block.fromTransaction(block.tx).id;   // re-validates: a row the CURRENT rule refuses is evicted
      } catch (e) {
        // One row that fails today's validation must not abort the pass for every other row. An UNTYPED row
        // (no micromined xid — every row written before the type rule) is deleted and counted, never evicted:
        // its typed successor must be admitted. A row the rule refuses for cause is evicted by content key —
        // recorded, its rows deleted, refused on every later path — exactly as if it were submitted now.
        if (e && e.code === 'UNTYPED') untyped++;
        else { try { await this.evict(ck, `rejected during content-id compaction: ${e?.message || e}`); } catch { /* best effort */ } evicted++; }
        for (const r of rows) { try { await this.db.del(`block:${r.oldId}`); deleted++; removed++; } catch { /* gone */ } this.blocks.delete(r.oldId); }
        continue;
      }
      const own = blockTimestampNanos(keep.raw);
      if (own !== null) block.timestamp = own;
      block.id = newId;
      for (const r of rows) {
        if (r.oldId === newId) continue;
        try { await this.db.del(`block:${r.oldId}`); deleted++; } catch { /* already gone */ }
        this.blocks.delete(r.oldId);
        if (r !== keep) removed++;   // a genuinely redundant row; the survivor's own del is a re-key
      }
      if (keep.oldId !== newId) rekeyed++;
      try { await this.db.put(`block:${newId}`, block.serialize()); } catch { /* in-memory fallback */ }
      this.blocks.set(newId, block);
      kept++;
    }
    // the pool and the anchor-dedup set now hold stale ids; re-derive both from what actually survived
    this._membershipPool = [...this.blocks.values()];
    this._anchorKeys = new Set();
    for (const b of this.blocks.values()) {
      const ck = contentKey(b.tx);
      if (ck && b.tx.type === 'anchor') this._anchorKeys.add(ck);
    }
    await this._persistMembershipPool();
    // SAY WHAT WAS DESTROYED, and do not dress a re-key up as a deletion: `deleted` counts every old key
    // removed (a survivor moving to its content id removes one too), `removed` counts only the rows that had
    // no survivor — the genuinely redundant copies. scanned - kept must equal removed, or something is wrong.
    console.log(`[XCLT] content-id compaction: scanned ${scanned} row(s), kept ${kept} distinct content key(s), `
      + `re-keyed ${rekeyed}, removed ${removed} redundant row(s) (${deleted} old key(s) deleted in total), `
      + `${evicted} content key(s) evicted, ${unaddressed} row(s) had no content address and were left alone`);
    return { scanned, kept, rekeyed, removed, deleted, evicted, untyped, unaddressed, balanced: scanned - unaddressed - kept === removed };
  }

  getPoolBlocksByIds(ids) { const want = new Set(ids); return this._membershipPool.filter(b => want.has(b.id)); }
  getPendingFacesByRoots(roots) { const want = new Set(roots); return this._pendingCubeFaces.filter(f => want.has(f.getMerkleRoot())); }

  // L1 sealSet: seal EXACTLY the quorum-agreed blocks (must be a full chunk of 9) into ONE face, persist the
  // blocks, remove them from the pool, and QUEUE the sealed face for L2 agreement (NOT auto-assign to a local
  // cube — that local pick is the L2 fork). Returns the sealed face, or null if the agreed set wasn't a full 9.
  // Idempotent: a re-seal of already-removed blocks produces no face (sealBlocksIntoFaces needs 9 present).
  // STAGE 3 OF CONSENSUS VALIDATION (operator, 2026-09-16): after "can it happen" (1) and "is the xid correct" (2),
  // the geometric placement. A face's positions must be the hash ranks of its nine — re-derived by
  // verifyPlacement from the blocks and compared with what the face assigned. A mismatch is a bug in the
  // sealing rule or a corrupted face and must never be persisted, so it throws.
  _assertPlacement(face, where) {
    const blocks = Array.from(face.blocks.entries()).map(([position, b]) => ({ hash: b.hash, id: b.id, position }));
    const r = verifyPlacement({ blocks });
    if (!r.ok) throw new Error(`[XCLT] ${where}: placement refused — ${r.reason}`);
    return r;
  }

  async sealAgreedBlocks(agreedBlocks) {
    const present = agreedBlocks.filter(b => this._membershipPool.some(p => p.id === b.id));
    const { faces } = sealBlocksIntoFaces(present);
    const face = faces[0];
    if (!face) return null;                              // < 9 present (already sealed / incomplete) → no-op
    this._assertPlacement(face, 'sealAgreedBlocks');     // STAGE 3: the geometric placement, re-derived and compared
    for (const [position, block] of face.blocks.entries()) {
      block.setLocation({ faceIndex: 0, position, cubeIndex: 0, cubeSequentialIndex: null, level: 1 });
    }
    if (this._dbOpen) {
      for (const block of face.blocks.values()) {
        try { await this.db.put(`block:${block.id}`, block.serialize()); } catch { /* in-memory fallback */ }
      }
    }
    const sealedIds = new Set(Array.from(face.blocks.values()).map(b => b.id));
    this._membershipPool = this._membershipPool.filter(b => !sealedIds.has(b.id));
    this._pendingCubeFaces.push(face);                   // hand to L2 agreement (never a local cube pick)
    await this._persistMembershipPool();                 // ORPHAN FIX: pool shrank — record it
    await this._persistPendingFaces();                   // ORPHAN FIX: the face must survive a restart before L2 agrees it
    this._emitBlocksAdded(face);                         // APPLY FIX: sealed => eligible for the state machine
    return face;
  }

  // ⛔ THE APPLY STEP HAD NO DOORBELL. This class documented `@emits block:added` at addTransaction (see the
  // JSDoc above it) and xvsm/src/state-machine.js subscribes to exactly that event to derive a state diff and
  // insert it into the Verkle tree — but NOTHING in this repository ever called emit('block:added'). Measured
  // on prod 2026-08-17: state_root 64 zeros, applied_tx_count 0, state_diffs 0, against 711 txs held, 5,594
  // blocks and 202 cubes persisted. Everything upstream of apply was live and moving; apply alone never ran,
  // because the event it waits on did not exist. Same bug class as the `state_diff`-only handler and the
  // never-rehydrated diffs: a fully implemented consumer that nothing could ever reach.
  //
  // WHY THIS FIRES ON SEAL AND NOT ON POOL. addTransaction only POOLS a block — under consensus-v2 it returns
  // having sealed nothing. Emitting there would apply UNVALIDATED candidates, and the state root would stop
  // being a cross-node commitment: two nodes with different pools would compute different roots from the same
  // finalized set, which is the one property the root exists to provide. A block is eligible for the state
  // machine at the moment the quorum agrees it, i.e. here and in _sealReadyFaces — nowhere earlier.
  //
  // Listeners are dispatched synchronously by EventEmitter but the xvsm handler is async, so a throw inside it
  // surfaces as an unhandled rejection rather than here; each emit is still guarded so one bad listener can
  // never take down a seal that has already been agreed and persisted.
  _emitBlocksAdded(face) {
    if (!face || !face.blocks) return 0;
    let n = 0;
    for (const block of face.blocks.values()) {
      // Higher-level faces hold Cubes, not Blocks — those carry no `tx` and are not state transitions.
      if (!block || typeof block !== 'object' || !('tx' in block)) continue;
      try { this.emit('block:added', block); n++; } catch { /* a listener must never break a sealed face */ }
    }
    return n;
  }

  // L2 sealSet: assemble a cube from EXACTLY the quorum-agreed 3 faces (face.getMerkleRoot() is the key). cube.id
  // is _calculateCubeId = sha256(sorted face merkle roots) = CONTENT — so identical agreed faces ⇒ identical
  // cube.id + merkleRoot + validatorAverageTimestamp (which averages the FACES' node-consistent timestamps) across
  // nodes. This REPLACES _finalizeFace's local "first cube with <3 faces" pick + its process.hrtime.bigint() cube
  // key (the L2 fork). We key the cubes map + persist by the CONTENT cube.id (not hrtime), and reuse the verified
  // _finalizeCube persist path (BigInt .toString). Returns the cube, or null if the agreed 3 weren't all present.
  // NOTE: cube.index / block cubeSequentialIndex are NODE-LOCAL coordinate metadata, consensus-IRRELEVANT — they
  // are NOT in the persisted cubeData (which is {id, merkleRoot, faces:[0,1,2] hash-sorted, validatorAvgTs, level})
  // and MUST NOT be folded into any consensus hash at a future level.
  async sealAgreedCube(agreedFaces) {
    const rootsInPool = new Set(this._pendingCubeFaces.map(f => f.getMerkleRoot()));
    const present = agreedFaces.filter(f => rootsInPool.has(f.getMerkleRoot())).slice(0, 3);
    if (present.length < 3) return null;                 // incomplete / already sealed → no-op
    const cube = new Cube();                             // constructor hrtime ts is inert (faces provide avg ts; keyed by content id below)
    for (const face of present) cube.addFace(face);      // at the 3rd, cube.id = _calculateCubeId() (content)
    const sealedRoots = new Set(present.map(f => f.getMerkleRoot()));
    this._pendingCubeFaces = this._pendingCubeFaces.filter(f => !sealedRoots.has(f.getMerkleRoot()));
    await this._persistPendingFaces();                   // ORPHAN FIX: sealed faces leave the pool durably
    cube.index = this.cubes.size;                        // node-local coordinate index (consensus-irrelevant; not persisted)
    this.cubes.set(cube.id, cube);                       // key by CONTENT id (not hrtime) — node-consistent
    await this._finalizeCube(cube, cube.id);             // content key; reuses the verified persist + higher-level recursion
    return cube;
  }

  /**
   * Seal every full group of 9 currently in the membership pool into faces
   * (deterministic hash-sort partition) and feed each through the cube pipeline.
   * Idempotent w.r.t. a remainder: a pool of < 9 seals nothing and stays pooled.
   * @private
   * @returns {Promise<{sealedFaces: number, pooled: number}>}
   */
  async _sealReadyFaces() {
    const { faces, leftover } = sealBlocksIntoFaces(this._membershipPool);
    this._membershipPool = leftover;

    for (const face of faces) {
      this._assertPlacement(face, '_sealReadyFaces');    // STAGE 3: the geometric placement, re-derived and compared
      // Establish an initial location for each sealed block so coordinates are
      // valid before finalize (mirrors addTransaction). Face index is temporary
      // (0) until the cube is finalized; positions are the hash-sorted 0-8 the
      // seal already assigned.
      for (const [position, block] of face.blocks.entries()) {
        block.setLocation({
          faceIndex: 0,
          position,
          cubeIndex: 0,
          cubeSequentialIndex: null,
          level: 1,
        });
      }
      // Persist each sealed block (parity with the incremental path).
      if (this._dbOpen) {
        for (const block of face.blocks.values()) {
          try { await this.db.put(`block:${block.id}`, block.serialize()); } catch { /* in-memory fallback */ }
        }
      }
      // Feed the sealed face into the existing cube-formation pipeline. Merkle
      // roots are pure functions of block membership + hash-sort, so the cube
      // this produces is byte-identical across nodes for the same set.
      await this._finalizeFace(face);
      this._emitBlocksAdded(face);   // APPLY FIX (legacy path) — see _emitBlocksAdded
    }

    return { sealedFaces: faces.length, pooled: this._membershipPool.length };
  }

  async _handleIncomingBlock(data) {
    // Handle incoming block from network
    if (data.blockId && data.block) {
      try {
        const block = Block.deserialize(data.block);
        // Check if block already exists
        const existing = await this.getBlock(block.id);
        if (!existing) {
          // Add block to ledger
          await this.addTransaction(block.tx);
        }
      } catch (error) {
        console.warn('Failed to handle incoming block:', error.message);
      }
    }
  }
  
  async _getCubeIndexForFace(faceIndex) {
    // Find which cube this face belongs to or will belong to
    // Find incomplete cube that could accept this face
    for (const [cubeTimestampKey, cube] of this.cubes.entries()) {
      if (cube.faces.size < 3) {
        return cubeTimestampKey; // Return timestamp key
      }
    }
    
    // If not in existing cube, return null (cube will be created when face is finalized)
    return null;
  }

  async _finalizeFace(face) {
    // Store face timestamp key for cleanup
    const faceTimestampKey = face.timestamp.toString();
    
    // If face.blocks already has 9 blocks (sorted by addBlock), use those
    // Otherwise, sort pendingBlocks and assign positions
    let sortedBlocks;
    if (face.blocks.size === 9 && face._sorted) {
      // Face was already sorted by addBlock, just get blocks in order
      sortedBlocks = Array.from({ length: 9 }, (_, i) => face.blocks.get(i));
    } else {
      // Sort blocks by hash and assign final positions (0-8)
      sortedBlocks = Array.from(face.pendingBlocks).sort((a, b) => {
        return a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0;
      });
      
      // Clear and rebuild face.blocks with sorted positions
      face.blocks.clear();
      for (let i = 0; i < sortedBlocks.length; i++) {
        const block = sortedBlocks[i];
        face.blocks.set(i, block); // Position 0-8
      }
      face._sorted = true;
      face.pendingBlocks = []; // Clear pending blocks
    }
    
    // Update all block locations with final sorted positions
    for (let i = 0; i < sortedBlocks.length; i++) {
      const block = sortedBlocks[i];
      if (block && block.location) {
        block.location.position = i;
        block.updateCoordinates(); // Recalculate coordinates with final position
      }
    }
    
    // Get validator average timestamp for this face (from xpc validation)
    // This determines placement - earliest timestamp gets priority
    const faceAvgTimestamp = face.getAverageTimestamp();
    
    // Find or create a cube to add this face to
    // Batches of 3 faces will form a cube - order determined by hash sorting
    let targetCube = null;
    let cubeTimestampKey = null;
    
    // ⛔ DETERMINISTIC CUBE ASSIGNMENT — replaces "earliest-timestamp cube with room".
    //
    // The old rule picked a target cube by arrival/timestamp order, so two nodes holding the IDENTICAL set of
    // faces assembled them into different cubes and produced different cube ids. Measured 2026-08-03 after a
    // full wipe + identical replay: prod and laptop both reached 5,145 blocks / 190 cubes with DIFFERENT
    // set_digests (b6dbe23d vs 2b84c9d7). Same input, different chain.
    //
    // The rule (deterministic-placement.js, operator-specified): a face's SLOT in its cube is its merkle root
    // mod 3, and among faces sharing a slot the k-th by root joins cube k. Both inputs are content hashes that
    // inherit the quorum-averaged validator timestamp, so every node computes the same answer with no
    // coordination. Collisions are the MECHANISM, not a fault — cubes fill in parallel.
    const faceRoot = face.getMerkleRoot();
    const slot = parseInt(faceRoot.slice(-8), 16) % 3;

    // k = how many faces already occupy this slot across all open cubes -> the cube this face belongs to.
    if (!this._slotFaces) this._slotFaces = [[], [], []];
    const k = this._slotFaces[slot].length;
    this._slotFaces[slot].push(faceRoot);

    // Cube k is keyed by ordinal, NOT by hrtime — an hrtime key is process-relative and differs per node.
    cubeTimestampKey = `cube#${k}`;
    targetCube = this.cubes.get(cubeTimestampKey) || null;
    if (!targetCube) {
      targetCube = new Cube(BigInt(k));
      targetCube.index = k;                      // sequential index = ordinal, identical on every node
      this.cubes.set(cubeTimestampKey, targetCube);
      await this._gossipCube(targetCube);
    }
    face.index = slot;                            // faceIndex IS the slot

    // Add face to cube (keyed by face timestamp)
    targetCube.addFace(face);
    
    // Update cube's validator average timestamp
    targetCube.validatorAverageTimestamp = targetCube.getAverageTimestamp();
    
    // Update all block locations with final cubeIndex and cube sequential index
    // Note: face.index is still 0 (temporary) until cube is finalized
    // Blocks will get final faceIndex when cube is finalized in _finalizeCube
    for (const [position, block] of face.blocks.entries()) {
      if (block.location) {
        block.location.cubeIndex = cubeTimestampKey;
        block.location.cubeSequentialIndex = targetCube.index; // Store sequential index for coordinate calculation
        // Keep temporary faceIndex for now - will be updated in _finalizeCube
        block.updateCoordinates(); // Recalculate with final cubeIndex
      }
    }
    
    // Clean up pending face (use timestamp key)
    this.pendingFaces.delete(faceTimestampKey);
    
    // Emit face complete event (faceIndex will be set when cube is finalized)
    this.emit('face:complete', { 
      face, 
      faceIndex: face.index, 
      validatorAverageTimestamp: faceAvgTimestamp,
      cubeId: cubeTimestampKey
    });
    console.log(`Face complete with ${face.blocks.size} blocks, validator avg timestamp: ${faceAvgTimestamp}`);
    
    // When cube has 3 faces, sort them by hash and finalize
    if (targetCube.faces.size === 3) {
      await this._finalizeCube(targetCube, cubeTimestampKey);
    }
  }

  async _finalizeCube(cube, cubeTimestampKey) {
    // Sort faces by hash and assign indices 0, 1, 2
    // Lowest hash = front face (0), highest hash = back face (2)
    const faces = Array.from(cube.faces.values());
    const sortedFaces = sortFacesByHash(faces);
    
    // Update face indices in cube
    cube.faces.clear();
    for (const [index, face] of sortedFaces.entries()) {
      face.index = index;
      cube.faces.set(face.timestamp.toString(), face);
    }
    
      // Update block locations with correct face indices and positions
      for (const face of cube.faces.values()) {
        for (const [position, block] of face.blocks.entries()) {
          if (block.location) {
            block.location.faceIndex = face.index;
            block.location.position = position;
            block.location.cubeIndex = cubeTimestampKey;
            block.location.cubeSequentialIndex = cube.index; // Update sequential index
            block.updateCoordinates();
          }
        }
      }
    
    // Mark cube as Level 1 (atomic cube)
    cube.level = 1;
    
    // Store cube state. getAverageTimestamp() returns a BigInt (nanosecond ts) — JSON.stringify THROWS on a
    // BigInt ("Do not know how to serialize a BigInt"), so the put below threw EVERY time, was swallowed by the
    // generic catch, and NO cube was ever persisted (cubes_persisted stayed 0 even as faces sealed + blocks
    // persisted, because block.serialize() is BigInt-safe but this JSON.stringify is not). _gossipCube already
    // .toString()s this exact value; do the same here. This is THE root cause of cubes_persisted=0.
    const cubeData = {
      id: cube.id,
      merkleRoot: cube.getMerkleRoot(),
      faces: Array.from(cube.faces.values()).map(f => f.index),
      validatorAverageTimestamp: cube.getAverageTimestamp()?.toString() ?? null,
      level: 1 // Level 1 atomic cubes
    };

    if (this._dbOpen) {
      try {
        await this.db.put(`cube:${cube.id}`, JSON.stringify(cubeData));
      } catch (error) {
        console.warn('Database not available for cube storage:', error?.message || error);
      }
    }

    // RE-PERSIST THE MEMBER BLOCKS. The loop above mutates block.location.{faceIndex,position,cubeIndex,
    // cubeSequentialIndex} + updateCoordinates() IN MEMORY ONLY — every block was already db.put at :241/:350/:410
    // BEFORE that mutation, so without this the stored record keeps its pre-cube placeholder location forever.
    // That is why membership is unreadable on disk today: cubeData.faces holds face INDICES [0,1,2] (never ids),
    // so the cube record cannot name its members, and the block side that COULD name them reads
    // cubeIndex=0 / cubeSequentialIndex=null / faceIndex=0 on all 2898 persisted blocks — one value each, zero
    // information. Re-putting here makes `block.location.cubeIndex === <cube id>` the membership join.
    // Persistence only: block.id/hash and the cube merkleRoot are content hashes that do NOT include location,
    // so this changes no consensus value — it only stops discarding one that was already computed.
    // ⚠ cubeSequentialIndex (= cube.index = this.cubes.size) and the coordinates derived from it are NODE-LOCAL.
    // Nodes holding different cube SETS assign different sequential indices to the same cube, so a cross-node
    // digest taken over block records WILL diverge on nodes that agree perfectly — the same trap set_digest set.
    // Join membership on location.cubeIndex (the content cube id under consensus-v2); never on the seq index.
    if (this._dbOpen) {
      for (const face of cube.faces.values()) {
        for (const block of face.blocks.values()) {
          // Higher-level faces hold Cubes, not Blocks (_checkRecursiveCubeFormation) — those have no serialize().
          if (typeof block?.serialize !== 'function') continue;
          try { await this.db.put(`block:${block.id}`, block.serialize()); } catch { /* in-memory fallback */ }
        }
      }
    }

    // Emit cube complete event with validator timestamp
    this.emit('cube:complete', { 
      cube, 
      cubeId: cubeTimestampKey, // Use timestamp key
      validatorAverageTimestamp: cube.getAverageTimestamp(),
      level: 1
    });
    console.log(`✓ Level 1 cube complete: ${cube.id} with ${cube.faces.size} faces, validator avg timestamp: ${cube.getAverageTimestamp()}`);
    // COMMIT THE VERKLE STATE ROOT INTO THE PERSISTED CUBE. The cube record is written above, BEFORE this
    // emit, and the XVSM handler that computes the state root runs synchronously ON the emit — so without
    // this re-put the root would be computed and thrown away, exactly as it was when _handleCubeComplete only
    // console.logged it. EventEmitter dispatches synchronously, so cube.stateRoot is set by the time we get
    // here. Re-persisting is cheap (one small key) and makes the state commitment part of the chain record
    // rather than a log line.
    if (this._dbOpen && cube.stateRoot) {
      try {
        await this.db.put(`cube:${cube.id}`, JSON.stringify({ ...cubeData, stateRoot: cube.stateRoot }));
      } catch (error) {
        console.warn('Failed to persist cube state root:', error?.message || error);
      }
    }

    
    // Check if we should form a higher-level cube (recursive - infinite growth)
    await this._checkRecursiveCubeFormation(cube);
  }

  /**
   * RECURSIVE CUBE FORMATION - Infinite growth
   * When 9 cubes complete at level N, they form 1 face at level N+1 (sorted by hash ONLY)
   * When 3 faces complete at level N+1, they form 1 cube at level N+1 (sorted by hash ONLY)
   * Timestamps are ONLY used at level 1 (atomic transactions)
   * For levels 2+, everything is sorted deterministically by hash
   * This continues infinitely - cubes never stop growing
   * @private
   */
  async _checkRecursiveCubeFormation(completedCube) {
    const level = completedCube.level || 1;
    
    // Initialize array for this level if needed
    if (!this.completedCubesByLevel.has(level)) {
      this.completedCubesByLevel.set(level, []);
    }
    
    const completedAtLevel = this.completedCubesByLevel.get(level);
    completedAtLevel.push(completedCube);
    
    console.log(`  → Level ${level}: ${completedAtLevel.length}/9 cubes completed (need 9 for face)`);
    
    // When we have 9 completed cubes at this level, form a face at level+1
    if (completedAtLevel.length >= 9) {
      console.log(`  → Forming Level ${level + 1} face from 9 Level ${level} cubes (hash-sorted)...`);
      await this._formNextLevelFace(level);
    }
  }

  /**
   * Form a face at level N+1 from 9 completed cubes at level N
   * Cubes are sorted by hash ONLY (lowest = position 0, highest = position 8)
   * NO timestamps used - purely deterministic hash-based sorting
   * This is RECURSIVE - when 3 faces complete, they form a cube
   * @private
   */
  async _formNextLevelFace(level) {
    const completedAtLevel = this.completedCubesByLevel.get(level);
    if (!completedAtLevel || completedAtLevel.length < 9) {
      return;
    }

    // For levels 2+, sort ONLY by hash (no timestamps)
    // Take the first 9 cubes and sort by hash for deterministic placement
    const cubesForFace = completedAtLevel.splice(0, 9);
    const nextLevel = level + 1;
    
    // Sort cubes by hash for deterministic placement (lowest = position 0, highest = position 8)
    const hashSortedCubes = cubesForFace.sort((a, b) => {
      const hashA = a.id || createHash('sha256').update(JSON.stringify(a)).digest('hex');
      const hashB = b.id || createHash('sha256').update(JSON.stringify(b)).digest('hex');
      return hashA.localeCompare(hashB);
    });
    
    // Create a face-like structure to hold the 9 cubes
    // Use a Face object but store cubes instead of blocks
    const faceTimestamp = process.hrtime.bigint();
    const higherLevelFace = {
      level: nextLevel,
      timestamp: faceTimestamp,
      index: 0, // Will be set when cube is formed
      cubes: new Map(), // position -> Cube
      getHash: function() {
        // Calculate hash from cube merkle roots sorted by position
        const cubeRoots = Array.from({ length: 9 }, (_, i) => {
          const cube = this.cubes.get(i);
          return cube ? (cube.getMerkleRoot ? cube.getMerkleRoot() : cube.id) : '0'.repeat(64);
        });
        // Calculate merkle root from cube roots
        return this._calculateMerkleRoot(cubeRoots);
      },
      getMerkleRoot: function() {
        return this.getHash();
      },
      _calculateMerkleRoot: function(hashes) {
        if (hashes.length === 1) return hashes[0];
        const nextLevel = [];
        for (let i = 0; i < hashes.length; i += 2) {
          const left = hashes[i];
          const right = hashes[i + 1] || left;
          const combined = createHash('sha256')
            .update(left + right)
            .digest('hex');
          nextLevel.push(combined);
        }
        return this._calculateMerkleRoot(nextLevel);
      },
    };
    
    // Assign cubes to positions 0-8 based on hash sort
    for (let i = 0; i < hashSortedCubes.length; i++) {
      higherLevelFace.cubes.set(i, hashSortedCubes[i]);
    }
    
    // Initialize pending faces map for this level if needed
    if (!this.pendingFacesByLevel.has(nextLevel)) {
      this.pendingFacesByLevel.set(nextLevel, new Map());
    }
    
    const pendingFacesAtLevel = this.pendingFacesByLevel.get(nextLevel);
    pendingFacesAtLevel.set(faceTimestamp.toString(), higherLevelFace);
    
    console.log(`✓ Level ${nextLevel} face complete with 9 Level ${level} cubes`);
    
    // Check if we have 3 faces at this level to form a cube
    await this._checkFaceFormation(nextLevel);
  }
  
  /**
   * Check if 3 faces are complete at a level and form a cube
   * Faces are sorted by hash ONLY (lowest = front face 0, highest = back face 2)
   * NO timestamps used - purely deterministic hash-based sorting
   * @private
   */
  async _checkFaceFormation(level) {
    const pendingFacesAtLevel = this.pendingFacesByLevel.get(level);
    if (!pendingFacesAtLevel || pendingFacesAtLevel.size < 3) {
      return;
    }
    
    // For levels 2+, sort ONLY by hash (no timestamps)
    // Get 3 faces and sort by hash for deterministic placement
    const faces = Array.from(pendingFacesAtLevel.values()).slice(0, 3);
    
    // Remove these faces from pending
    for (const face of faces) {
      pendingFacesAtLevel.delete(face.timestamp.toString());
    }
    
    // Sort faces by hash (lowest = front face 0, highest = back face 2)
    const sortedFaces = sortFacesByHash(faces);
    
    // Create cube at this level
    await this._formCubeFromFaces(level, sortedFaces);
  }
  
  /**
   * Form a cube from 3 faces at a given level
   * @private
   */
  async _formCubeFromFaces(level, sortedFaces) {
    const cubeTimestamp = process.hrtime.bigint();
    const cube = new SuperCube(level);
    cube.timestamp = cubeTimestamp;
    
    // Add faces to cube (faces already have indices 0, 1, 2 from sorting)
    for (const [faceIndex, face] of sortedFaces.entries()) {
      face.index = faceIndex;
      // Store face in cube (using a faces map similar to Level 1 cubes)
      if (!cube.faces) {
        cube.faces = new Map();
      }
      cube.faces.set(face.timestamp.toString(), face);
    }

    // Populate childCubes: each of the 3 faces holds 9 lower-level cubes (in its
    // `cubes` map), so the three faces together are the 27 children of this
    // super-cube. The face-based formation above filled `faces` but left
    // `childCubes` empty. Set it directly rather than via addChildCube, whose
    // size===27 path would re-run the legacy _formFacesFromCubes.
    let childIndex = 0;
    for (const face of sortedFaces.values()) {
      if (face.cubes) {
        for (const childCube of face.cubes.values()) {
          cube.childCubes.set(childIndex++, childCube);
        }
      }
    }
    
    // Calculate cube ID from face hashes
    const faceRoots = Array.from(sortedFaces.values())
      .map(face => face.getMerkleRoot())
      .join('');
    cube.id = createHash('sha256').update(faceRoots).digest('hex').substring(0, 16);
    
    // For levels 2+, no timestamps - everything is hash-based
    cube.validatorAverageTimestamp = null;
    
    // Initialize super-cubes map for this level if needed
    if (!this.superCubes.has(level)) {
      this.superCubes.set(level, new Map());
    }
    
    const cubesAtLevel = this.superCubes.get(level);
    cubesAtLevel.set(cubeTimestamp.toString(), cube);
    
    console.log(`✓ Level ${level} cube complete with 3 faces (hash-sorted)`);
    
    // Emit event for cube completion
    this.emit('supercube:complete', { 
      level: level, 
      cube: cube
    });
    
    // RECURSIVE: When this cube completes, check if we should form level N+1 faces
    // This continues infinitely - cubes never stop growing
    await this._checkRecursiveCubeFormation(cube);
    
    // Also check if we can form more faces at this level (in case we have more pending faces)
    await this._checkFaceFormation(level);
  }

  /**
   * Get position of a cube in the next level using the SAME placement logic
   * This is dimension-agnostic - works at all levels
   * Uses the cube ID (hash) to determine placement, just like blocks
   * @private
   */
  _getCubePositionInNextLevel(cubeId, index) {
    // For recursive cube formation, cubes are sorted by hash
    // Position is determined by sorted order (0-26)
    // This maintains the recursive fractal structure
    return index;
  }

  async getBlock(blockId) {
    if (this._dbOpen) {
      try {
        const data = await this.db.get(`block:${blockId}`);
        return Block.deserialize(data);
      } catch (error) {
        // Check in-memory cache
      }
    }
    return this.blocks.get(blockId) || null;
  }
  
  async getBlockCoordinates(blockId) {
    const block = await this.getBlock(blockId);
    if (!block) return null;
    
    return {
      coordinates: block.getCoordinates(),
      vector: block.getVector(),
      fractalAddress: block.getFractalAddress()
    };
  }

  async getCubes() {
    // Return cubes sorted by average timestamp of their blocks
    const cubes = Array.from(this.cubes.values());
    return cubes.sort((a, b) => {
      const avgA = this._getCubeAverageTimestamp(a);
      const avgB = this._getCubeAverageTimestamp(b);
      return avgA - avgB;
    });
  }
  
  _getCubeAverageTimestamp(cube) {
    const allTimestamps = [];
    for (const face of cube.faces.values()) {
      for (const block of face.blocks.values()) {
        allTimestamps.push(block.timestamp);
      }
    }
    if (allTimestamps.length === 0) return 0;
    return allTimestamps.reduce((sum, ts) => sum + ts, 0) / allTimestamps.length;
  }

  async getStateRoot() {
    const cubeRoots = Array.from(this.cubes.values())
      .map(cube => cube.getMerkleRoot())
      .filter(root => root !== null)
      .sort();
    
    if (cubeRoots.length === 0) {
      return '0'.repeat(64);
    }
    
    return this._calculateMerkleRoot(cubeRoots);
  }

  _calculateMerkleRoot(hashes) {
    if (hashes.length === 1) return hashes[0];
    const nextLevel = [];
    for (let i = 0; i < hashes.length; i += 2) {
      const left = hashes[i];
      const right = hashes[i + 1] || left;
      const combined = createHash('sha256')
        .update(left + right)
        .digest('hex');
      nextLevel.push(combined);
    }
    return this._calculateMerkleRoot(nextLevel);
  }

  /**
   * Gossip face creation with timestamp so all validators see deterministic placement
   * Faces are keyed by nanosecond timestamps and gossiped for consensus
   */
  async _gossipFace(face) {
    if (!this.xn || !this.xn.started) return;
    
    try {
      // Only level 1 faces have timestamps
      const avgTs = face.getAverageTimestamp ? face.getAverageTimestamp() : null;
      const faceData = {
        index: face.index,
        timestamp: face.timestamp.toString(), // Nanosecond timestamp as string
        blockCount: face.blocks ? face.blocks.size : (face.cubes ? face.cubes.size : 0),
        averageTimestamp: avgTs ? avgTs.toString() : null,
        blocks: face.blocks ? Array.from(face.blocks.entries()).map(([pos, block]) => ({
          position: pos,
          blockId: block.id,
          timestamp: typeof block.timestamp === 'bigint' ? block.timestamp.toString() : block.timestamp
        })) : []
      };
      
      await this.xn.publish(this.faceTopic, {
        type: 'face:created',
        face: faceData
      });
    } catch (error) {
      // Gossip failure shouldn't block ledger operations
      console.warn('Failed to gossip face:', error.message);
    }
  }

  /**
   * Gossip cube creation with timestamp so all validators see deterministic placement
   * Cubes are keyed by nanosecond timestamps and gossiped for consensus
   */
  async _gossipCube(cube) {
    if (!this.xn || !this.xn.started) return;
    
    try {
      // Only level 1 cubes have timestamps
      const avgTs = cube.getAverageTimestamp ? cube.getAverageTimestamp() : null;
      const cubeData = {
        timestamp: cube.timestamp.toString(), // Nanosecond timestamp as string
        level: cube.level || 1,
        faceCount: cube.faces ? cube.faces.size : 0,
        averageTimestamp: avgTs ? avgTs.toString() : null,
        faces: cube.faces ? Array.from(cube.faces.entries()).map(([ts, face]) => ({
          timestamp: ts,
          index: face.index,
          blockCount: face.blocks ? face.blocks.size : (face.cubes ? face.cubes.size : 0)
        })) : []
      };
      
      await this.xn.publish(this.cubeTopic, {
        type: 'cube:created',
        cube: cubeData
      });
    } catch (error) {
      // Gossip failure shouldn't block ledger operations
      console.warn('Failed to gossip cube:', error.message);
    }
  }

  /**
   * Handle incoming face gossip - update local state if face is earlier (deterministic placement)
   */
  async _handleIncomingFace(data) {
    if (!data.face) return;
    
    const faceTimestamp = BigInt(data.face.timestamp);
    const existingFace = this.pendingFaces.get(faceTimestamp.toString());
    
    // If we don't have this face, or incoming face is earlier, update our state
    if (!existingFace || faceTimestamp < existingFace.timestamp) {
      // Create face from gossip data
      const face = new Face(data.face.index, faceTimestamp);
      // Note: We'd need to reconstruct blocks from blockIds, but for now just track the face
      this.pendingFaces.set(faceTimestamp.toString(), face);
    }
  }

  /**
   * Handle incoming cube gossip - update local state if cube is earlier (deterministic placement)
   */
  async _handleIncomingCube(data) {
    if (!data.cube) return;
    
    const cubeTimestamp = BigInt(data.cube.timestamp);
    const existingCube = this.cubes.get(cubeTimestamp.toString());
    
    // If we don't have this cube, or incoming cube is earlier, update our state
    if (!existingCube || cubeTimestamp < existingCube.timestamp) {
      // Create cube from gossip data
      const cube = new Cube(cubeTimestamp);
      cube.level = data.cube.level || 1;
      // Note: We'd need to reconstruct faces from face data, but for now just track the cube
      this.cubes.set(cubeTimestamp.toString(), cube);
    }
  }
}

