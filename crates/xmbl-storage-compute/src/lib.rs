//! ⚠ NON-PRODUCTION (pre-mainnet stub) — this crate has NOT reached parity with its JS reference
//! in `packages/`; crates.io consumers must not rely on it. Tracked in MAINNET-GATES.md
//! (Cross-cutting: "eight Rust crates"). Version `0.x` until parity or an external audit.
//!
//! XMBL storage and compute market.
//!
//! P2P redundant storage with fresh-nonce availability proofs, plus sandboxed WASM compute
//! offered at fair-market prices. Payment settles via cubic-ledger transactions.
//! Rust port target of `packages/storage-compute`.
use sha2::{Digest, Sha256};

/// Availability-probe proof: `sha256(nonce || shard bytes)`. A fresh nonce per probe means a
/// responder cannot pre-compute or replay — it must hold the actual bytes at probe time.
pub fn probe_proof(nonce: &[u8], data: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(nonce);
    h.update(data);
    let d = h.finalize();
    let mut s = String::with_capacity(d.len() * 2);
    for b in d {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn proof_binds_nonce_and_data() {
        assert_ne!(probe_proof(b"n1", b"shard"), probe_proof(b"n2", b"shard"));
        assert_eq!(probe_proof(b"n", b"x"), probe_proof(b"n", b"x"));
    }
}
