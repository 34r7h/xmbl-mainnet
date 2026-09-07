// DETERMINISTIC PARALLEL PLACEMENT — blocks -> faces -> cubes -> higher levels, with no coordination.
//
// THE BUG THIS REPLACES: membership was decided by LOCAL ARRIVAL ORDER. `_finalizeFace` put a block in "the
// oldest pending face with room" and sealed on the 9th ARRIVAL, so two nodes holding the identical set of
// finalized transactions partitioned them differently, produced different merkle roots, and diverged
// permanently. Measured 2026-08-02: laptop 14 cubes, prod 19 cubes, ZERO shared ids.
//
// THE RANDOMNESS CHAIN. The quorum-averaged validator timestamp from the first mempool validations is the
// RANDOMIZATION SOURCE. It is stamped into txData BEFORE hashing, so block.hash carries it, and every level
// above inherits it because each level hashes the level below:
//
//   avg validator timestamp ──into txData──> block.hash
//     └─> blocks SORTED BY HASH, consecutive chunks of 9 ──> FACE (position = rank in the chunk)
//           └─> face.merkleRoot = merkle(9 block hashes)   ← inherits the randomness
//                 └─> face root MOD 3 ──> the face's SLOT in a cube
//                       └─> cube.id = sha256(3 face roots) ← inherits again
//                             └─> cube.id feeds the level above, same two rules
//
// Verified: changing the averaged timestamp by ONE NANOSECOND completely reshuffles block.hash. A node cannot
// steer its own placement without breaking quorum.
//
// TWO RULES, DELIBERATELY DIFFERENT AT THE TWO LEVELS:
//
//   blocks -> faces : SORT BY HASH, take consecutive 9. Not digital root, not mod 9. A face is complete as
//                     soon as 9 sorted blocks exist, with no waiting on any particular residue.
//   faces  -> cubes : SLOT = face root MOD 3. Cubes are built in PARALLEL — two faces sharing a slot do not
//                     collide, they belong to two different cubes, both open at once.
//
// WHY THE ASYMMETRY: a slotted container completes only when EVERY slot is occupied, so its latency is set by
// the emptiest slot, not the average. Over 9 residues (digital roots) that coupon-collector wait dominated and
// spawned far more parallel faces than could be filled. Over 3 it is cheap. So slotting buys parallel cube
// construction where it is affordable, and plain hash-sorting carries the level where it is not.
//
// THE ONE THING THAT MUST STILL BE DETERMINISTIC at the slotted level: which OPEN cube a face joins. Decided by
// content, never arrival: among all faces sharing slot s, ordered by merkle root, the k-th joins cube k. So
// cube k seals exactly when all 3 slots hold at least k+1 faces. Every node computes the same k from the same
// set with no messages exchanged.
//
// MEMBERSHIP vs PLACEMENT. Which members are in the agreed batch is seal agreement's job
// (`xpc/src/seal-agreement.js`, lowest bounded prefix by content key). This module only places agreed members.
// A late low-hash block would shift the chunk boundaries, so callers MUST pass a frozen agreed set and never
// re-place a sealed container.
//
// DETERMINISM CONTRACT: same SET in, byte-identical output, any input order, every level.
// `deterministic-placement.test.mjs` proves it by shuffling, with a negative control that must go red.
import { createHash } from 'crypto';

export const FACE_SIZE = 9;    // blocks per face — consecutive chunk of the hash-sorted order
export const CUBE_SLOTS = 3;   // faces per cube  — slot = faceRoot mod 3
export const CUBE_SIZE = FACE_SIZE * CUBE_SLOTS; // 27

const TS_WIDTH = 32;

// validationTimestamp has been observed at both 19 and 25 digits in live data (the averaging code has produced
// both scales), so accept either and reject anything wider rather than mis-parsing it.
export function normalizeTimestamp(v) {
  if (v === null || v === undefined) return null;
  const s = typeof v === 'object' && v.__bigint__ ? String(v.__bigint__) : String(v);
  if (!/^\d+$/.test(s) || s.length > TS_WIDTH) return null;
  return s.padStart(TS_WIDTH, '0');
}

// The content key a member is ordered and slotted by AT ITS OWN LEVEL: block hash, face merkle root, cube id.
//
// ⚠ `placementKey` is set EXPLICITLY by placeFaces/placeCubes and takes precedence. Do not rely on the
// duck-typed fallback for anything this module produces: a cube carries BOTH `merkleRoot` and `id`, so the
// fallback order silently picks merkleRoot when the spec says cube.id is what feeds the level above. A
// consensus value must never be selected by property-name precedence — two implementations ordering the same
// object by different fields fork while both look correct.
export function memberKey(member) {
  const k = member?.placementKey ?? member?.hash ?? member?.merkleRoot ?? member?.id;
  return (typeof k === 'string' && /^[0-9a-f]{16,64}$/.test(k)) ? k : undefined;
}

// ELIGIBILITY, not ordering. No averaged validator timestamp means the tx never reached quorum, so it is not
// placeable at all. This is the ONLY use of validationTimestamp — the randomness it carries already lives
// inside the hash, so using it as a sort key too would couple placement to time instead of content.
export function isPlaceable(member) {
  if (memberKey(member) === undefined) return false;
  if (member.level !== undefined && member.level > 1) return true; // higher-level containers inherit validity
  return normalizeTimestamp(member?.tx?.validationTimestamp) !== null;
}
export function unplaceable(members) { return members.filter(m => !isPlaceable(m)); }

// Total order at any level. Content keys are unique, so no tie survives for a stable sort to break arbitrarily
// — the order is a property of the SET, never of the input sequence.
export function orderMembers(members) {
  return [...members].filter(m => memberKey(m) !== undefined)
    .sort((a, b) => (memberKey(a) < memberKey(b) ? -1 : memberKey(a) > memberKey(b) ? 1 : 0));
}

// THE SLOT. Content-derived, uniform over the modulus. Uses the LOW 8 hex digits: a merkle root's high nibbles
// are not more random than its low ones, but block ids are the FIRST 16 hex of the hash, so keying on the high
// end would make a block and its id-prefixed forms share a slot.
export function slotOf(key, modulus) {
  if (typeof key !== 'string' || key.length < 8) throw new Error('deterministic-placement: bad key');
  return parseInt(key.slice(-8), 16) % modulus;
}

function merkleRoot(hashes) {
  if (!hashes.length) throw new Error('deterministic-placement: merkle of empty set');
  if (hashes.length === 1) return hashes[0];
  const next = [];
  for (let i = 0; i < hashes.length; i += 2) next.push(createHash('sha256').update(hashes[i] + (hashes[i + 1] ?? hashes[i])).digest('hex'));
  return merkleRoot(next);
}
export { merkleRoot };

export function faceRootOf(keys) {
  if (keys.length !== FACE_SIZE) throw new Error(`deterministic-placement: face needs ${FACE_SIZE}, got ${keys.length}`);
  return merkleRoot([...keys].sort());
}
export function cubeIdOf(faceRoots) {
  if (faceRoots.length !== CUBE_SLOTS) throw new Error(`deterministic-placement: cube needs ${CUBE_SLOTS}, got ${faceRoots.length}`);
  return createHash('sha256').update([...faceRoots].sort().join('')).digest('hex').slice(0, 16);
}
export function cubeRootOf(faceRoots) {
  if (faceRoots.length !== CUBE_SLOTS) throw new Error(`deterministic-placement: cube needs ${CUBE_SLOTS}, got ${faceRoots.length}`);
  return merkleRoot([...faceRoots].sort());
}

// ---- THE ASSEMBLER: route members into parallel containers by slot ---------------------------------------
// Returns { complete, open }. `complete[k]` has one member in every slot. `open` holds the tail of partially
// filled containers, which stay pending until later members fill their empty slots — the parallel-construction
// behaviour: containers fill at different rates and seal independently.
export function assemble(members, slots) {
  const bySlot = Array.from({ length: slots }, () => []);
  for (const m of orderMembers(members)) bySlot[slotOf(memberKey(m), slots)].push(m);

  const depth = Math.max(0, ...bySlot.map(s => s.length));
  const complete = [], open = [];
  for (let k = 0; k < depth; k++) {
    const row = bySlot.map(s => s[k]);
    if (row.every(Boolean)) complete.push(row.map((member, slot) => ({ member, slot })));
    else open.push(row.map((member, slot) => (member ? { member, slot } : null)).filter(Boolean));
  }
  return { complete, open, bySlot };
}

// ---- LEVEL 1: blocks -> faces (SORT BY HASH, consecutive chunks of 9) -------------------------------------
// No slotting here. The hash already carries the consensus randomness, so a plain sort is both deterministic
// and free of the empty-slot wait. A trailing partial chunk stays pending until more blocks finalize.
export function placeFaces(blocks, opts = {}) {
  const ordered = orderMembers(blocks.filter(isPlaceable));
  const faces = [];
  let i = 0;
  for (; i + FACE_SIZE <= ordered.length; i += FACE_SIZE) {
    const chunk = ordered.slice(i, i + FACE_SIZE);
    const merkleRoot = faceRootOf(chunk.map(memberKey));
    faces.push({
      index: (opts.startFaceIndex ?? 0) + faces.length,
      merkleRoot,
      placementKey: merkleRoot,     // a face is slotted into its cube by its own merkle root
      members: chunk.map((member, position) => ({ member, position })),
    });
  }
  return { faces, pending: ordered.slice(i), unplaceable: unplaceable(blocks) };
}

// ---- FACES -> CUBES ---------------------------------------------------------------------------------------
export function placeCubes(faces, opts = {}) {
  const level = opts.level ?? 1;
  const { complete, open } = assemble(faces, CUBE_SLOTS);
  const cubes = complete.map((row, index) => {
    const cubeSequentialIndex = (opts.startCubeIndex ?? 0) + index;
    const faceRoots = row.map(({ member }) => member.merkleRoot);
    const id = cubeIdOf(faceRoots);
    const placements = [];
    for (const { member: face, slot: faceIndex } of row) {
      for (const m of face.members) {
        placements.push({
          member: m.member, block: m.member,
          location: { faceIndex, position: m.position, cubeIndex: id, cubeSequentialIndex, level },
        });
      }
    }
    return { id, placementKey: id, merkleRoot: cubeRootOf(faceRoots), faceRoots, faces: row.map(({ member, slot }) => ({ ...member, faceIndex: slot })), cubeSequentialIndex, level, placements };
  });
  return { cubes, pending: open };
}

// ---- ONE CALL: blocks all the way to cubes ----------------------------------------------------------------
export function place(blocks, opts = {}) {
  const { faces, pending: pendingBlocks, unplaceable: bad } = placeFaces(blocks, opts);
  const { cubes, pending: pendingFaces } = placeCubes(faces, opts);
  return { cubes, faces, pendingBlocks, pendingFaces, unplaceable: bad };
}

// ---- RECURSION: identical rule one level up ---------------------------------------------------------------
// Level-N cubes are slotted by cube.id — which inherited its randomness from the face roots, which inherited it
// from block hashes, which inherited it from the averaged validator timestamps. No timestamps above level 1.
export function placeLevel(containers, opts = {}) {
  const level = (opts.level ?? 1) + 1;
  const promoted = containers.map(c => ({ ...c, level: Math.max(2, c.level ?? 1) }));
  const { faces, pending: pendingMembers } = placeFaces(promoted, opts);
  const { cubes, pending: pendingFaces } = placeCubes(faces, { ...opts, level });
  return { cubes, faces, pendingMembers, pendingFaces, level };
}
