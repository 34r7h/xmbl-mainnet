//! XMBL node runtime.
//!
//! Orchestrates the protocol crates — identity, networking, cubic ledger, state machine,
//! consensus, storage/compute (and, when wired, zero-knowledge) — into one supervised node.
//! Rust port target of `packages/core`.

pub use xmbl_consensus as consensus;
pub use xmbl_cubic_ledger as cubic_ledger;
pub use xmbl_identity as identity;
pub use xmbl_networking as networking;
pub use xmbl_state_machine as state_machine;
pub use xmbl_storage_compute as storage_compute;
pub use xmbl_zero_knowledge as zero_knowledge;

/// Node lifecycle states, mirroring `node.js start|stop|status`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeState {
    Stopped,
    Running,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn protocol_crates_reexported() {
        // geometry constant reachable through the re-export proves the graph links
        assert_eq!(cubic_ledger::FACE_SIZE, 9);
        assert_eq!(consensus::MempoolStage::pipeline().len(), 5);
    }
    #[test]
    fn node_states() {
        assert_ne!(NodeState::Stopped, NodeState::Running);
    }
}
