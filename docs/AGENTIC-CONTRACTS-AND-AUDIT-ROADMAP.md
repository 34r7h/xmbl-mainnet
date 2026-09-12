# XMBL smart contracts for agentic use — architecture and external-audit roadmap

This document has two jobs:

- **Part I** explains *how* the XMBL contract layer (XCL + the LNG language) is built so that an
  autonomous **agent** can be handed contract authority safely — the delegation, authorization,
  isolation, and composition properties that make agent-driven contracts *at least as powerful as
  Ethereum's while being structurally safer*, and cites the load-bearing code for each.
- **Part II** is the operator-facing roadmap for the remaining **external audits** — the gates that
  cannot be closed inside this repository. For each: scope, the in-repo prep artifact that feeds the
  reviewer, the findings already surfaced for them, the specific lines of code under review, what
  starts the engagement, and the deliverable that closes the gate.

It is a routing document. The substance — the whitepaper, the threat models, the provenance record —
is already authored in-repo (see the cross-references). Line citations are `file:line` and were
verified against the tree at the time of writing; re-grep the named symbol if the file has since moved.

Status of the gates it routes: **14 open** in `MAINNET-GATES.md` — **7** external ⛔ AUDIT gates
(Part II, Audits 1–7), plus the `1.0.0`-release policy row (`MAINNET-GATES.md:443`) that stays open
until those 7 close; the remaining 6 are in-repo or operator decisions. `AUDIT_GATES_OPEN`
(`packages/core/index.js:14`) is `true`, so a
`XMBL_PROFILE=mainnet` boot is refused (`packages/core/index.js:150`) until the audits close.

---

## Part I — How the contracts are made for agentic use

### 0. What "agentic use" means here

An **agent** is an automated principal — a process acting on a user's behalf — that deploys, calls,
and composes contracts without a human in the loop for each action. Handing a long-lived key to such
a process is exactly what you must not do. XMBL's design answer is a **tiered, attenuated,
single-use** authority chain plus a contract runtime where the dangerous cross-contract behaviours
are *inexpressible*, not merely guarded. The rest of Part I walks the chain from the root key down to
a single contract call, then the runtime properties that hold once the call runs.

### 1. The delegation chain — root key never touches the contract

Authority flows through four tiers, each cryptographically bound to the next, so the agent that
finally calls a contract holds only a **narrow, short-lived, revocable** credential:

```
root MAYO identity  →  TEE coordinator  →  scoped short-TTL Zero-Standing-Privilege token  →  agent action-signature
```

`verifyChain` (`packages/identity/src/delegation.js:184`) enforces **every** hop: each presented
public key must derive to the address it claims, each signature (grant, token, action) must verify,
the token scope must be a subset of the grant scope (**attenuation** — `delegation.js:113`), the
audience must bind, and expiry/revocation must hold. A single failed hop rejects the whole
presentation. The agent can therefore be given a token that authorizes *only* `transfer` on *one*
contract for *ten minutes* — and nothing it does can widen that.

### 2. Single-use authorization — no replay, no double-spend

`makeAuthorizer` (`delegation.js:292`) wraps `verifyChain` and then **consumes** the action's
`(tokenHash, nonce)` pair exactly once (`delegation.js:301`): a re-presented signed action is rejected
`action-replayed`. For a real deployment the nonce ledger is durable and shared —
`DurableNonceRegistry` (`packages/identity/src/durable-nonce-registry.js:28`) backs `consume`
(`durable-nonce-registry.js:57`) with a single `INSERT OR IGNORE` against a UNIQUE key
(`durable-nonce-registry.js:41`), a real compare-and-set: the first writer wins, and every later
one — this process, a prior run, or **another node sharing the file** — loses. So two nodes cannot
both accept the same signed agent action even though JS is single-threaded, and single-use survives a
restart. This is the property that lets an agent's action be *fire-and-forget* without risking a
replay draining the same authority twice.

### 3. Fail-closed gating at the contract seam

A contract deployed `{ gated: true }` (`packages/contracts/src/xcl/contract-host.js:64`) runs a state
transition **only** when the injected authorizer passes for it. The check is load-bearing and runs
*before any WASM executes* (`contract-host.js:186`): an unauthorized, out-of-scope, or revoked call
is refused and leaves state untouched, and — critically — **a gated contract with no authorizer
configured cannot be called at all** (`contract-host.js:187`), so a misconfiguration fails closed,
never open. An agent's authority is thus checked at the door on every entry, not assumed.

### 4. Reentrancy is inexpressible, not guarded

The EVM's most infamous class of exploit (the DAO drain) exists because a contract can yield control
to another contract's code *mid-execution*. XMBL removes the primitive. A contract interacts with
another through exactly two operations:

- **`xmbl_read(peer, field)`** — a *synchronous* cross-contract state read that executes **no** peer
  code. It is served from a **pre-staged, declared** read footprint, so it adds no call frame and
  carries zero reentrancy risk. Word-ABI binding: `abi.js` `HOST_ABI_COMPOSE_SOURCE_WORD`
  (`packages/contracts/src/xcl/abi.js:414`); lowered from `~contract` source by the WASM backend at
  `packages/lng/src/compile-wasm.js:533`.
- **`xmbl_send(peer, arg, …)`** — an *asynchronous* message whose target runs as a **separate frame
  after** the sender completes, never nested (`abi.js` send binding within
  `HOST_ABI_COMPOSE_SOURCE_WORD`; lowered at `compile-wasm.js:494`). A message can now carry one or
  more `~u256` arguments in a single frame.

The host runs the entry call plus every message it transitively emits as **one atomic transaction**
(`contract-host.js` cascade, `_runFrame` + the FIFO drain around `contract-host.js:218`): a shared
overlay gives read-your-writes across frames, a frame cap makes a runaway cascade terminate in a
revert, and any frame that throws reverts the whole cascade. Because a contract can never re-enter
another mid-execution, the classic reentrancy attack is not defended against — it **cannot be
written**. (What remains the author's responsibility is cross-frame *sequencing*, the ordinary
actor-model hazard; that scope is stated honestly in `MAINNET-GATES.md` T6.2c.)

### 5. Declared read footprints — capabilities are bounded up front

An agent-authored contract does not get to read arbitrary state. Its synchronous read footprint is
**declared at wiring time** via `link()` (`contract-host.js:113`), which range-checks each
`(peer, field)` against the peer's deployed, **compiler-derived** field list. The field list is not
operator-typed — `@xmbl/lng` exports `contractFields(src)` (`compile-wasm.js:570`) so the list is
authoritative by construction and cannot be transposed to silently resolve the wrong field. An
**undeclared** read *traps* and reverts (fail-closed), never returns a silent zero. This is strictly
stronger than an EVM `STATICCALL`, which can read anything at any depth with no static bound — a
material property when the contract author is an automated agent rather than an audited human.

### 6. Value conservation — contracts link UTXOs to the Verkle state, fail-closed

A contract can spend committed XMBL UTXOs and create new ones in the *same* Verkle tree the state
machine commits to (UTXO ABI: `abi.js` `HOST_ABI_UTXO_SOURCE`, `abi.js:483`). The security property —
value cannot be minted — is enforced by the **host**, not the guest: after the run and *before* any
write lands, `ContractHost` sums spent inputs against created outputs plus fee
(`contract-host.js:232`–`243`) and refuses a transaction where `out > in`, applying nothing (root
unmoved — the rule is stated at `contract-host.js:90`). Spends are nullifier-keyed, so a double-spend is simply a key that
already exists. An agent moving value therefore cannot mint, cannot double-spend, and cannot leave
the tree in a non-conserving state — the host rejects it atomically.

### 7. Determinism — the same call is the same on every node

On-chain code must be a pure function of inputs and committed state, or nodes diverge. Both LNG
backends refuse a contract that reads wall-clock time or randomness (the determinism gate, enforced
in `@xmbl/lng`). Crypto verification material is **chain-staged** (identical on every node), so a
verdict is identical everywhere; the guest supplies only the message. This is what lets an agent's
contract be reproduced and proven, not just executed.

### 8. Metering and billing — an agent pays for what it uses, and cannot DoS for free

A paid execution surface that an agent drives must bill honestly. The compute worker measures real
per-thread CPU time and peak WASM-linear memory, and now also **meters the V8 heap**
(`heapUsedBytes`, `packages/storage-compute/src/compute.js:189`). A job **killed at the deadline** is
no longer free: the runtime attaches maximum-charge metrics to the deadline rejection
(`compute.js:293`) and `ComputeNode.runJob` bills it (`packages/storage-compute/src/compute-node.js:84`,
returning `killed:true, billed:true`). An agent running an infinite loop pays for the slot it held —
closing the E1/E2 economic-DoS hole in the isolation threat model.

### 9. The mainnet boot gate

None of the above ships to mainnet while the external audits are open. `start()` refuses an
`XMBL_PROFILE=mainnet` boot whenever `AUDIT_GATES_OPEN` is true (`packages/core/index.js:150`); there
is no env override — opening mainnet is a *reviewed source change* flipping the constant
(`packages/core/index.js:14`), made only when Part II's gates close.

### Worked example — an agent calls a gated transfer

1. A user's root MAYO identity grants a TEE coordinator a scoped grant.
2. The coordinator mints a **10-minute** Zero-Standing-Privilege token scoped to `transfer` on
   contract `C`, and hands it to the agent.
3. The agent signs a `transfer` action with a fresh nonce and presents `{grant, token, action}`.
4. `ContractHost.call(C, 'transfer', …)` runs the gate: `verifyChain` checks every hop, scope ⊆ grant,
   audience, expiry; `makeAuthorizer` burns the nonce (replay → `action-replayed`).
5. The WASM runs; if `transfer` messages another contract, that peer runs as a **later frame**, never
   nested; any synchronous balance read is from the **declared** footprint.
6. The host checks value conservation over the whole cascade and commits atomically, or reverts.
7. The compute node meters and prices the job; a killed job is still billed.

Every step is a cited seam above. The agent never held a standing key, never exceeded its scope, could
not replay, could not re-enter, and could not mint.

---

## Part II — Remaining external audits (the ⛔ gates)

These cannot be closed in-repo: they require a signed report from an independent reviewer. The repo's
job — **done** — is to hand each reviewer a complete, honest attack-target package (the T2.x prep
deliverables) that states its own assumptions and pre-discloses its own weaknesses. Nothing external
starts until the matching prep item is `[x]`; all are.

> **Common engagement shape.** Each audit: (a) select a qualified reviewer for the named domain;
> (b) give them the prep doc + the cited code + this section's findings; (c) receive a signed report;
> (d) address findings in-repo; (e) mark the gate `[x]` **only** on the signed report — never on our
> own say-so (the code keeps `secure/audited = false` until then). No `1.0.0` until all are closed
> (`MAINNET-GATES.md:443`).

### Audit 1 — MAYO signature fork (`MAINNET-GATES.md:24`)

- **Scope.** MAYO is a post-quantum signature scheme; we ship a *fork* of the reference C, compiled to
  WASM. The port and its build must be reviewed before value binds to it.
- **Prep doc.** `packages/identity/MAYO-PROVENANCE.md` (T2.1-a/-b/-c): upstream pin
  **PQCMayo/MAYO-C @ `4b7cd94c96b9522864efe40c6ad1fa269584a807`**, MAYO_1 `opt` param set, verified
  byte-identical for 39/40 files of the compiled subtree.
- **Findings already surfaced.** Exactly one file differs from upstream (`fips202.h` `shake256`
  `int`→`void`, matching upstream's own definition — a stale-forward-declaration build fix, zero
  algorithm change; diff committed as `packages/identity/mayo-cube/mayo-fork.diff`).
- **Code under review.** `packages/identity/wasm-wrapper.js` (`verifySync` sync twin used by the
  contract crypto host), `packages/identity/mayo-cube/`, and the vendored `mayo.wasm`.
- **Resources.** Upstream repo at the pinned commit; the NIST PQC MAYO specification.
- **Starts / closes.** Starts once T2.1-b's byte-identity is resolved (see operator decision below).
  Closes on a third-party review of the fork + a reproducible build.

### Audit 2 — Cubic-curve construction (`MAINNET-GATES.md:26`)

- **Scope.** Cubic-SIG / Cubic-KEM: elliptic-curve parameter material derived from the cube-of-cubes
  ledger geometry. Novel, with no external cryptanalysis.
- **Prep doc.** `docs/xmbl-cubic-cryptography-whitepaper.md` — `CubicCurveSource` specified step by
  step (§3), cryptanalysis assumptions **A1–A3** and open questions **O1/O2** (§2, including the honest
  finding that derived curves get **no** group-order / weak-curve screening), Cubic-SIG's
  EUF-CMA-under-ECDLP-in-ROM reduction (§5.2).
- **Findings already surfaced.** Cubic-SIG signs on **standard secp256k1** (`a=0`), so its group
  security is *inherited, not novel* — the reduction is explicit that novelty is confined to the
  derivation, not the signing group. No self-claim of security: `CubicCurveSource.describe()` reports
  `secure:false, audited:false` (`packages/identity/src/curve-source.js`).
- **Code under review.** `packages/identity/src/curve-source.js`, `packages/identity/src/cubic-sig.js`.
- **Resources.** The whitepaper §2/§3/§5.2; a curve-security screening tool (SEA point-counting) for
  the missing weak-curve check.
- **Starts / closes.** Starts now (prep complete). Closes on external cryptanalysis of the derivation
  and a resolution of O1/O2 (weak-curve screening).

### Audit 3 — Cubic-LWE construction (`MAINNET-GATES.md:68`)

- **Scope.** The lattice KEM behind value seals: ternary matrix-LWE over the cube ring, N=729.
- **Prep doc.** `docs/xmbl-cubic-cryptography-whitepaper.md` §4 — N=729/q=3329 rationale, ternary-η=1
  construction, an empirically-verified decryption-failure analysis (noise σ≈25.4, ≈32σ margin to
  q/4).
- **Findings already surfaced.** **M1** the ternary sampler's 86/85/85 modulo bias; **M2** the KEM is
  **IND-CPA only** (no Fujisaki–Okamoto transform ⇒ not IND-CCA2); the in-source 2^168 Core-SVP claim
  is flagged **unverified-in-repo** (reproduce via the lattice estimator). Enforcement: `sealSecret`
  fails closed below N=729 (`packages/identity/src/seal.js:68`, `MIN_SEAL_N`, `seal.js:32`).
- **Code under review.** `packages/identity/src/cubic-lwe.js`, `packages/identity/src/seal.js`.
- **Resources.** The whitepaper §4; the lattice estimator (Albrecht et al.) to confirm the Core-SVP
  hardness estimate.
- **Starts / closes.** Starts now. Closes on external cryptanalysis + M1/M2 dispositions (a CCA2
  transform if value must survive active attackers).

### Audit 4 — Compute-market isolation (`MAINNET-GATES.md:94`)

- **Scope.** The compute market is a paid surface running untrusted WASM; its isolation model
  (side-channels, resource accounting, worker escape) needs review before untrusted pay.
- **Prep doc.** `packages/storage-compute/COMPUTE-ISOLATION-THREAT-MODEL.md` — trust boundaries and the
  enforced+tested properties (cross-thread termination, bounded WASM/V8 memory, deny-by-default
  imports).
- **Findings already surfaced.** **C1** metering→billing was disconnected — **now resolved**
  (per-thread CPU + WASM-linear peak measured and priced; **killed-job billing and V8-heap metering
  since closed**, `compute.js:189`/`:293`, `compute-node.js:84`); **C2** the host-source `eval` footgun
  (trusted-caller assumption); open **O1/O2** (no aggregate/concurrency admission control), **O3**
  (co-tenancy side/covert channels — Worker threads share the process), **O4** (fuzz the hand-rolled
  section parser), **O5** (contract-path determinism unscreened).
- **Code under review.** `packages/storage-compute/src/compute.js` (worker isolation, metering),
  `packages/storage-compute/src/compute-node.js` (pricing).
- **Resources.** The threat model; a WASM fuzzing harness for O4.
- **Starts / closes.** Starts now. Closes on a security review dispositioning C2 and O1–O5.

### Audit 5 — Zero-knowledge FRI (`MAINNET-GATES.md:108`)

- **Scope.** Experimental, unaudited FRI proof system. Must stay firewalled from consensus/ledger/
  sealing until audited (the `core` wiring enforces "additive only").
- **Prep doc.** `packages/zero-knowledge/FRI-SOUNDNESS.md` — shipped params (BabyBear p=15·2²⁷+1 31-bit
  field, K=32, N=128, ρ=1/4, nq=12) and concrete soundness: **~24 bits conjectured / ~8 bits provable**
  — a *demonstration* parameterisation, explicitly **not** 100/128-bit secure.
- **Findings already surfaced.** **F1** the 31-bit base field makes Fiat–Shamir challenges grindable at
  2³¹ (no extension field — the decisive gap); **F2** no grinding PoW / extension-field repetition;
  **F3** `friVerify` fold-consistency check has dead/degenerate logic needing hand-verification.
- **Code under review.** `packages/zero-knowledge/src/xzk.js` (`friVerify`), and `core`'s additive-only
  wiring (`_setupZkCommit`).
- **Resources.** FRI-SOUNDNESS.md; a ≥124-bit extension-field implementation for the required fix.
- **Starts / closes.** Starts now. Closes on a proof-system review after the extension-field + grinding
  changes; until then FRI must not gate anything.

### Audit 6 — Networking under adversarial conditions (`MAINNET-GATES.md:414`)

- **Scope.** Discovery under NAT, gossip fan-out rounds, and Kademlia routing-table poisoning
  resistance — behaviour of libp2p/WebTorrent reached through thin wrappers; **not** unit-testable
  against this module (it has no peer routing table of its own).
- **Prep doc.** Cross-referenced in `docs/WHOLE-PROTOCOL-THREAT-MODEL.md` (E5 transport/NAT); the
  in-package own-logic suite covers what this package *does* own (connection cap, deny-by-default
  routing, no self-dial).
- **Findings already surfaced.** These belong to the simulator/integration surface and the
  whole-protocol review; must **not** be closed with an in-package mock.
- **Code under review.** `packages/networking/src/connection.js`, `routing.js`, `discovery.js` (the
  wrappers), plus the integration/simulator harness.
- **Resources.** libp2p security guidance; a NAT/gossip integration testbed.
- **Starts / closes.** Folds into the whole-protocol engagement (Audit 7). Closes on an
  integration-level adversarial review.

### Audit 7 — Whole-protocol external security review (`MAINNET-GATES.md:434`)

- **Scope.** The composition view no single-module audit gives: the 10-module stack, one-directional
  dependency hygiene, the 7 trust boundaries, and the economic/DoS surface that only emerges in
  composition.
- **Prep doc.** `docs/WHOLE-PROTOCOL-THREAT-MODEL.md` — boundaries **B1–B7**, sealing as the
  highest-severity surface (the seal-is-selection-not-predicate invariant and the fixed fork defect),
  economic/DoS risks **E1–E5**, cross-module risks **X1–X4**; cross-references T2.1–T2.5.
- **Findings already surfaced.** E1 (compute unmetered — now measured), E2 (no aggregate admission
  control), E3/E4 (ingress cheap-send/expensive-verify asymmetry), E5 (transport/NAT); X1 (keep FRI
  firewalled), X2 (contract determinism), X3 (classical-vs-PQ sig boundaries), X4 (state-proof
  independence).
- **Code under review.** The full stack; highest-severity is `@xmbl/consensus` sealing
  (`_sealQuorum` / `sealQuorumFrom`, the fixed fork defect).
- **Resources.** WHOLE-PROTOCOL-THREAT-MODEL.md + all of T2.1–T2.5.
- **Starts / closes.** Starts after the per-module audits (1–6) so their findings feed it. Closes on
  one signed whole-protocol report — the last gate before `1.0.0`.

### Related external item — EVM backend deployment/audit (`MAINNET-GATES.md:124`)

Not a ⛔ crypto gate, but external: the LNG→Solidity backend output is structurally asserted and
solc-compiles, but is **not deployed to a live EVM chain or audited**. Closes on a testnet deployment
plus a Solidity-level review of the generated output.

---

## Appendix — non-external items that still block, and why they are not "just build it"

Two open gates are **operator decisions**, not code and not audits — the repo cannot close them alone:

- **Browser panel parity guard** (`MAINNET-GATES.md:125`). The hand-synced browser copies of the
  interpreter/EVM/WASM backends live in a *separate* repo (`handoff`); a CI guard that can actually
  fail must live either there (consuming published `@xmbl/lng`) or here (panels vendored in). Pick one;
  until then no in-repo code can close it.
- **`mayo.wasm` byte-identity** (`MAINNET-GATES.md:435`, `:457`). Functional reproducibility is done
  (`build-mayo-cube-wasm.sh`, `--check`); byte-identity is blocked because the shipped artifact's emsdk
  version was not recorded and a rebuild under the drifted toolchain is not byte-identical. Decide: pin
  the original emsdk, or adopt a freshly-built artifact as canonical.

Two more are **language-design tasks**, deliberately *not* attempted as wiring:

- **Emitting crypto verifiers from source** (T6.1-d, `MAINNET-GATES.md:212`) and **emitting
  `xmbl_utxo_*` from source** (T6.2(a), `MAINNET-GATES.md:286`) both require a new LNG **byte-string
  type**: the verifiers take a message as `(msg_ptr, msg_len)` and the UTXO ABI names ids/recipients as
  byte pointers, while the WASM backend's value model is 32-byte `~u256` words only, with no bytes
  surface. This is a cross-backend language feature, tracked as its own work; the host-side ABIs and
  the value-conservation security property are already in place and proven on hand-encoded contracts.

One is a **dependency decision**:

- **EVM-vs-XCL benchmark** (T6.2(d), `MAINNET-GATES.md:285`). Measuring the EVM side like-for-like
  needs an in-repo EVM *execution* engine (a new mainnet-repo dependency). Killed-job billing and
  worker-heap metering — the other two sub-items — are **closed**. A gas-estimate vs measured-cpuMs
  comparison is not like-for-like and is not claimed.
