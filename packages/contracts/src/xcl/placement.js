import { createHash } from 'node:crypto';

// Deterministic contract placement. A contract does not live at an address — it lives at a
// coordinate in the cubic ledger (docs/agentic-contracts-proto.md §1.1, §2.1). Its id and
// its 3 non-collinear planar points are a pure function of its bytes, so every node places
// the identical contract at the identical coordinates, and the points are exactly the
// CurveRequest shape that identity's CubicCurveSource / Cubic-SIG consume — the same object
// that binds a signature to this location.
//
// This is self-contained (hash-derived) so the contracts module places contracts with no
// dependency on cubic-ledger. When the full node is present, the ledger's own geometry is
// authoritative for WHERE in the live cube a contract's transactions seal; the coordinates
// here are the contract's stable cryptographic context, which must match across nodes and
// therefore must be derived, not assigned.

/**
 * Content-addressed contract id: sha256 of the WASM bytes, hex, prefixed `xc1_`.
 * @param {Uint8Array|Buffer} wasmBytes
 * @returns {string}
 */
export function contractId(wasmBytes) {
  const h = createHash('sha256').update(Buffer.from(wasmBytes)).digest('hex');
  return 'xc1_' + h;
}

// A small signed coordinate in [-1, 1] from one hex byte — three of these per point.
function coord(hex, i) {
  const b = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return (b % 3) - 1; // -1, 0, or 1
}

/**
 * The contract's cubic context: an address plus 3 ordered, non-collinear planar points.
 * Derived from the id hash; if the first derivation is collinear (degenerate plane), it
 * perturbs deterministically until the three points span a plane, so the returned context
 * always has a real planar section (the property Cubic-SIG needs to bind a signature).
 * @param {string} id contract id from {@link contractId}
 * @returns {{cubeAddress:string, coordinates:Array<{x:number,y:number,z:number}>}}
 */
export function contractCoordinates(id) {
  let h = createHash('sha256').update(id).digest('hex');
  for (let attempt = 0; attempt < 8; attempt++) {
    const p = [0, 1, 2].map((k) => ({
      x: coord(h, k * 3 + 0),
      y: coord(h, k * 3 + 1),
      z: coord(h, k * 3 + 2),
    }));
    // Non-collinear iff (p1-p0) x (p2-p0) is a non-zero vector.
    const u = { x: p[1].x - p[0].x, y: p[1].y - p[0].y, z: p[1].z - p[0].z };
    const v = { x: p[2].x - p[0].x, y: p[2].y - p[0].y, z: p[2].z - p[0].z };
    const n = {
      x: u.y * v.z - u.z * v.y,
      y: u.z * v.x - u.x * v.z,
      z: u.x * v.y - u.y * v.x,
    };
    if (n.x !== 0 || n.y !== 0 || n.z !== 0) {
      const cubeAddress = 'cube-' + parseInt(h.slice(0, 8), 16).toString(16);
      return { cubeAddress, coordinates: p };
    }
    // Degenerate: re-derive from the hash of the hash and try again.
    h = createHash('sha256').update(h).digest('hex');
  }
  throw new Error('contractCoordinates: could not derive a non-collinear plane (unreachable)');
}
