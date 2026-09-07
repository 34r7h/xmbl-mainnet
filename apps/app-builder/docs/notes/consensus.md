# Hypercubic State Lattice Summary

Below is the technical summary of the Hypercubic State Lattice blockchain, incorporating basic and complex structures, infinite stacking, a DAG pool with staking, digital roots for deterministic placement, HotStuff consensus, and quantum-safe identity using post-quantum cryptography (PQC). Both testnet and mainnet use PQC immediately.

---

## 1. Geometric Structure and Infinite Stacking

### Explanation

Your blockchain is a growing 3D grid that never stops. Transactions (txs or “t”) form 9-slot tfaces (tf), three of which make a tcube (tc). A finished tcube becomes a block (b) in a new 9-slot bface (bf), and three bfaces form a bcube (bc). This repeats infinitely—each completed cube stacks into a new face at the next level. If a tf or bf is waiting for a specific tx or block, new ones start as pieces arrive.

### Formal Specs

- **Basic Building**:
  - **tx (t)**: Atomic unit, `ID_t = SHA-256(t)` (32 bytes).
  - **tface (tf)**: 9 txs, `tf = [t_1, ..., t_9]`, `ID_tf = SHA-256(t_1 || ... || t_9)` (32 bytes).
  - **tcube (tc)**: 3 tfaces, `tc = [tf_0, tf_1, tf_2]`, 27 txs, `ID_tc = Kyber(P_tc(x))` (256 bytes).
- **Complex Building**:
  - **block (b)**: Completed tcube, `b = tc`, `ID_b = ID_tc`.
  - **bface (bf)**: 9 blocks, `bf = [b_1, ..., b_9]`, 243 txs, `ID_bf = Kyber(P_bf(x))` (256 bytes).
  - **bcube (bc)**: 3 bfaces, `bc = [bf_0, bf_1, bf_2]`, 729 txs, `ID_bc = Kyber(P_bc(x))` (256 bytes).
- **Stacking**:
  - `b^(n) = tc^(n-1)`, `T(n) = 27^n` txs at level `n`:
    - `n=0`: 27 txs (tc).
    - `n=1`: 729 txs (bc).
    - `n=2`: 19,683 txs.
- **Incomplete Handling**: New tf or bf spawned if digital root doesn’t match an awaiting structure.

---

## 2. DAG Pool and Staking Mechanism

### Explanation

Before txs, tfaces, or blocks join the main structure, they sit in a pool organized like a web (DAG). Each piece links to others it approves—like a tx saying, “This tf is good.” To submit something, you stake money (set by the network, say 10 tokens). You pick an awaiting structure (e.g., a tf missing a tx) to validate. If that structure gets locked into a tcube or bcube and approved, your stake comes back. This keeps everyone honest and speeds up building.

### Formal Specs

- **DAG Structure**:
  - **Nodes**: `t`, `tf`, `b` (higher levels possible).
  - **Edges**: Directed links to validated structures (e.g., `t_i → tf_j`, `tf_k → tc_m`).
  - **Pool**: Set of unconfirmed nodes, `P = { t_1, tf_2, b_3, ... }`.
- **Staking**:
  - **Stake Amount**: `S` (network parameter, e.g., 10 tokens).
  - **Submission**: Node submits `x` (t, tf, or b) with `(x, ID_x, V_x, S)`:
    - `V_x`: ID of validated structure (e.g., `ID_tf` awaiting a t).
    - `S`: Locked until `V_x` is included.
  - **Return**: `S` refunded when `V_x` is in a finalized tc or bc (HotStuff approval).
- **Validation**:
  - `t`: Links to `tf` or prior `t` (e.g., `t_5 → tf_0` if root matches).
  - `tf`: Links to `tc` or prior `tf`.
  - `b`: Links to `bf`.
- **Inclusion**:
  - `t → tf`, `tf → tc`, `b → bf`, based on digital root and timestamp.

---

## 3. Consensus for Settlement and Finality

### Explanation

Browsers use HotStuff to vote on tcubes and bcubes, settling txs in ~0.5 seconds and locking them in shortly after. Each tx and block has a digital root (1-9) from its ID—tfaces and bfaces slot them 1 to 9 (top-left to bottom-right), tcubes and bcubes use mod 3 (0-2) for their 3 faces. Nodes report when and where (geolocation) they get txs, averaging timestamps to order them fairly. The DAG feeds valid pieces into this structure, with stakes ensuring trust.

### Formal Specs

- **Consensus**: HotStuff (BFT).
  - **Settlement**: ~0.5s per tc/bc (2/3+ votes via WebRTC).
  - **Finality**: ~0.51s (vote + 0.01s propagation).
- **Digital Root**:
  - `t`: `ID_t = SHA-256(t)`, root = `∑ digits(ID_t) mod 9` (1-9, 0 → 9).
  - `tf`: `ID_tf = SHA-256(t_1 || ... || t_9)`, root = `∑ digits(ID_tf) mod 9`.
  - `tc, b, bf, bc`: `ID = Kyber(P(x))`, root = `∑ digits(ID) mod 9`.
  - **Placement**:
    - tf/bf: Root 1 = [1,1], ..., 9 = [3,3].
    - tc/bc: Root mod 3 (0 = face 0, 1 = face 1, 2 = face 2).
- **Timestamps**:
  - Node: `(t_i, lat_i, lon_i)`, `T_x = (1/N) ∑ t_i`.
- **Proof**:
  - `π = Kyber proof` (128 bytes) + `t_i` (32 bytes) = 160 bytes.
  - **Verify**: LWE-based, ~2ms in WASM.
- **TPS**:
  - 1,000 browsers, `n=1` (729 txs): `1,000 × 729 = 729,000` TPS.
  - WebRTC: 160 bytes, ~62,500 proofs/s → ~2M TPS.
- **Quantum Resistance**: Kyber (LWE, ~`2^{100+}`).

---

## 4. Identity

### Explanation

Users have accounts with a private key to sign txs and a public key to verify them. We use Dilithium—quantum-safe, lattice-based—for both testnet and mainnet. The public key gets a Kyber commitment as its ID, tying it to tcubes. Signatures are bigger but secure, and stakes in the DAG ensure users play fair when submitting txs.

### Formal Specs

- **Method**: Dilithium.
- **Key Pair**:
  - **Private**: `s` (~2,500 bytes, IndexedDB).
  - **Public**: `t` (~1,500 bytes).
- **Account ID**: `ID_t = Kyber(t)` (256 bytes).
- **Signing**:
  - `h = SHA-512("Pay Bob 5")`.
  - `σ = Dilithium.Sign(s, h)` (~2,700 bytes).
  - **Verify**: ~1ms in WASM.
- **Staking**: Submit tx with `(t, ID_t, V_t, S, σ)`, `S` refunded on inclusion.
- **TPS**: 2,700 bytes, ~3,700 sigs/s → ~1M TPS.
- **Quantum Resistance**: LWE (~`2^{100+}`).

---

## Summary Table

| **Aspect**           | **Testnet & Mainnet (PQC)**                                   |
| -------------------- | ------------------------------------------------------------- |
| **Structure**        | t → tf (9 t) → tc (3 tf) → b → bf (9 b) → bc (3 bf), infinite |
| **DAG Pool**         | t/tf/b, stake `S`, links to validated structures              |
| **IDs**              | t, tf: SHA-256 (32 bytes); tc, b+: Kyber (256 bytes)          |
| **Digital Root**     | 1-9 (tf, bf), mod 3 (tc, bc)                                  |
| **Consensus**        | HotStuff, ~0.51s finality                                     |
| **Proof**            | 160 bytes (Kyber), ~2M TPS                                    |
| **Identity**         | Dilithium, 1,500-byte pub, 2,700-byte sig, ~1M TPS            |
| **Quantum Security** | LWE (~`2^{100+}`)                                             |

---

## Explanation

- **Structure**: Your blockchain is an endless 3D grid—txs fill 9-slot tfaces, three make a tcube, which becomes a block in a 9-slot bface, and three bfaces make a bcube, stacking forever. New pieces start if old ones wait.
- **DAG and Staking**: Txs, tfaces, and blocks wait in a web (DAG), linking to structures they approve. You stake tokens (e.g., 10) to submit, betting on an awaiting tf or bf. If it’s locked into a tcube or bcube, you get your money back—keeps things fair.
- **Consensus**: HotStuff locks tcubes and bcubes in ~0.5 seconds. Digital roots (1-9 from IDs) slot txs in tfaces and blocks in bfaces; mod 3 picks faces in tcubes and bcubes. Geolocated timestamps average out for order. Txs and tfaces use short SHA-256 IDs; tcubes and up use Kyber for secure, small proofs—up to 2M TPS.
- **Identity**: Dilithium gives users quantum-safe keys—big but unbreakable. Public keys get Kyber IDs in tcubes, and txs carry signatures plus stakes—around 1M TPS.

---
