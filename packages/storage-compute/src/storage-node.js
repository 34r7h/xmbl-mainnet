import { createHash } from 'crypto';
import { Level } from 'level';

/**
 * Availability-probe proof: sha256(nonce || shard bytes). The prober picks a
 * fresh nonce per probe, so a responder cannot pre-compute or replay proofs —
 * it must hold the actual shard bytes at probe time. Both sides (responder
 * here, verifier wherever the shard was sourced from) use this same function.
 */
export function computeProbeProof(nonce, data) {
  const hash = createHash('sha256');
  hash.update(String(nonce));
  hash.update(data);
  return hash.digest('hex');
}

export class StorageNode {
  constructor(options = {}) {
    this.capacity = options.capacity || 1000000; // 1MB default
    this.used = 0;
    this.dbPath = options.dbPath || './data/storage';
    this.db = null; // Will be initialized async
    // DURABILITY IS A THREE-STATE, AND null IS THE POINT. `true`/`false` are only meaningful once _init
    // has settled; before that the answer is NOT KNOWN, and it must not read as healthy. `this.db` cannot
    // carry this — `new Level(...)` is assigned SYNCHRONOUSLY and only replaced in the catch AFTER the
    // await, so a caller that inspected `db` straight after `new` saw a Level handle on a node that was
    // about to fail. Await ready() (or any async method) before trusting this field.
    this.durable = null;
    this.initError = null;
    // Opt-in to a node that keeps shards in memory only. Nothing implicit sets this: an in-memory node is
    // something a caller ASKS for, never something it is quietly given (see _init).
    this.volatile = options.volatile === true;
    this.shards = new Map(); // shardId -> Shard metadata
    this.shardsStored = 0; // cumulative count of shards persisted (metrics: shards_stored)
    this._initPromise = this._init();

    // Integration: xn for P2P networking
    this.xn = options.xn || null;
    this.requestTopic = options.requestTopic || 'storage:shard_request';
    this.responseTopic = options.responseTopic || 'storage:shard_response';
    this.probeRequestTopic = options.probeRequestTopic || 'storage:probe_request';
    this.probeResponseTopic = options.probeResponseTopic || 'storage:probe_response';
    
    // Integration: xpc for payment consensus
    this.xpc = options.xpc || null;
    
    // Integration: xclt for payment recording
    this.xclt = options.xclt || null;
    
    // Subscribe to topics if network available and started
    if (this.xn && this.xn.started) {
      this.xn.subscribe(this.requestTopic).catch(() => {});
      this.xn.subscribe(this.responseTopic).catch(() => {});
      
      this.xn.on(`message:${this.requestTopic}`, (data) => {
        this._handleShardRequest(data);
      });
      
      this.xn.on(`message:${this.responseTopic}`, (data) => {
        this._handleShardResponse(data);
      });

      this.xn.subscribe(this.probeRequestTopic).catch(() => {});
      this.xn.on(`message:${this.probeRequestTopic}`, (data) => {
        this._handleProbeRequest(data);
      });
    }
  }

  async _handleProbeRequest(data) {
    if (!data || !data.shardId) return;
    const response = await this.respondToProbe(data);
    if (this.xn && this.xn.started) {
      try {
        await this.xn.publish(this.probeResponseTopic, response);
      } catch (error) {
        // Silently handle network errors
      }
    }
  }

  /**
   * Answer an availability probe: prove this node holds the shard's bytes.
   * @param {{shardId: string, nonce?: string|number, probeId?: string}} probe
   * @returns {Promise<{shardId: string, held: boolean, proof?: string, probeId?: string}>}
   *   held:true with proof = computeProbeProof(nonce, data) when the shard is
   *   held; held:false (no proof) when it is absent.
   */
  async respondToProbe(probe) {
    const { shardId, nonce = '', probeId } = probe;
    try {
      const shard = await this.getShard(shardId);
      return { shardId, probeId, held: true, proof: computeProbeProof(nonce, shard.data) };
    } catch (error) {
      return { shardId, probeId, held: false };
    }
  }
  
  async _handleShardRequest(data) {
    // Handle incoming shard request
    if (data.shardId) {
      try {
        const shard = await this.getShard(data.shardId);
        if (this.xn && this.xn.started) {
          try {
            await this.xn.publish(this.responseTopic, {
              shardId: shard.shardId,
              shard: {
                index: shard.index,
                data: shard.data.toString('base64')
              }
            });
          } catch (error) {
            // Silently handle network errors
          }
        }
      } catch (error) {
        // Shard not found, ignore
      }
    }
  }
  
  _handleShardResponse(data) {
    // Handle incoming shard response
    // Can be used for shard retrieval
  }

  // ⛔ A FAILED OPEN USED TO BE SILENT, AND THAT SILENCE WAS A DATA-LOSS TRAP.
  //
  // This catch block used to read, in its entirety: `this.db = new Map()` under the comment "If LevelDB
  // fails, use in-memory storage". No throw, no flag, no log. The node then behaved EXACTLY like a healthy
  // one — storeShard returned a shard id, getShard read the bytes back, getUsed() counted them — and every
  // byte died at the next restart with nothing having said so. A caller could not detect it either: a
  // write-then-read canary PASSES in this state, because the Map serves the read it just took.
  //
  // It is reached by an ordinary operational accident, not an exotic one. LevelDB takes an EXCLUSIVE LOCK
  // on its directory, so a second node on the same dbPath — two processes from one working directory, or a
  // deploy whose restart overlaps the outgoing process — degrades one of them to RAM. Both production
  // callers (packages/core/index.js, packages/desktop-app) pass `config.storage?.dbPath`, which is
  // routinely undefined and collapses to the shared default './data/storage'.
  //
  // AND IT MADE THE NODE LIE TO THE AVAILABILITY PROTOCOL. respondToProbe answers `held: true` with a
  // valid fresh-nonce proof for bytes that exist only in this process's memory. The proof is sound — the
  // bytes are there right now — so the mesh correctly concludes the shard is held, and is wrong about the
  // only thing it asked, which is whether the shard is STORED. A storage market cannot price custody it
  // cannot distinguish from a cache.
  //
  // So: the in-memory path still exists, because a volatile node is a legitimate thing to want, but it is
  // now something a caller ASKS FOR (`{ volatile: true }`) rather than something it is handed after a
  // failure it was never told about. Undeclared, a non-durable node refuses to store (see storeShard).
  async _init() {
    try {
      this.db = new Level(this.dbPath, { valueEncoding: 'buffer' });
      await this.db.open();
      // Reload persisted shard metadata so held shards (and the quota
      // accounting they consume) survive a restart.
      for await (const [key, value] of this.db.iterator({ gte: 'meta:', lt: 'meta:\xff' })) {
        try {
          const meta = JSON.parse(value.toString());
          this.shards.set(meta.shardId, meta);
          this.used += meta.size;
        } catch {
          // Skip unreadable metadata rather than fail the whole store.
        }
      }
      this.durable = true;
    } catch (error) {
      this.durable = false;
      this.initError = error;
      this.db = new Map();   // the node still FUNCTIONS; what it must never do is pass for durable
      const why = `${this.dbPath}: ${error?.message || error}`;
      if (this.volatile) console.warn(`[xsc] storage is in-memory by request (volatile) — ${why}`);
      else console.error(`[xsc] STORAGE IS NOT DURABLE — ${why}. Shards will NOT survive a restart and storeShard will refuse. A second node on the same dbPath is the usual cause (LevelDB holds an exclusive lock). Pass { volatile: true } to accept in-memory storage deliberately.`);
    }
  }

  async _ensureInit() {
    await this._initPromise;
  }

  /**
   * Await initialisation and report what this node actually is. The ONE call a caller needs before it
   * trusts the rung: `durable` is authoritative here and nowhere earlier, because _init settles async.
   * Returns { durable, volatile, dbPath, error, used, capacity, shards }.
   */
  async ready() {
    await this._ensureInit();
    return {
      durable: this.durable === true,
      volatile: this.volatile,
      dbPath: this.dbPath,
      error: this.initError ? (this.initError.message || String(this.initError)) : null,
      used: this.used,
      capacity: this.capacity,
      shards: this.shards.size,
    };
  }

  async storeShard(shard, paymentTx = null) {
    await this._ensureInit();

    // "Stored" has to mean stored. Accepting bytes into a store that cannot keep them — and returning a
    // shard id that says it did — is the failure this guard exists to make impossible; a caller that
    // genuinely wants a memory-only node declares it and is let through.
    if (this.durable !== true && !this.volatile) {
      throw new Error(`Storage not durable (${this.dbPath}${this.initError ? `: ${this.initError.message || this.initError}` : ''}) — refusing to store bytes that will not survive a restart. Pass { volatile: true } to accept in-memory storage deliberately.`);
    }
    
    // Integration: Verify payment if xpc available
    if (this.xpc && paymentTx) {
      // Check if payment is finalized in consensus
      const stats = this.xpc.getMempoolStats();
      // In real system, would verify payment amount and finalization
    }
    
    if (this.used + shard.data.length > this.capacity) {
      throw new Error('Storage full');
    }
    
    const shardId = this._hashShard(shard);
    
    // Metadata is persisted alongside the bytes so the shard set (and its
    // quota accounting) can be rebuilt on restart. `data` stays out of the
    // metadata record — it lives under the shard: key.
    const { data: _data, ...rest } = shard;
    const meta = { ...rest, shardId, size: shard.data.length };
    if (this.db instanceof Map) {
      this.db.set(`shard:${shardId}`, shard.data);
    } else {
      await this.db.put(`shard:${shardId}`, shard.data);
      await this.db.put(`meta:${shardId}`, Buffer.from(JSON.stringify(meta)));
    }

    this.shards.set(shardId, meta);
    this.used += shard.data.length;
    this.shardsStored += 1;
    
    // Integration: Record payment in ledger if xclt available
    if (this.xclt && paymentTx) {
      try {
        await this.xclt.addTransaction(paymentTx);
      } catch (error) {
        console.warn('Failed to record payment in ledger:', error.message);
      }
    }
    
    return shardId;
  }

  async getShard(shardId) {
    await this._ensureInit();
    
    const shard = this.shards.get(shardId);
    if (!shard) {
      throw new Error('Shard not found');
    }
    
    let data;
    if (this.db instanceof Map) {
      data = this.db.get(`shard:${shardId}`);
    } else {
      data = await this.db.get(`shard:${shardId}`);
    }
    
    if (!data) {
      throw new Error('Shard data not found');
    }
    
    return { ...shard, data };
  }

  async deleteShard(shardId) {
    await this._ensureInit();
    
    const shard = this.shards.get(shardId);
    if (shard) {
      if (this.db instanceof Map) {
        this.db.delete(`shard:${shardId}`);
      } else {
        await this.db.del(`shard:${shardId}`);
        await this.db.del(`meta:${shardId}`);
      }
      this.used -= shard.size;
      this.shards.delete(shardId);
    }
  }

  getCapacity() {
    return this.capacity;
  }

  getUsed() {
    return this.used;
  }

  _hashShard(shard) {
    const hash = createHash('sha256');
    hash.update(shard.index.toString());
    hash.update(shard.data);
    return hash.digest('hex');
  }
}

