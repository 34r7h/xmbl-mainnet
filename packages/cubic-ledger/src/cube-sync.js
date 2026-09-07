// CUBE SYNC — the missing catch-up. A node that misses a seal round never acquired that cube, and there was
// no mechanism to fetch it later, so a momentary disagreement became permanent. Measured 2026-08-02: laptop 14
// cubes, prod 20, agentic 14, ifix 14 — and the three 14-cube sets have THREE DIFFERENT digests.
//
// THE LOAD-BEARING PROPERTY: cubes are SELF-CERTIFYING.
//
//   block.hash      = sha256(canonical tx)
//   face.merkleRoot = merkle(9 block hashes, sorted)
//   cube.id         = sha256(3 face roots, sorted)[:16]
//
// Every level is a hash of the level below, so a receiver RECOMPUTES the id from the payload and compares it
// to the id it asked for. A lying sender produces a mismatch and is rejected. That is why this needs no
// allowlist, no roster, and no signature on the response — it does not trust the sender at all, it trusts
// arithmetic. Which is exactly what a dynamic network with no hardcoded addresses requires.
//
// ⚠ STRUCTURE, NOT PROVENANCE. These checks prove a block set is internally consistent and hashes to the
// claimed cube. They do NOT prove the member txs passed validation quorum — no validator attestations are
// persisted anywhere in the ledger, so that is unprovable from disk for ANY cube, synced or local. Signature
// verification (check 6) is the strongest available statement, and it is applied strictly here: unlike the
// local path, a synced block whose submitter key does not resolve is REJECTED. Failing open is defensible for
// locally-submitted txs; for remote input it is indefensible.
import { createHash } from 'crypto';

export const TOPIC_DIGEST = 'sync:digest';
export const TOPIC_LIST = 'sync:list';
export const TOPIC_CUBE = 'sync:cube';

const merkle = (hs) => {
  if (!hs.length) throw new Error('cube-sync: merkle of empty set');
  if (hs.length === 1) return hs[0];
  const nx = [];
  for (let i = 0; i < hs.length; i += 2) nx.push(createHash('sha256').update(hs[i] + (hs[i + 1] ?? hs[i])).digest('hex'));
  return merkle(nx);
};
export const faceRootOf = (hashes) => merkle([...hashes].sort());
export const cubeIdOf = (roots) => createHash('sha256').update([...roots].sort().join('')).digest('hex').slice(0, 16);
export const cubeRootOf = (roots) => merkle([...roots].sort());

export function setDigest(cubes) {
  const rows = cubes.map(c => `${c.id}:${c.merkleRoot}`).sort();
  return createHash('sha256').update(rows.join('|')).digest('hex');
}

// Canonical tx hash — must match Block.fromTransaction, which is BigInt-safe.
function txHash(tx) {
  const s = JSON.stringify(tx, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  return createHash('sha256').update(s).digest('hex');
}

/**
 * VERIFY A FETCHED CUBE. Returns { ok, reason } — never throws, so one malformed peer cannot kill the loop.
 * Every check must pass; partial adoption is never permitted.
 */
export function verifyCube(payload, expectedId, opts = {}) {
  const R = (reason) => ({ ok: false, reason });
  if (!payload || typeof payload !== 'object') return R('empty payload');
  const faces = payload.faces;
  if (!Array.isArray(faces) || faces.length !== 3) return R('not 3 faces');

  const roots = [];
  for (const face of faces) {
    if (!face || !Array.isArray(face.blocks) || face.blocks.length !== 9) return R('face is not 9 blocks');
    const hashes = [];
    for (const b of face.blocks) {
      if (!b || typeof b.hash !== 'string' || !/^[0-9a-f]{64}$/.test(b.hash)) return R('bad block hash');
      if (!b.tx || typeof b.tx !== 'object') return R('block has no tx');
      if (txHash(b.tx) !== b.hash) return R(`block hash does not match its tx (${b.hash.slice(0, 12)})`);
      hashes.push(b.hash);
    }
    const root = faceRootOf(hashes);
    if (typeof face.merkleRoot === 'string' && face.merkleRoot !== root) return R('face merkleRoot mismatch');
    roots.push(root);
  }

  const id = cubeIdOf(roots);
  if (expectedId && id !== expectedId) return R(`cube id mismatch: computed ${id}, asked for ${expectedId}`);
  const root = cubeRootOf(roots);
  if (payload.merkleRoot && payload.merkleRoot !== root) return R('cube merkleRoot mismatch');

  // Shape validation, and STRICT signature verification for remote input.
  if (opts.validateTransaction) {
    for (const face of faces) for (const b of face.blocks) {
      try { opts.validateTransaction(b.tx); } catch (e) { return R(`invalid tx: ${e.message}`); }
    }
  }
  if (opts.verifyTx) {
    for (const face of faces) for (const b of face.blocks) {
      if (opts.verifyTx(b.tx) !== true) return R('member tx failed signature verification');
    }
  }
  return { ok: true, id, merkleRoot: root, faceRoots: roots };
}

/**
 * ADOPTION PLAN. Pure — computes what MUST happen, so the hazards are testable without a live ledger.
 *
 * 1. content-keyed, append-only: never displaces an existing cube, never keyed by hrtime
 * 2. ⛔ adopted cubes are NOT counted toward recursive L2 formation — `_checkRecursiveCubeFormation` forms an
 *    L2 face at 9 completed cubes, so a sync burst would manufacture an L2 face NO OTHER NODE forms. The
 *    repair mechanism creating a fork.
 * 3. evict adopted members from the L1 candidate pool, or this node later seals the same tx into a SECOND cube
 * 4. ⛔ never-seen member blocks are persisted (so membership + merkle recomputation work) but are NOT admitted
 *    to the raw mempool and get no validation tasks — they arrive as sealed history, not pending work
 */
export function planAdoption(verified, payload, ctx = {}) {
  const have = ctx.haveCubeIds instanceof Set ? ctx.haveCubeIds : new Set(ctx.haveCubeIds || []);
  if (have.has(verified.id)) return { skip: true, reason: 'already held' };

  const pool = ctx.membershipPool || [];
  const poolHashes = new Set(pool.map(b => b && b.hash).filter(Boolean));
  const known = ctx.knownBlockHashes instanceof Set ? ctx.knownBlockHashes : new Set(ctx.knownBlockHashes || []);

  const rank = new Map([...verified.faceRoots].sort().map((r, i) => [r, i]));
  const blocks = [];
  const evictFromPool = [];
  for (const face of payload.faces) {
    const root = faceRootOf(face.blocks.map(b => b.hash));
    const faceIndex = rank.get(root);
    const ordered = [...face.blocks].sort((a, b) => (a.hash < b.hash ? -1 : 1));
    ordered.forEach((b, position) => {
      blocks.push({
        hash: b.hash, tx: b.tx,
        location: { faceIndex, position, cubeIndex: verified.id, cubeSequentialIndex: ctx.nextSeq ?? 0, level: 1 },
        neverSeen: !known.has(b.hash),
      });
      if (poolHashes.has(b.hash)) evictFromPool.push(b.hash);
    });
  }
  return {
    skip: false,
    cubeRecord: { id: verified.id, merkleRoot: verified.merkleRoot, faces: [0, 1, 2], level: 1, adopted: true },
    blocks,
    evictFromPool,
    countTowardRecursion: false,   // rule 2 — non-negotiable
    admitToMempool: false,         // rule 4 — non-negotiable
  };
}

/** Which cube ids to request from a peer, bounded per round. */
export function diffWanted(myIds, peerCubes, maxInFlight = 4) {
  const have = myIds instanceof Set ? myIds : new Set(myIds || []);
  return (peerCubes || [])
    .filter(c => c && typeof c.id === 'string' && !have.has(c.id))
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .slice(0, Math.max(1, maxInFlight))
    .map(c => c.id);
}
