// CUBE SYNC MANAGER — wires the pure verify/adopt logic in cube-sync.js to the live pubsub mesh.
//
// Protocol (3 floodsub topics, request/response, no new transport):
//   sync:digest  broadcast {nodeId, count, digest}          — cheap heartbeat; equal digest short-circuits
//   sync:list    {req:nodeId} / {nodeId, cubes:[{id,root}]} — ~90B per cube
//   sync:cube    {req:nodeId, id} / {nodeId, id, faces:[…]} — 27 blocks
//
// No addresses anywhere: peers are discovered by the existing mesh, and a response is trusted only because it
// recomputes to the id that was asked for (see cube-sync.js).
import { verifyCube, planAdoption, diffWanted, setDigest, TOPIC_DIGEST, TOPIC_LIST, TOPIC_CUBE } from './cube-sync.js';

export class CubeSyncManager {
  constructor(opts = {}) {
    this.xn = opts.xn || null;
    this.ledger = opts.ledger || null;
    this.nodeId = opts.nodeId || 'unknown';
    this.intervalMs = Number(process.env.XCS_SYNC_DIGEST_MS) || 30000;
    this.maxInFlight = Number(process.env.XCS_SYNC_MAX_INFLIGHT) || 4;
    this.enabled = process.env.XCS_SYNC !== '0';
    this.stats = { advertised: 0, listsServed: 0, cubesServed: 0, cubesFetched: 0, adopted: 0, rejected: 0 };
    // ⛔ _pending MUST expire. A request for a cube no peer can SERVE (its holder cannot name the members —
    // prod matched 0/20 in backfill) never gets a response, so without a TTL the in-flight slots fill with
    // unservable ids and the node stops asking for anything else. Convergence stalled at laptop 18 / agentic
    // 20 / prod 38 for exactly this reason.
    this._pending = new Map();                    // id -> requestedAt
    this._unservable = new Map();                 // id -> attempts, deprioritised so the diff can rotate
    this.pendingTtlMs = Number(process.env.XCS_SYNC_PENDING_TTL_MS) || 90000;
    this.maxAttempts = Number(process.env.XCS_SYNC_MAX_ATTEMPTS) || 3;
    this._timer = null;
  }

  async start() {
    if (!this.enabled || !this.xn || !this.ledger) return false;
    for (const t of [TOPIC_DIGEST, TOPIC_LIST, TOPIC_CUBE]) {
      try { await this.xn.subscribe(t); } catch { /* mesh not ready; the timer retries */ }
    }
    this.xn.on(`message:${TOPIC_DIGEST}`, (m) => this._onDigest(m).catch(() => {}));
    this.xn.on(`message:${TOPIC_LIST}`, (m) => this._onList(m).catch(() => {}));
    this.xn.on(`message:${TOPIC_CUBE}`, (m) => this._onCube(m).catch(() => {}));
    this._timer = setInterval(() => this.advertise().catch(() => {}), this.intervalMs);
    if (this._timer.unref) this._timer.unref();
    await this.advertise().catch(() => {});
    console.log(`[XCS-SYNC] started — advertising every ${this.intervalMs}ms, max ${this.maxInFlight} cubes in flight`);
    return true;
  }

  stop() { if (this._timer) clearInterval(this._timer); this._timer = null; }

  // ---- local cube inventory -------------------------------------------------------------------------------
  async localCubes() {
    const out = [];
    if (!this.ledger?.db) return out;
    try {
      for await (const [, v] of this.ledger.db.iterator({ gte: 'cube:', lt: 'cube;' })) {
        try { const c = JSON.parse(v); if (c?.id && c?.merkleRoot) out.push({ id: c.id, merkleRoot: c.merkleRoot }); } catch { /* skip */ }
      }
    } catch { /* db closed */ }
    return out.sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  // Reconstruct a cube's payload from persisted blocks. Membership is the join
  // `block.location.cubeIndex === cubeId` — which only exists on records written after the re-persist fix, or
  // backfilled by membership-backfill.mjs. A cube whose members cannot be named simply is not served.
  async buildPayload(cubeId) {
    if (!this.ledger?.db) return null;
    const byFace = new Map();
    try {
      for await (const [, v] of this.ledger.db.iterator({ gte: 'block:', lt: 'block;' })) {
        let b; try { b = JSON.parse(v); } catch { continue; }
        if (b?.location?.cubeIndex !== cubeId) continue;
        const fi = b.location.faceIndex;
        if (!byFace.has(fi)) byFace.set(fi, []);
        byFace.get(fi).push({ hash: b.hash, tx: b.tx });
      }
    } catch { return null; }
    if (byFace.size !== 3) return null;
    const faces = [];
    for (const fi of [...byFace.keys()].sort()) {
      const blocks = byFace.get(fi);
      if (blocks.length !== 9) return null;
      faces.push({ blocks });
    }
    return { faces };
  }

  // Free slots held by requests that were never answered, and remember which ids keep failing so diffWanted
  // can rotate past them instead of asking for the same lowest-sorted 4 forever.
  _expirePending() {
    const now = Date.now();
    for (const [id, at] of this._pending) {
      if (now - at < this.pendingTtlMs) continue;
      this._pending.delete(id);
      const n = (this._unservable.get(id) || 0) + 1;
      this._unservable.set(id, n);
      if (n === this.maxAttempts) console.warn(`[XCS-SYNC] ${id} unanswered after ${n} attempts — deprioritising`);
    }
  }

  async advertise() {
    this._expirePending();
    const cubes = await this.localCubes();
    this.stats.advertised++;
    await this._pub(TOPIC_DIGEST, { nodeId: this.nodeId, count: cubes.length, digest: setDigest(cubes) });
  }

  // ---- handlers -------------------------------------------------------------------------------------------
  async _onDigest(m) {
    if (!m || m.nodeId === this.nodeId) return;
    const mine = await this.localCubes();
    if (setDigest(mine) === m.digest) return;              // identical sets — nothing to do
    await this._pub(TOPIC_LIST, { req: this.nodeId, to: m.nodeId });
  }

  async _onList(m) {
    if (!m || m.nodeId === this.nodeId) return;
    if (m.req && m.req !== this.nodeId) {                   // someone is asking — serve our list
      this.stats.listsServed++;
      await this._pub(TOPIC_LIST, { nodeId: this.nodeId, cubes: await this.localCubes() });
      return;
    }
    if (!Array.isArray(m.cubes)) return;
    this._expirePending();
    const mine = new Set((await this.localCubes()).map(c => c.id));
    // Ask for never-tried ids first; only fall back to repeatedly-unanswered ones once nothing fresh is left,
    // and drop them entirely past maxAttempts so a permanently unservable cube cannot wedge the loop.
    const missing = (m.cubes || []).filter(c => c && typeof c.id === 'string' && !mine.has(c.id));
    const fresh = missing.filter(c => !this._unservable.has(c.id));
    const retry = missing.filter(c => (this._unservable.get(c.id) || 0) < this.maxAttempts);
    const pool = fresh.length ? fresh : retry;
    const slots = Math.max(0, this.maxInFlight - this._pending.size);
    for (const id of diffWanted(mine, pool, slots)) {
      if (this._pending.has(id)) continue;
      this._pending.set(id, Date.now());
      await this._pub(TOPIC_CUBE, { req: this.nodeId, id });
    }
  }

  async _onCube(m) {
    if (!m || m.nodeId === this.nodeId) return;
    if (m.req && m.req !== this.nodeId && m.id) {           // serve it if we can name its members
      const payload = await this.buildPayload(m.id);
      if (!payload) return;
      this.stats.cubesServed++;
      await this._pub(TOPIC_CUBE, { nodeId: this.nodeId, id: m.id, faces: payload.faces });
      return;
    }
    if (!m.id || !Array.isArray(m.faces)) return;
    this._pending.delete(m.id);
    this.stats.cubesFetched++;
    const v = verifyCube(m, m.id);
    if (!v.ok) { this.stats.rejected++; console.warn(`[XCS-SYNC] REJECT ${m.id}: ${v.reason}`); return; }
    await this.adopt(v, m);
  }

  // ADOPT — append-only, content-keyed, and deliberately does NOT touch the recursion counter or the mempool.
  async adopt(verified, payload) {
    const have = new Set((await this.localCubes()).map(c => c.id));
    const plan = planAdoption(verified, payload, {
      haveCubeIds: have,
      membershipPool: this.ledger.getMembershipPool ? this.ledger.getMembershipPool() : [],
      nextSeq: have.size,
    });
    if (plan.skip) return false;
    try {
      await this.ledger.db.put(`cube:${plan.cubeRecord.id}`, JSON.stringify(plan.cubeRecord));
      for (const b of plan.blocks) {
        await this.ledger.db.put(`block:${b.hash.slice(0, 16)}`, JSON.stringify({
          id: b.hash.slice(0, 16), hash: b.hash, tx: b.tx, location: b.location, level: 1, adopted: true,
        }));
      }
      // rule 3 — a member still sitting unsealed locally must leave the pool, or it seals into a second cube
      if (plan.evictFromPool.length && Array.isArray(this.ledger._membershipPool)) {
        const drop = new Set(plan.evictFromPool);
        this.ledger._membershipPool = this.ledger._membershipPool.filter(b => !drop.has(b?.hash));
      }
      this.stats.adopted++;
      console.log(`[XCS-SYNC] ADOPTED cube ${plan.cubeRecord.id} (${plan.blocks.length} blocks, ${plan.evictFromPool.length} evicted from pool)`);
      return true;
    } catch (e) {
      console.warn(`[XCS-SYNC] adopt failed for ${verified.id}: ${e.message}`);
      return false;
    }
  }

  async _pub(topic, msg) {
    if (!this.xn?.started) return;
    try { await this.xn.publish(topic, msg); } catch { /* transient */ }
  }
}
