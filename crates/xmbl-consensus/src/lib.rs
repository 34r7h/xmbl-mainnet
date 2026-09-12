//! ⚠ NON-PRODUCTION (pre-mainnet stub) — this crate has NOT reached parity with its JS reference
//! in `packages/`; crates.io consumers must not rely on it. Tracked in MAINNET-GATES.md
//! (Cross-cutting: "eight Rust crates"). Version `0.x` until parity or an external audit.
//!
//! XMBL peer consensus — user-as-validator.
//!
//! The user of a transaction validates their own transaction: no miners, no staking
//! validator cartel. Transactions advance through a five-stage mempool. A transaction
//! whose user cannot be resolved can never advance.
//! Rust port target of `packages/consensus`.

/// The five mempool stages a transaction advances through.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MempoolStage {
    Raw,
    ValidationTasks,
    LockedUtxo,
    Processing,
    Finalized,
}

impl MempoolStage {
    /// The ordered pipeline.
    pub fn pipeline() -> [MempoolStage; 5] {
        use MempoolStage::*;
        [Raw, ValidationTasks, LockedUtxo, Processing, Finalized]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pipeline_has_five_stages() {
        assert_eq!(MempoolStage::pipeline().len(), 5);
        assert_eq!(MempoolStage::pipeline()[0], MempoolStage::Raw);
    }
}
