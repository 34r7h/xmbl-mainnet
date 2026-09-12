//! ⚠ NON-PRODUCTION (pre-mainnet stub) — this crate has NOT reached parity with its JS reference
//! in `packages/`; crates.io consumers must not rely on it. Tracked in MAINNET-GATES.md
//! (Cross-cutting: "eight Rust crates"). Version `0.x` until parity or an external audit.
//!
//! XMBL identity and signatures.
//!
//! The live signing scheme is MAYO (post-quantum, NIST PQC). The cubic-curve seam
//! (`CurveSource`) derives parameter material from the cube-of-cubes ledger geometry;
//! it is specified but not yet the production signer — see `packages/identity`.
//! Rust port target of `packages/identity` (JS/WASM MAYO artifact in `mayo-cube/`).

/// Signature schemes an identity's keypair may belong to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scheme {
    /// MAYO post-quantum signatures (default, live).
    Mayo,
    /// Cube-curve MAYO variant (seam wired; distinct crypto pending).
    MayoCube,
}

impl Default for Scheme {
    fn default() -> Self {
        Scheme::Mayo
    }
}

/// A public XMBL address, derived from a public key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Address(pub String);

/// Derive the address from a public key's bytes: hex of the SHA-256 digest.
pub fn derive_address(public_key: &[u8]) -> Address {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(public_key);
    Address(hex_lower(&h.finalize()))
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn address_is_deterministic() {
        assert_eq!(derive_address(b"pk"), derive_address(b"pk"));
        assert_ne!(derive_address(b"a"), derive_address(b"b"));
    }
    #[test]
    fn default_scheme_is_mayo() {
        assert_eq!(Scheme::default(), Scheme::Mayo);
    }
}
