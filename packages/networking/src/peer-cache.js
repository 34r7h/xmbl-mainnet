// ⛔ A NODE THAT FORGETS EVERY PEER ON RESTART HAS ONE POINT OF FAILURE: ITS SEED LIST.
//
// Until 0.1.21 a node kept no record of whom it had met. Every boot started from `bootstrap_peers` and nothing
// else, so the mesh's resilience was exactly the resilience of that list — and the installer shipped ONE entry.
// MEASURED 2026-10-01: the one published seed (173.255.233.69:4001) went down after its node hit a heap OOM 12
// times on 2026-09-29 and its supervisor gave up; a fresh public node in ap-southeast-2 booted with 0 peers; and
// the broker's deploy gate rolled a release back on "every published seed answers". The DHT could not help: it
// finds peers by asking peers, and a node that has none has nobody to ask.
//
// So a node now remembers the peers it actually connected to, in its own data_dir, and dials them on boot
// alongside whatever seeds are configured. Once a node has joined the mesh ONCE, no single seed — and no broker —
// is load-bearing for it again.
//
// Scope, said plainly: listen addresses come from identify, which is SELF-REPORTED by the peer. This file bounds
// the damage (a capped size, ranking by last successful connection, eviction after repeated failures) but it is
// not a defence against routing-table poisoning — that remains the open ⛔ networking audit gate.
import fs from 'node:fs';
import path from 'node:path';
import { isPublicMultiaddr } from './addr.js';

const P2P_SUFFIX = /\/p2p\/[^/]+$/;

export class PeerCache {
  /**
   * @param {string} file  where the cache lives (the node's data_dir/known-peers.json)
   * @param {{ max?: number, maxFailures?: number, maxAddrs?: number, allowPrivate?: boolean, now?: () => number }} [opts]
   */
  constructor(file, opts = {}) {
    this.file = file;
    this.max = opts.max || 64;
    // 40 failed rounds is ~10 min at the 15 s rejoin cadence — the same budget the seed loop gives a seed — so a peer
    // that is briefly down survives, and one that is gone stops costing a dial. A peer that comes back is re-learned.
    this.maxFailures = opts.maxFailures || 40;
    this.maxAddrs = opts.maxAddrs || 4;
    // Private and loopback addresses are useless to a peer on another network, so they are dropped by default.
    // Tests on 127.0.0.1 turn this on; production never does.
    this.allowPrivate = !!opts.allowPrivate;
    this.now = opts.now || Date.now;
    /** @type {Map<string, { addrs: string[], last_connected: number, failures: number }>} */
    this.peers = new Map();
    this._saveTimer = null;
    this.load();
  }

  _usable(addr) {
    if (typeof addr !== 'string' || !addr.startsWith('/')) return false;
    if (addr.includes('/p2p-circuit')) return false;   // a relay address names the relay, which may be gone
    return this.allowPrivate || isPublicMultiaddr(addr);
  }

  _read(file) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || !Array.isArray(raw.peers)) throw new Error('not a peer cache');
    return raw.peers;
  }

  // A node that dies mid-write (these nodes have died by OOM) must not boot with an empty memory. The previous
  // good file is kept beside the current one, and a cache that will not parse falls back to it — never to empty.
  load() {
    let entries = [];
    for (const f of [this.file, `${this.file}.prev`]) {
      try { entries = this._read(f); break; } catch { /* missing or torn — try the previous good copy */ }
    }
    for (const e of entries) {
      if (!e || typeof e.id !== 'string' || !Array.isArray(e.addrs)) continue;
      const addrs = e.addrs.filter((a) => this._usable(a)).slice(0, this.maxAddrs);
      if (!addrs.length) continue;
      this.peers.set(e.id, { addrs, last_connected: Number(e.last_connected) || 0, failures: Number(e.failures) || 0 });
    }
    return this.peers.size;
  }

  /** A peer we hold a live connection to, at these addresses. Resets its failure count. */
  record(peerId, addrs) {
    if (!peerId) return false;
    const id = String(peerId);
    const clean = [...new Set((addrs || []).map((a) => String(a).replace(P2P_SUFFIX, '')))].filter((a) => this._usable(a));
    const prev = this.peers.get(id);
    const merged = [...new Set([...clean, ...(prev?.addrs || [])])].slice(0, this.maxAddrs);
    if (!merged.length) return false;
    this.peers.delete(id);   // re-insert so Map order tracks recency too
    this.peers.set(id, { addrs: merged, last_connected: this.now(), failures: 0 });
    this._trim();
    this._scheduleSave();
    return true;
  }

  /** A dial to this peer failed. Repeated failures evict it, so a dead peer does not cost a dial forever. */
  failed(peerId) {
    const id = String(peerId);
    const e = this.peers.get(id);
    if (!e) return;
    e.failures += 1;
    if (e.failures >= this.maxFailures) this.peers.delete(id);
    this._scheduleSave();
  }

  _trim() {
    if (this.peers.size <= this.max) return;
    const ranked = [...this.peers.entries()].sort((a, b) => b[1].last_connected - a[1].last_connected);
    this.peers = new Map(ranked.slice(0, this.max));
  }

  /** Dialable multiaddrs, most recently connected first, never this node itself. */
  targets(selfId) {
    return [...this.peers.entries()]
      .filter(([id]) => id !== String(selfId || ''))
      .sort((a, b) => b[1].last_connected - a[1].last_connected)
      .map(([id, e]) => ({ id, addrs: e.addrs.map((a) => `${a}/p2p/${id}`) }));
  }

  _scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => { this._saveTimer = null; this.save(); }, 2000);
    if (this._saveTimer.unref) this._saveTimer.unref();
  }

  // Write-then-rename, with the last good file rotated to .prev first: a crash at any point leaves at least one
  // complete cache on disk.
  save() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    const body = JSON.stringify({ v: 1, saved_at: new Date(this.now()).toISOString(),
      peers: [...this.peers.entries()].map(([id, e]) => ({ id, ...e })) }, null, 2);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, body);
      try { fs.copyFileSync(this.file, `${this.file}.prev`); } catch { /* first save — nothing to keep */ }
      fs.renameSync(tmp, this.file);
      return true;
    } catch (e) {
      console.warn(`[xn] peer cache: could not save ${this.file}: ${e?.message || e}`);
      return false;
    }
  }
}
