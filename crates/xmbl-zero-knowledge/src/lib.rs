//! ⚠ NON-PRODUCTION (pre-mainnet stub) — this crate has NOT reached parity with its JS reference
//! in `packages/`; crates.io consumers must not rely on it. Tracked in MAINNET-GATES.md
//! (Cross-cutting: "eight Rust crates"). Version `0.x` until parity or an external audit.
//!
//! XMBL zero-knowledge cube-curve state-commitment.
//!
//! Post-quantum, hash-based FRI polynomial commitment: a prover holding a secret nonce commits
//! a curve through public points and proves derived points lie on it, revealing nothing about
//! the nonce beyond the public statement. Composes with MAYO; it is NOT an identity CurveSource.
//!
//! ┌───────────────────────────────────────────────────────────────────────────┐
//! │ EXPERIMENTAL and UNAUDITED. Not wired to any production path. Do not rely   │
//! │ on it for security until a MAYO/UOV-adjacent review lands.                  │
//! └───────────────────────────────────────────────────────────────────────────┘
//! Rust port target of `packages/zero-knowledge`.

/// Public parameters produced by `setup`.
#[derive(Debug, Clone)]
pub struct Params {
    pub security_bits: u32,
}

/// A FRI proof (opaque bytes in this stub).
#[derive(Debug, Clone)]
pub struct Proof(pub Vec<u8>);

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn params_carry_security_level() {
        let p = Params { security_bits: 128 };
        assert_eq!(p.security_bits, 128);
    }
}
