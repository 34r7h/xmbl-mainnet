// DurableNonceRegistry — the mainnet backing store for delegation single-use action-nonces.
//
// delegation.js ships an IN-MEMORY NonceRegistry: single-use holds only within one process, so a
// replay can slip through a restart, and two broker instances each keep their own Map and both
// accept the same nonce. The load-bearing seam (makeAuthorizer → ContractHost.call) already takes
// the store as `policy.nonces` and calls `consume(tokenHash, nonce, exp)`; only the durable backing
// was unwritten. This is it.
//
// SAME CONTRACT as NonceRegistry: consume(tokenHash, nonce, exp) returns true the FIRST time a pair
// is presented and false forever after; has()/size mirror it. The difference that matters for
// mainnet:
//   • DURABLE — the ledger is a SQLite file, so a pair burned before a restart is still burned after.
//   • ATOMIC CAS — consume is a single `INSERT OR IGNORE` against a UNIQUE primary key; the FIRST
//     insert reports changes===1, every later one (this process, another process, another node
//     sharing the file) reports 0. Single-use is enforced by the database's unique constraint, not by
//     JS being single-threaded — so two concurrent nodes cannot both accept one nonce. consume stays
//     SYNCHRONOUS (node:sqlite is sync), so the seam keeps its "no await between check and burn"
//     guarantee unchanged.
//
// Eviction: a nonce for an EXPIRED token can never be re-presented successfully (verifyChain rejects
// an expired token before consume), so once exp < now the row is dead weight — swept amortized. exp
// is stored per row; exp===0/unknown rows are kept (no expiry known) and simply accumulate, matching
// the in-memory registry's behaviour.
import { DatabaseSync } from 'node:sqlite';

function nowSec() { return Math.floor(Date.now() / 1000); }

export class DurableNonceRegistry {
  /**
   * @param {object} [opts]
   * @param {string} [opts.path] SQLite file path; ':memory:' for an ephemeral (non-durable) store.
   * @param {number} [opts.sweepEvery] insert count between amortized expiry sweeps (default 1024).
   */
  constructor(opts = {}) {
    const path = opts.path || ':memory:';
    this._db = new DatabaseSync(path);
    // WAL lets a second connection on the same file read committed rows immediately; harmless for
    // :memory:. Durability of a committed INSERT is the property we rely on either way.
    try { this._db.exec('PRAGMA journal_mode = WAL'); } catch { /* :memory: or unsupported — fine */ }
    this._db.exec('CREATE TABLE IF NOT EXISTS used_nonces (k TEXT PRIMARY KEY, exp INTEGER NOT NULL)');
    this._insert = this._db.prepare('INSERT OR IGNORE INTO used_nonces (k, exp) VALUES (?, ?)');
    this._exists = this._db.prepare('SELECT 1 FROM used_nonces WHERE k = ?');
    this._count = this._db.prepare('SELECT COUNT(*) AS n FROM used_nonces');
    this._sweep = this._db.prepare('DELETE FROM used_nonces WHERE exp != 0 AND exp < ?');
    this._sweepEvery = opts.sweepEvery || 1024;
    this._sinceSweep = 0;
  }

  static key(tokenHash, nonce) { return `${tokenHash}:${nonce}`; }

  /**
   * Atomically claim the pair. true = first use (now burned durably); false = already spent
   * (this process, a prior run, or another node sharing the file). The single `INSERT OR IGNORE`
   * IS the compare-and-set: no read-then-write race window.
   * @param {number} [exp] token expiry (unix seconds); used only for eviction.
   */
  consume(tokenHash, nonce, exp) {
    const info = this._insert.run(DurableNonceRegistry.key(tokenHash, nonce), Math.floor(exp) || 0);
    const won = info.changes === 1;
    if (won && ++this._sinceSweep >= this._sweepEvery) { this._sinceSweep = 0; this._sweep.run(nowSec()); }
    return won;
  }

  has(tokenHash, nonce) { return this._exists.get(DurableNonceRegistry.key(tokenHash, nonce)) !== undefined; }

  get size() { return this._count.get().n; }

  /** Evict every entry whose token has expired. Returns the number removed. */
  sweepExpired(now = nowSec()) { return this._sweep.run(now).changes; }

  close() { try { this._db.close(); } catch { /* already closed */ } }
}
