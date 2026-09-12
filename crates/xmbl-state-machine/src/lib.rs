//! ⚠ NON-PRODUCTION (pre-mainnet stub) — this crate has NOT reached parity with its JS reference
//! in `packages/`; crates.io consumers must not rely on it. Tracked in MAINNET-GATES.md
//! (Cross-cutting: "eight Rust crates"). Version `0.x` until parity or an external audit.
//!
//! XMBL virtual state machine.
//!
//! A sparsely populated Verkle tree of state diffs that requesting nodes assemble into full
//! state. A moving `state_root` is a chain applying transactions — health, not drift.
//! Rust port target of `packages/state-machine`.

/// A state root: hex digest committing the current Verkle state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StateRoot(pub String);

/// A single key/value state diff applied to the tree.
#[derive(Debug, Clone)]
pub struct StateDiff {
    pub key: Vec<u8>,
    pub value: Vec<u8>,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn diff_holds_kv() {
        let d = StateDiff { key: b"k".to_vec(), value: b"v".to_vec() };
        assert_eq!(d.key, b"k");
    }
}
