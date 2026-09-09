# XMBL whole-protocol threat model (audit prep — T2.6)

**Status: PRE-AUDIT REVIEWER PACKAGE.** The per-module audit-prep documents (T2.1–
T2.5) each attack one component. This document is the **composition** view an
external reviewer needs and no single-module doc provides: how the modules stack,
where the trust boundaries are, and the **economic / DoS / cross-module** surface
that emerges only when the pieces run together. It claims nothing secure; it maps
the attack surface and states, without softening, what is unresolved. The
whole-protocol ⛔ AUDIT gate (`MAINNET-GATES.md` Cross-cutting) stays open until a
signed external review closes it.

Companion documents (read alongside):
`../packages/identity/MAYO-PROVENANCE.md` (T2.1),
`xmbl-cubic-cryptography-whitepaper.md` (T2.2/T2.3 — curve, LWE),
`../packages/storage-compute/COMPUTE-ISOLATION-THREAT-MODEL.md` (T2.4),
`../packages/zero-knowledge/FRI-SOUNDNESS.md` (T2.5).

---

## 1. Module stack and dependency direction

Ten protocol packages (the five apps — `cli`, `desktop-app`, `browser-extension`,
`visualizer`, `simulator` — are out of scope for this protocol threat model):

```
                 ┌──────────────────────────────────────────────┐
   @xmbl/core ── │ node runtime: wires everything, owns start()   │
                 └──────────────────────────────────────────────┘
        │ composes
        ├── @xmbl/networking      libp2p P2P transport (gossip, discovery)
        ├── @xmbl/consensus       user-as-validator, 5-stage mempool, SEALING
        ├── @xmbl/cubic-ledger    blocks → faces → cubes (the ledger geometry)
        ├── @xmbl/state-machine   Verkle virtual state, root commitment
        ├── @xmbl/identity        MAYO (PQ sig) + Cubic-SIG/LWE + seal + delegation
        ├── @xmbl/storage-compute P2P storage + PAID untrusted-WASM compute market
        │        └── @xmbl/contracts (XCL)  injected host over the compute runtime
        │                 └── @xmbl/lng      contract language → WASM/EVM
        └── @xmbl/zero-knowledge  experimental FRI state commitment (FIREWALLED)
```

**Dependency hygiene (verified this session).** `state-machine` owns *state only* —
its duplicate insecure `WASMExecutor` was deleted; **all** untrusted-WASM execution
is `storage-compute`'s. `contracts` does not import `storage-compute` for a cycle;
the runtime is **injected** (`ComputeNode.contractHost`), so `storage-compute` never
reaches up to `contracts`. This one-directional wiring is a load-bearing property:
it keeps the untrusted-execution sandbox in exactly one place.

---

## 2. Trust boundaries (where untrusted data crosses into trusted code)

| # | Boundary | Untrusted input | Enforcement | Ref |
|---|----------|-----------------|-------------|-----|
| B1 | Network ingress | peer gossip (txs, proposals, blocks) | consensus ingress guard + invalid-eviction | consensus |
| B2 | Seal agreement | peers' `(setHash, memberIds)` | QUORUM over the **fixed** configured lead set | §3, consensus |
| B3 | Compute market | third-party WASM + args | Worker-thread sandbox (termination, memory, deny-imports) | T2.4 |
| B4 | Contract host-hook | contract WASM guest | in-worker staged read-set / collected write-set; **host source is trusted caller code** | T2.4 §4 |
| B5 | State proof | attacker-supplied Verkle `proof` | **independent** verifier binds to the tree's real root, never `proof.root` | state-machine |
| B6 | Signature verify | attacker sigs/pubkeys | MAYO (PQ) / Cubic-SIG (classical, secp256k1) | T2.1, T2.2 |
| B7 | Sealed value | sealed envelopes | Cubic-LWE KEM, `seal.js` fails closed below N=729 | T2.3 |

The two boundaries most likely to be underestimated are **B2** (seal = a
*selection*, not an idempotent predicate — see §3) and **B4** (the sandbox is void
if untrusted input ever reaches `host.source`).

---

## 3. Consensus / sealing — the highest-severity surface

Sealing is where a safety bug is **unrecoverable** (a fork of the ledger itself),
so it is the top of the threat model.

- **Established property (tested).** Honest seal-leads converge on ONE sealed
  set-hash or safely STALL; they never seal two different sets for one face — proven
  by driving the real `SealRoundManager` over a partitioned gossip bus (equivocation,
  withheld data, partition-heal).
- **Real defect found + fixed this session (f=0 permanent fork).** `_sealQuorum`
  divided the strict-majority threshold by the **presence-live** lead subset, so a
  partition shrank the denominator and each side sealed a different face → a
  **permanent fork with no Byzantine node** (on heal neither side can `adoptSet` the
  other; the members already left the pool). Fixed: the denominator is the **fixed
  configured lead set** (`sealQuorumFrom(_leadAllowlist)`), so `2·quorum > n` always
  and two disjoint partitions can never both seal. **Mainnet multinode REQUIRES
  `XPC_LEAD_ALLOWLIST`** (the genesis validator set); with no allowlist the node is
  single-node dev (quorum 1).
- **The load-bearing insight for auditors:** a *validation* quorum is a **predicate**
  (idempotent, safe to shrink under partition — a liveness aid); a *seal* quorum is a
  **selection** (which set BECOMES this face — shrinking it manufactures divergent
  winners). Any future change that makes the seal denominator dynamic/presence-based
  reintroduces the fork. This is the single most important invariant in the protocol.
- **Open (O-C1):** the fix assumes `XPC_LEAD_ALLOWLIST` is correctly provisioned as
  the genesis validator set on every mainnet node; a misconfigured/asymmetric
  allowlist across nodes is a governance/deployment risk the code cannot self-check.

---

## 4. Economic & DoS surface (emerges only in composition)

This is the surface no single-module doc covers.

- **E1 — Compute market has no metered billing (from T2.4/C1).** `MarketPricing` is
  exported but **never called**; execution measures no duration/memory and returns no
  price. A node sells CPU/memory with **no measured, tamper-evident basis to charge**,
  and an over-deadline job that is terminated still consumed real resources that go
  unbilled. For an economic surface this is a **critical composition gap**: the
  "market" is currently an unmetered sandbox.
- **E2 — Aggregate resource exhaustion (from T2.4/O1,O2).** Every sandbox guarantee
  is per-job; there is no aggregate admission control and each job spawns a fresh
  Worker. A flood of small jobs is a thread-creation + memory-multiplication DoS at
  the node level, distinct from the per-job caps. A scheduler with total-resource caps
  must sit above `storage-compute`.
- **E3 — Mempool / ingress DoS.** The 5-stage mempool has an ingress guard and
  invalid-eviction, but the whole-protocol review must confirm the economic cost to a
  submitter of forcing validation work (signature checks, geometry, LWE) is priced
  above the node's cost to reject — otherwise cheap-to-send / expensive-to-verify txs
  are an asymmetric DoS. **Not quantified in-repo.**
- **E4 — Sig-verify asymmetry.** MAYO verification and Cubic-LWE seal-open are
  non-trivial CPU; an attacker sending many invalid signatures/envelopes forces work.
  Ingress ordering (cheap structural checks before expensive crypto) should be audited.
- **E5 — Networking/transport (refiled ⛔ INTEGRATION gate).** Discovery under NAT,
  gossip fan-out, and eclipse/partition behaviour are integration-level and interact
  directly with §3 (a partition the network layer permits is what the seal quorum must
  survive). Not closable in unit tests.

---

## 5. Cross-module composition risks

- **X1 — ZK firewall must hold.** `zero-knowledge` (FRI) is EXPERIMENTAL with ~8–24
  bit soundness (T2.5) and **must not gate consensus, ledger, or sealing.** The
  composition review must confirm no code path lets an `xzk` verdict influence B2/B5.
  Today it is a standalone commitment demo; keeping it non-load-bearing is a
  *composition* property, not a module-local one.
- **X2 — Contract determinism (from T2.4/O5).** If contract results feed consensus,
  every validator must recompute the same result; nondeterministic sources
  (`Date`, RNG, float NaN bits, host-hook `Date.now`) must be denied on the contract
  path. The deny-by-default import policy blocks host imports but does not screen
  WASM-internal nondeterminism or the host module's own clock/RNG use.
- **X3 — Identity is the root of everything.** MAYO signs identities/txs (T2.1, an
  unaudited fork pending byte-repro), Cubic-SIG is **classical-only** (Shor-breakable),
  Cubic-LWE guards sealed value. A break in identity composes downward into every
  boundary (B6/B7). The classical/PQ split must be explicit at every call site so no
  value path silently depends on a Shor-breakable signature.
- **X4 — State-proof independence (good, keep it).** The Verkle verifier is a
  from-scratch reconstruction bound to the real root — a mutation shared by
  prover+verifier is caught. This is the model the other verification boundaries
  should imitate; the review should confirm no shortcut reintroduces prover==verifier
  code sharing at B5.

---

## 6. Consolidated open items for the whole-protocol review

| # | Item | Severity | Source |
|---|------|----------|--------|
| O-C1 | `XPC_LEAD_ALLOWLIST` provisioning correctness across nodes | High (fork governance) | §3 |
| E1 | Compute market unmetered — no billing basis | High (economic) | T2.4/C1 |
| E2 | No aggregate compute admission control (thread/memory flood) | High (DoS) | T2.4/O1,O2 |
| E3/E4 | Ingress cost asymmetry (cheap-send / expensive-verify) not priced | Med–High (DoS) | §4 |
| E5 | Transport: NAT discovery, gossip fan-out, eclipse | High (integration) | networking ⛔ |
| X1 | Keep FRI firewalled from consensus/ledger/sealing | High if breached | T2.5 |
| X2 | Contract-path nondeterminism unscreened | High if contracts gate consensus | T2.4/O5 |
| X3 | Classical vs PQ signature boundaries must be explicit per call | High | T2.1/T2.2 |
| B4/C2 | Host-hook `eval` safe only if source is trusted-caller | High if breached | T2.4/C2 |
| — | 6 module ⛔ AUDIT reviews + reproducible MAYO byte-build (T2.1-b) | blockers | MAINNET-GATES |

**Bottom line for the reviewer.** The protocol's *safety* core is in good shape —
sealing has a tested no-fork property and a real fork defect was found and fixed;
state proofs use an independent verifier; untrusted execution is isolated to one
sandbox. The unresolved weight is concentrated in three areas: **(1) the economic /
DoS surface of the compute market and mempool (E1–E4), which is largely unbuilt or
unmetered; (2) the novel/experimental crypto (cubic curve, LWE findings, FRI
soundness) still awaiting external cryptanalysis; and (3) integration-level
transport and deployment governance (E5, O-C1) that unit tests cannot close.** This
document claims nothing secure; it is the map the external audit works from.
