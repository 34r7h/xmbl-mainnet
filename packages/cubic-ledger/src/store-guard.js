// THE LEDGER STORE'S OWN LIMITS: a write fault, a full disk, and dead versions left on disk (v0.1.31).
//
// MEASURED 2026-11-13 on the operator's MacBook, node 0.1.30: the ledger directory reached 11 GB for about
// 230 MB of live rows, and the disk under it filled. LevelDB then refused writes with an IO error that every
// call site caught as "in-memory fallback", so the node kept answering and stopped persisting, and its rows
// stayed in orphaned .ldb files that only a reopen deletes. Three rules close that:
//   1. A write fault (LEVEL_IO_ERROR, LEVEL_CORRUPTION, ENOSPC) is a store fault. The ledger emits
//      `store:fault` once; the daemon exits STORE_FAULT_EXIT_CODE and its supervisor reopens the store.
//   2. A ledger write is refused at the door while free disk is under max(1 GiB, 2 x live ledger bytes): the
//      floor a compaction needs to rewrite the live rows beside the old ones.
//   3. At boot, when the live rows are under half the directory size and the directory is over 64 MiB, the
//      whole key range is compacted once, so the dead versions leave the disk. The live rows are counted in the
//      ledger's own boot scan of block rows: a second full pass over the store sets off LevelDB's
//      seek-triggered compactions (MEASURED on a copy of this machine's ledger: +11 to +24 MB per boot).
import { readdirSync, statSync, statfsSync } from 'node:fs';
import { join } from 'node:path';

export const STORE_FAULT_EXIT_CODE = 74;          // EX_IOERR. 75 is the OTA restart; a fault is not an update.
export const DISK_FLOOR_BYTES = 1024 ** 3;        // 1 GiB
export const DISK_CHECK_MS = 10_000;              // statfs at most this often
export const BOOT_COMPACT_MIN_BYTES = 64 * 1024 ** 2;

// A fault of the store itself. A closed handle (shutdown) and a bad key are not faults.
export function isStoreFault(e) {
  if (!e) return false;
  const codes = [e.code, e.cause && e.cause.code].map((c) => String(c || ''));
  if (codes.some((c) => c === 'LEVEL_IO_ERROR' || c === 'LEVEL_CORRUPTION' || c === 'ENOSPC' || c === 'EIO')) return true;
  if (codes.some((c) => c === 'LEVEL_DATABASE_NOT_OPEN' || c === 'LEVEL_INVALID_KEY' || c === 'LEVEL_INVALID_VALUE' || c === 'LEDGER_DISK_LOW')) return false;
  const msg = `${e.message || ''} ${(e.cause && e.cause.message) || ''}`;
  return /No space left|IO error|Corruption|ENOSPC/i.test(msg);
}

// Bytes the directory occupies (LevelDB keeps every file in one flat directory).
export function dirBytes(dir) {
  let total = 0;
  for (const name of readdirSync(dir)) {
    try { const st = statSync(join(dir, name)); if (st.isFile()) total += st.size; } catch { /* removed meanwhile */ }
  }
  return total;
}

export function diskFreeBytes(dir) {
  const s = statfsSync(dir);
  return Number(s.bavail) * Number(s.bsize);
}

export const fmtBytes = (n) => (n == null ? '?' : n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GiB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MiB` : `${(n / 1024).toFixed(0)} KiB`);

export function diskLowError(check) {
  const e = new Error(`ledger write refused: ${fmtBytes(check.free)} free on the ledger's disk, the floor is ${fmtBytes(check.need)} (max(1 GiB, 2 x live ledger))`);
  e.code = 'LEDGER_DISK_LOW';
  return e;
}
