//! XMBL peer-to-peer networking layer.
//!
//! Node discovery, gossip (floodsub), routing, and NAT traversal (circuit-relay v2 + dcutr).
//! The JS reference (`packages/networking`) runs on libp2p; the Rust port targets rust-libp2p.
//! This crate is the API-surface stub for that port.

/// A libp2p peer id (base58btc multihash string in the JS reference).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerId(pub String);

/// Transports the node listens on / dials.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Transport {
    Tcp,
    WebSockets,
    WebSocketsSecure,
    CircuitRelay,
}

/// Node role in the mesh. Leadership is about task distribution, not who may validate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Peer,
    RelayServer,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn transports_distinct() {
        assert_ne!(Transport::Tcp, Transport::WebSockets);
    }
}
