// MEMBERSHIP BACKFILL — reconstruct which blocks belong to which cube, and regenerate coordinates.
//
// THE PROBLEM: the persisted cube record is {id, merkleRoot, faces:[0,1,2], validatorAverageTimestamp, level}
// — `faces` holds face INDICES, never ids, so a cube cannot name its members. The block side that could name
// them reads location.cubeIndex = 0 on every block. Measured 2026-08-02 on the laptop: 396 blocks, 0 naming a
// cube. Consequence: a node holding a cube cannot serve it, so cubes cannot be synced between nodes.
//
// THE FIX IS SELF-VERIFYING. It never guesses: a candidate partition is accepted ONLY if recomputing the cube
// id from it reproduces the persisted id exactly. A partition that does not reproduce the id is discarded and
// the cube is left untouched and reported. That makes a wrong rule impossible to apply silently.
//
// Candidate rules are tried in order because different eras sealed under different code (legacy arrival-order
// `addTransaction` vs `addSealedBatch` hash-pooling), so one node's history may need a different rule than
// another's.
import { createHash } from 'crypto';
import { calculateAbsoluteCoords, calculateVector, calculateFractalAddress } from './geometry.js';

const merkle = (hs) => {
  if (!hs.length) throw new Error('merkle of empty set');
  if (hs.length === 1) return hs[0];
  const nx = [];
  for (let i = 0; i < hs.length; i += 2) nx.push(createHash('sha256').update(hs[i] + (hs[i + 1] ?? hs[i])).digest('hex'));
  return merkle(nx);
};
const faceRoot = (hashes) => merkle([...hashes].sort());
const cubeIdOf = (roots) => createHash('sha256').update([...roots].sort().join('')).digest('hex').slice(0, 16);
const cubeRootOf = (roots) => merkle([...roots].sort());

const tsOf = (b) => {
  const t = b?.timestamp;
  const raw = (t && typeof t === 'object' && t.__bigint__) ? t.__bigint__ : t;
  try { return BigInt(raw); } catch { return 0n; }
};

// Each rule returns an ordered list of blocks; faces are consecutive 9s, cubes consecutive 3 faces.
export const RULES = {
  // Legacy `addTransaction`: a block joined the oldest pending face and the face sealed on the 9th ARRIVAL.
  // Verified against the laptop ledger 2026-08-02: reproduced 14/14 cube ids AND merkle roots, 0 false
  // positives across all 13,244 face triples, and independently confirmed by position == hash-rank at 396/396.
  arrival: (blocks) => [...blocks].sort((a, b) => (tsOf(a) < tsOf(b) ? -1 : tsOf(a) > tsOf(b) ? 1 : 0)),
  // `addSealedBatch`: the pool was globally hash-sorted before chunking.
  hash: (blocks) => [...blocks].sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0)),
};

// Build faces/cubes from an ordering and index them by the id they produce.
function cubesFromOrder(ordered) {
  const faces = [];
  for (let i = 0; i + 9 <= ordered.length; i += 9) {
    const chunk = ordered.slice(i, i + 9);
    const byHash = [...chunk].sort((a, b) => (a.hash < b.hash ? -1 : 1));
    faces.push({ members: byHash, root: faceRoot(byHash.map(b => b.hash)) });
  }
  const out = new Map();
  for (let f = 0; f + 3 <= faces.length; f += 3) {
    const tri = faces.slice(f, f + 3);
    const roots = tri.map(x => x.root);
    out.set(cubeIdOf(roots), { faces: tri, roots, merkleRoot: cubeRootOf(roots), seq: out.size });
  }
  return out;
}

/**
 * @returns {{matched:Array, unmatched:Array, ruleUsed:Object, writes:Array}}
 */
export function reconstruct(blocks, cubeRecords) {
  const want = new Map(cubeRecords.map(c => [c.id, c]));
  const results = new Map();       // cubeId -> built cube
  const ruleUsed = {};

  for (const [name, order] of Object.entries(RULES)) {
    const built = cubesFromOrder(order(blocks));
    for (const [id, cube] of built) {
      if (!want.has(id) || results.has(id)) continue;
      // SELF-VERIFICATION: the persisted merkleRoot must also match, not just the id.
      if (want.get(id).merkleRoot && want.get(id).merkleRoot !== cube.merkleRoot) continue;
      results.set(id, cube);
      ruleUsed[name] = (ruleUsed[name] || 0) + 1;
    }
    if (results.size === want.size) break;
  }

  const writes = [];
  for (const [id, cube] of results) {
    // faceIndex = rank of the face's root among the cube's 3 roots — the same order cube.id is derived from,
    // so faceIndex and the id derivation can never disagree.
    const rank = new Map([...cube.roots].sort().map((r, i) => [r, i]));
    for (const face of cube.faces) {
      const faceIndex = rank.get(face.root);
      face.members.forEach((block, position) => {
        const location = { faceIndex, position, cubeIndex: id, cubeSequentialIndex: cube.seq, level: 1 };
        const coordinates = calculateAbsoluteCoords(location);
        writes.push({
          block, location, coordinates,
          vector: calculateVector(coordinates),
          fractalAddress: calculateFractalAddress(location),
        });
      });
    }
  }
  return {
    matched: [...results.keys()],
    unmatched: [...want.keys()].filter(id => !results.has(id)),
    ruleUsed, writes,
  };
}
