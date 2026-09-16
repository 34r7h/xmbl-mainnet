// PARSE THE ANCHOR ts THE WAY THE BROKER ACTUALLY SENDS IT. The canonical feed carries `ts` as an ISO
// STRING ("2026-07-08T22:54:11.727Z"); the previous line here did `Number(a.ts)`, which is NaN for every
// one of them, and `NaN || 0` is 0. MEASURED on a live ledger 2026-09-16: all 17,628 stored anchor `ts`
// values are strings, and all 3,967 rows this rebuild had written carried `timestamp` 0n — so cube
// placement was pinned to the epoch for the entire canonical set and every rebuilt face averaged to 0.
// The rest of the ledger measures block timestamps in NANOSECONDS (face.getAverageTimestamp multiplies a
// non-BigInt by 1e6 to get there), so epoch-ms is scaled here rather than stored raw, which the old line
// also got wrong for the numeric case it was written for. Anything unparseable still yields 0n — that is
// the honest answer for an anchor that recorded no time, and it is never guessed at from local wall clock.
export function anchorTimestampNanos(ts) {
  let ms = null;
  if (typeof ts === 'bigint') return ts < 0n ? 0n : ts;          // already nanoseconds
  if (typeof ts === 'number' && Number.isFinite(ts)) ms = ts;
  else if (typeof ts === 'string' && ts !== '') {
    ms = /^-?\d+$/.test(ts) ? Number(ts) : Date.parse(ts);       // numeric string, else ISO-8601
  }
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return 0n;
  return BigInt(Math.floor(ms)) * 1000000n;
}

// The deterministic time of a persisted non-anchor block, or null when the row does not know it.
// `validationTimestamp` is already NANOSECONDS (stored as a digit string, e.g. "1789470971116000000"),
// so it is NOT put through anchorTimestampNanos, which reads a numeric string as epoch-ms.
export function blockTimestampNanos(raw) {
  const vt = raw?.tx?.validationTimestamp;
  if (typeof vt === 'bigint') return vt;
  if (typeof vt === 'number' && Number.isFinite(vt) && vt > 0) return BigInt(Math.floor(vt));
  if (typeof vt === 'string' && /^\d+$/.test(vt)) return BigInt(vt);
  const t = raw?.timestamp;
  if (typeof t === 'bigint') return t;                                   // revived by deserialize
  if (t && typeof t === 'object' && /^\d+$/.test(t.__bigint__ ?? '')) return BigInt(t.__bigint__);
  if (raw?.tx?.ts !== undefined) { const ns = anchorTimestampNanos(raw.tx.ts); if (ns > 0n) return ns; }
  return typeof t === 'number' && Number.isFinite(t) && t > 0 ? null : 0n;
}

