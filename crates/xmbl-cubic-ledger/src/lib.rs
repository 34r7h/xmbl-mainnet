//! XMBL Cubic Ledger Technology.
//!
//! Not a linear chain of blocks. Transactions are hashed into blocks; membership is a
//! pure function of the block SET, never arrival order:
//!
//! - **Face** = exactly 9 blocks. Sort the pool by block hash and chunk into consecutive
//!   groups of 9; a remainder under 9 stays unsealed. Any node holding the same set
//!   produces the identical partition.
//! - **Cube** = exactly 3 sealed faces, carrying a merkle root over its faces.
//!
//! This crate is the Rust port target of `packages/cubic-ledger` (JS/WASM). The geometry
//! constants and `digital_root` below are the real, verified primitives; ledger/cube/face
//! assembly is ported from the JS reference module by module.

/// A face is sealed from exactly this many blocks.
pub const FACE_SIZE: usize = 9;
/// A cube is sealed from exactly this many faces.
pub const CUBE_FACES: usize = 3;

/// Repeated digital root (mod-9 with 9 for multiples of 9, 0 only for 0) used in the
/// cube-curve's final validation step.
pub fn digital_root(mut n: u64) -> u8 {
    if n == 0 {
        return 0;
    }
    let r = (n % 9) as u8;
    n = r as u64;
    if n == 0 {
        9
    } else {
        r
    }
}

/// Deterministic face partition count for a pool of `blocks` blocks: how many full
/// 9-block faces the set seals into. The remainder stays unsealed.
pub fn sealed_faces(blocks: usize) -> usize {
    blocks / FACE_SIZE
}

/// How many full cubes a set of `faces` sealed faces yields.
pub fn sealed_cubes(faces: usize) -> usize {
    faces / CUBE_FACES
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn digital_root_matches_reference() {
        assert_eq!(digital_root(0), 0);
        assert_eq!(digital_root(9), 9);
        assert_eq!(digital_root(18), 9);
        assert_eq!(digital_root(12), 3);
        assert_eq!(digital_root(100), 1);
    }

    #[test]
    fn geometry_seals_in_nines_and_threes() {
        assert_eq!(sealed_faces(26), 2); // 18 blocks seal, 8 remain
        assert_eq!(sealed_cubes(9), 3);
    }
}
