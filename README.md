# XMBL mainnet

**eXtensible Modular Blockchain Ledger.** A decoupled monorepo: every protocol module ships
as both an npm package (JS/WASM) and a crates.io crate (Rust), released together under one
version line. Ships with a live blockchain visualizer and the XMBL app builder.

## What is XMBL, in one screen

- **You validate your own transaction.** No miners, no staking validator cartel. A transaction
  whose user cannot be resolved never advances.
- **Not a linear chain.** Transactions are hashed into blocks; **9 blocks seal a face**, **3 faces
  seal a cube**. Membership is a pure function of the block *set*, so every node builds the
  identical structure.
- **State is a Verkle tree.** A moving state root is the chain applying transactions — health,
  not drift.
- **Signatures are post-quantum** (MAYO), with an experimental cube-curve cryptography seam.
- **Contracts are native.** Write in **LNG**, compile to WASM, and the **XCL** runtime places
  the contract at a cubic-ledger coordinate and runs it in the hardened compute sandbox against
  Verkle state — no module re-implements another's job: `contracts` owns the language + binding,
  `storage-compute` owns the sandbox, `state-machine` owns the state.

Open the **[Explorer](apps/visualizer)** to watch this happen in real time (`npm run visualizer`).

## Layout

```
packages/   protocol modules (npm; the 8 core ones also ship as Rust crates)
crates/     Rust crates for the 8 protocol modules (crates.io)
apps/       end-user apps: the Explorer and the app builder
```

## Modules

The cryptic testnet names are gone. Each protocol module is one npm package and one crate.

| npm package (`packages/`) | Rust crate (`crates/`) | was | what it is |
|---|---|---|---|
| `@xmbl/core` | `xmbl-core` | core | Node runtime orchestrating every module below. |
| `@xmbl/identity` | `xmbl-identity` | xid | MAYO post-quantum identity & signatures; cube-curve crypto seam. |
| `@xmbl/networking` | `xmbl-networking` | xn | libp2p P2P layer: discovery, gossip, routing, NAT traversal. |
| `@xmbl/cubic-ledger` | `xmbl-cubic-ledger` | xclt | The cube-curve ledger: blocks → 9-block faces → 3-face cubes. |
| `@xmbl/state-machine` | `xmbl-state-machine` | xvsm | Sparse Verkle-tree virtual state machine. |
| `@xmbl/consensus` | `xmbl-consensus` | xpc | User-as-validator consensus; five-stage mempool; sealing. |
| `@xmbl/storage-compute` | `xmbl-storage-compute` | xsc | P2P storage with availability proofs + the hardened WASM compute market. **Where contracts execute** (composes state-machine + contracts). |
| `@xmbl/zero-knowledge` | `xmbl-zero-knowledge` | xzk | ZK cube-curve state-commitment (FRI). **Experimental, unaudited.** |
| `@xmbl/contracts` | *(npm/WASM only)* | lng + XCL | The smart-contract module: the **LNG** language (→ Solidity/EVM and → WASM) and the **XCL** runtime that binds compiled contracts to cubic-ledger coordinates and Verkle state. |

App / tooling modules (npm / web only):

| package | was | what it is |
|---|---|---|
| `@xmbl/cli` | xcli | Command-line interface to every module. |
| `@xmbl/visualizer` (`packages/visualizer`) | xv | Visualizer library: status server + Three.js scene helpers. |
| `@xmbl/explorer` (`apps/visualizer`) | new | Live, educational 3D cube-curve **app** — connects to any node, demo fallback. |
| `@xmbl/simulator` | xsim | Deterministic + chaotic network simulator for tests. |
| `@xmbl/browser-extension` | xbe | Full-client wallet/node browser extension. |
| `@xmbl/desktop-app` | xda | Electron full-client wallet/node. |
| `xmbl` (`apps/app-builder`) | ../xmbl | The XMBL app builder (Vue 3) and its `.xmbl` type system. |

## Provenance

- The eight protocol modules were taken from the actively-developed, drift-hardened bundle
  (cubic cryptography, deterministic cube rebuild, NAT-crossing convergence).
- `cli`, `simulator`, `browser-extension`, `desktop-app` came from the testnet source.
- `app-builder` is the `../xmbl` builder with its `.xmbl` types.
- `contracts` merges the `../lng` language (ported to ESM with its full conformance suite) with
  the XCL architecture from `docs/agentic-contracts-proto.md`, wired to storage-compute + state-machine.

## Develop

```bash
npm install                 # links the workspace
npm run build               # build all packages that define a build
npm test                    # test all packages
npm run visualizer          # serve the Explorer at http://localhost:5180
npm run app-builder         # run the app builder

cargo build --workspace     # build the Rust crates
cargo test  --workspace     # test the Rust crates
```

## Release

One version line for all `@xmbl/*` protocol packages and `xmbl-*` crates, cut by pushing a
semver tag. See [RELEASING.md](RELEASING.md).

## License

MIT — see [LICENSE](LICENSE).
