# Mainnet readiness gates

Per-module, **verifiable** definition-of-done. A module is mainnet-ready only when every
gate in its row is checked. `[x]` gates are closed **in code, with a test that fails if the
property regresses**. `[ ]` gates are open; the note says what closes them. Gates that
require an **external audit** cannot be closed by this repo — they are marked ⛔ AUDIT and
block mainnet regardless of code state.

Run the hard gate locally: `npm run test:protocol` (also runs in CI with **no**
continue-on-error, and in the release workflow before any publish).

---

## `@xmbl/identity` — signatures & keys

- [x] MAYO signing path present and exercised (`identity.js` → `wasm-wrapper.js` → `mayo.wasm`).
- [x] Insecure `PlaceholderCurveSource` **DELETED** from the shipped package (class, export,
      and its domain constant removed). A zero-security curve source no longer exists in a
      package that publishes to npm; the abstract seam + `CubicCurveSource` are what remain.
      — *curve-source.js; identity/index.js*
- [x] No module asserts its own security: `CubicCurveSource.describe()` reports
      `secure:false, audited:false` until an audit closes the gate below. A `secure:true`
      self-claim was **removed**. — *curve-source.js*
- [ ] ⛔ AUDIT — MAYO is an **unaudited fork**. Pin the exact upstream commit, get the WASM
      build reproducible, and obtain third-party review of the port before value depends on it.
- [ ] ⛔ AUDIT — the **cubic-curve construction** (Cubic-SIG / Cubic-KEM, curves derived from
      the cube-of-cubes ledger) is novel and has **no external cryptanalysis**. No mainnet
      value may bind to it until audited. Until then it is classical-only (Shor-vulnerable) or
      experimental PQ; neither is a mainnet signer on its own.
- [x] **True-impute delegation protocol** (`delegation.js`): the tiered authorization chain
      handoff proved out — root MAYO identity → TEE coordinator → scoped short-TTL
      Zero-Standing-Privilege token → agent action-sig — lifted onto XMBL and MAYO-signed at
      every hop. `verifyChain` enforces EVERY hop (grant/token/action signatures, key↔address
      derivation, scope attenuation ⊆ grant, audience binding, expiry, membership-is-liveness
      revocation) and is the primitive a load-bearing seam calls to REJECT. TEE attestation is
      honest by default (`NO_ATTESTATION` asserts nothing; a real quote verifier is injected).
      36 conformance checks incl. real MAYO end-to-end. — *delegation.js; delegation.test.mjs*
- [x] **Action authorization is SINGLE-USE** (no replay / double-spend). Each action-sig binds a
      fresh nonce; `makeAuthorizer` verifies the chain and then CONSUMES `(tokenHash, nonce)`
      exactly once (`NonceRegistry`), so re-presenting the same signed action is rejected
      `action-replayed` and a presentation with no nonce is refused before any state change. Proven
      at the load-bearing seam: replaying an authorized `ContractHost.call` does not advance the
      slot. The registry evicts entries once their token expires, so it cannot grow without bound.
      Proven that single-use holds across authorizer instances when ONE registry is shared (two
      authorizers over a shared registry reject a cross-instance replay; two separate registries do
      not — the guarantee IS the shared store). Proven at the seam with the DURABLE store too:
      replaying an authorized `ContractHost.call` is rejected `action-replayed` and the slot is
      unchanged even when the nonce store is RESTARTED (file closed + reopened) between the call and
      the replay. — *delegation.js; delegation.test.mjs (§10); contract-host.test.mjs (b2 + durable-restart)*
- [x] **Durable, shared nonce store for a real deployment.** `DurableNonceRegistry` backs the
      single-use ledger with a `node:sqlite` file over the SAME `consume(tokenHash,nonce,exp)`
      contract, injected as `policy.nonces`. `consume` is one `INSERT OR IGNORE` against a UNIQUE
      primary key — a real compare-and-set: the first insert wins (`changes===1`), every later one
      (this process, a prior run, or another node sharing the file) loses, so two concurrent nodes
      cannot both accept one nonce without relying on JS being single-threaded. It is synchronous, so
      the seam keeps its no-await-between-check-and-burn guarantee; single-use survives a restart
      (reopen the file → the replay is refused) and holds cross-instance. Expired-token rows are
      swept amortized. — *durable-nonce-registry.js; durable-nonce-registry.test.mjs*
- [x] **Value seals ride the mainnet lattice** (`seal.js` PQ envelope: Cubic-LWE KEM + HKDF +
      AES-256-GCM). `sealSecret` REFUSES a receiver ring below N=729 (`MAINNET_N`) unless an
      explicit `allowWeak` non-value demo, which is stamped `weak:true`; `sealKeyPair` mints at
      N=729 by default. The KEM arithmetic uses a provably-exact `Number` fast path (n·q² ≪ 2^53),
      so a mainnet-dimension seal runs in ~200 ms instead of ~2 s. A sealed EVM key round-trips and
      controls the same funded address; a wrong LWE key and any AAD/receiver rebinding fail the GCM
      tag. The KEM ring is PINNED to the receiver's own secret key on open — an envelope whose `n`/`q`
      was altered is rejected, never decapsulated under attacker-chosen parameters. — *cubic-lwe.js;
      seal.js; seal.test.mjs*
      - [ ] ⛔ AUDIT — the **Cubic-LWE** construction (ternary matrix-LWE over the cube ring) is
        novel and unaudited; N=729 clears the self-imposed dimension gate but external
        cryptanalysis is still required before value depends on it.

## `@xmbl/storage-compute` — P2P storage + compute market

- [x] Untrusted WASM runs **off the host thread** on a terminable Worker; a synchronous
      infinite-loop guest is **killed by the deadline** (the old same-thread `Promise.race`
      timer could never fire). — *compute.js; compute.test.mjs*
- [x] **Deny-by-default imports**: a guest importing anything not on an explicit allow-list is
      rejected before instantiation. — *compute.test.mjs*
- [x] **Bounded memory**: a guest declaring unbounded, shared, multi-, or over-cap memory is
      rejected; imported memory is created with a hard maximum; V8 heap capped via
      `resourceLimits`. — *compute.test.mjs*
- [x] **Host hook for contracts** (deny-by-default preserved): a trusted caller (XCL) can supply
      in-worker host imports over a staged read-set and collect a write-set, so synchronous WASM
      host calls work without giving the untrusted guest any handle to parent state. This is the
      generic executor capability; the XMBL contract semantics live in @xmbl/contracts. — *compute.test.mjs*
- [x] **Availability-proof soundness**: `AvailabilityTester` no longer scores a node available
      from a bare `/health` 200 (liveness ≠ possession). `probeNode()` issues a fresh nonce and
      decides availability solely from `proof === computeProbeProof(nonce, expectedBytes)`, never
      the responder's `held` flag — so a node that does **not** hold the shard fails, a liar
      answering `held:true` with a fabricated or wrong-byte proof is rejected, and a proof captured
      under one nonce does not replay under a fresh one. Responder side (`respondToProbe`) proven in
      *storage-node.js; availability-probe.test.mjs*; verifier side (the named module) in
      *availability.js; availability.test.mjs*.
- [ ] ⛔ AUDIT — the compute market is a paid execution surface; the isolation model needs a
      security review (side-channels, resource accounting, worker escape) before untrusted pay.

## `@xmbl/zero-knowledge` — cube-curve state commitment (FRI)

- [x] **Additive/opt-in guard pinned**: with `XZK_COMMIT` unset `_setupZkCommit` attaches no
      `face:complete` listener and creates no state; opted in it is a side buffer only — a ZK
      failure in the handler is swallowed (a sealed face never breaks) and commitments are reachable
      solely through the read-only `getZkCommitments()` query, never feeding ledger/consensus/seal.
      — *core/index.js `_setupZkCommit`; core/zk-additive.test.mjs*
- [x] **FRI conformance suite** in `test:protocol`: pins completeness (an honest cube-curve proof
      verifies), soundness (a forged derived y±1 and a wrong derivedX are rejected against the same
      proof), the zero-knowledge shape (the proof carries no secret point values), and blind-
      invariance. — *xzk.js; xzk.test.mjs*
- [ ] ⛔ AUDIT — experimental, unaudited FRI. Must not gate consensus, ledger, or sealing until
      audited. The `core` wiring already enforces "additive only" — do not remove that.

## `@xmbl/lng` — the smart-contract language (standalone)

- [x] **Standalone**: a pure language toolchain with ZERO XMBL dependencies — importing
      `@xmbl/lng` pulls in nothing else (not even `@xmbl/contracts`). — *packages/lng*
- [x] Full conformance suite as ESM: interpreter, typechecker, determinism gate, EVM
      transpiler, WASM backend — 7 suites, 127 assertions. — *packages/lng/src/\*.test.mjs*
- [x] **Determinism gate enforced**: both backends refuse a contract that reads wall-clock,
      randomness, or otherwise diverges across nodes. — *determinism-gate.test.mjs*
- [x] **WASM backend is mainnet-safe**: emits NO imports and a BOUNDED memory maximum, so a
      compiled contract clears storage-compute's hardened runtime instead of being refused. `~e`
      (LNG revert — what an imported `require()`/`revert` lowers to) compiles to a `unreachable`
      trap, the same rollback the overflow/÷0 guards use, so a guarded contract enforces on-chain
      rather than only in the interpreter. — *compile-wasm.js; compile-wasm.test.mjs*
- [ ] EVM backend output is structurally asserted and solc-compiles, but is not deployed/audited.
- [ ] **Browser panel ports have NO parity guard — and the guard cannot live in this repo.** handoff
      ships hand-synced browser copies of the interpreter/EVM/WASM backends
      (`web/views/config-panels/lng-{interp,evm,wasm}.js`). They were brought back into agreement with
      the reference (the `~e`→trap/revert and if/else-else-block fixes applied to all three), but
      nothing FAILS if they drift again. Established empirically: those panel files live in a SEPARATE
      git repo (`/Users/34r7h/Developer/projects/handoff`, a distinct `git rev-parse --show-toplevel`),
      and xmbl-mainnet vendors NO copy of them (`find` for `lng-*.js` here returns nothing). So neither
      option this row used to name is runnable from this repo's CI: a diff check pointed at an absolute
      sibling-repo path passes only on the author's machine and skips or errors in every other checkout
      (a check that can't fail in CI is not a gate — the same C1 "exported but called by nothing"
      anti-pattern this doc treats as a defect), and the panels are 9–42 KB of UI-wrapped logic with no
      clean seam to "generate from source." OPERATOR DECISION REQUIRED, pick one: **(a)** the guard
      lives in the handoff repo, consuming published `@xmbl/lng` (or a vendored reference) and diffing
      the backend-logic portions there; or **(b)** the panels are vendored INTO xmbl-mainnet so a
      generated-from-source build step / diff check here can observe drift. Until one is chosen this
      stays open — no in-repo code can close it.
- [x] **Solidity → LNG importer** (`import-solidity.js`, the reverse of the EVM backend): an
      existing Solidity contract is lifted to LNG so it can run natively on XMBL. Proven by
      BEHAVIOR — `LNG →transpile→ Solidity →importSolidity→ LNG` runs to the same output, and
      hand-written Solidity imports, **compiles to WASM, and TRAPS on a failed `require`** (the
      revert fires on-chain, not just under the interpreter). `msg.value` is REFUSED, never aliased
      to `` `caller `` (which would silently neuter a payable/price guard); `msg.sender` still lowers
      to `` `caller ``. Unsupported constructs (inheritance, structs, modifiers, `while`, arrays) are
      REFUSED by name, never silently mistranslated. 21 checks. — *import-solidity.js; import-solidity.test.mjs*

## `@xmbl/contracts` — the contract layer (XCL)

- [x] **Depends on @xmbl/lng, does not embed it**: the language is a separate standalone
      package; XCL is only the binding layer. The dependency runs one way (contracts → lng).
- [x] **Binds contracts to real state without feature creep**: deterministic cubic placement,
      slot↔Verkle-key mapping, read-set-in/write-set-out staging; execution is DELEGATED to
      @xmbl/storage-compute and state to @xmbl/state-machine (a real VerkleStateTree is
      injectable). Two hosts fed the same calls converge to the same root. — *xcl/contract-host.test.mjs*
- [x] **A compute node composes it**: a `ComputeNode` injected with a `ContractHost` runs
      contracts, while its raw market path still denies the host import. — *compute-node-integration.test.mjs*
- [x] **Usable standalone**: falls back to an in-memory store when no state tree is injected. — *contract-host.test.mjs*
- [x] **Authorization is load-bearing and fail-closed** (true-impute enforcement): a contract
      deployed `{gated:true}` runs a state transition ONLY when an injected `authorizer`
      (@xmbl/identity `makeAuthorizer` over `verifyChain`) passes for it — unauthorized,
      out-of-scope, and REVOKED calls are refused BEFORE any WASM runs and leave state
      unchanged; a gated contract with no authorizer configured cannot be called (never fails
      open). — *contract-host.js; contract-host.test.mjs*
- [x] **T6.1-a — byte-pointer STATE ABI meets the LNG backend.** Beyond the v0 slot ABI, the XCL
      host ABI now has the byte-pointer state form from agentic-contracts-proto.md §3.1
      (`xmbl_verkle_get(key_ptr,key_len,val_out_ptr)` / `xmbl_verkle_set(key_ptr,key_len,val_ptr,
      val_len)` over the guest's linear memory — abi.js `HOST_ABI_SOURCE_BYTES` + `byteKey`), and
      the LNG WASM backend EMITS it under opt-in `compile(src,{hostState:true})`: each entrypoint
      loads its `~u256` fields from Verkle on entry and flushes on every assignment (so an early
      `return` never drops a write). A full LNG-compiled contract now DRIVES persisted state —
      proven by a FRESH-worker-per-call counter that reaches 3 only by reading each prior call's
      committed write back through the host, and by two hosts over a real VerkleStateTree
      converging to one root. The DEFAULT `compile()` stays import-free, so the mainnet-safe gate
      above does not regress. — *compile-wasm.js; xcl/abi.js; xcl/contract-host.js;
      contract-host.test.mjs (18/18); compile-wasm.test.mjs (26/26)*
- [x] **T6.1-b — `~u256` argument + return marshalling meets the LNG backend.** An LNG entrypoint
      takes each `~u256` param as an i32 POINTER to a 32-byte little-endian word in guest memory and
      returns such a pointer, so passing plain integers through `ContractHost.call` had the WASM read
      them as ADDRESSES (`add(7,3)` returned a garbage pointer, not 10). ContractHost now carries a
      `wordAbi` deploy flag; when set it hands the runtime a marshal (abi.js `XCL_WORD_MARSHAL_SOURCE`)
      that runs INSIDE the compute worker — the only place guest memory is reachable — to `__reset()`,
      `__alloc()` a 32-byte word per arg and write it little-endian, pass the pointers, and decode the
      returned word pointer back to a BigInt. ComputeRuntime gained a generic `host.marshal` arg/return
      hook (`$args`/`$result`) so XCL semantics are NOT hardcoded in the market runtime. Proven by
      PARITY against BigInt over random 256-bit operands for add/sub/mul/div/mod/shl/shr through the
      full XCL binding, by Number/BigInt/>2^53 args across the worker boundary, by overflow/underflow/
      div-zero still trapping (revert), by a `wordAbi` deploy over a non-LNG contract (no `__alloc`)
      failing LOUDLY instead of passing ints through, and by a `byteState`+`wordAbi` `inc(by)` that
      marshals the arg AND persists 5 → 42 across calls. — *xcl/abi.js; xcl/contract-host.js;
      storage-compute/compute.js; contract-host.test.mjs (18/18)*
- [x] **T6.1-c — signature-verification host calls, bound to the REAL verifiers.** §3.1's
      `xmbl_cubic_sig_verify` and `xmbl_mayo_verify` are now callable from a contract and answered by
      the actual `@xmbl/identity` verifiers. The operator's "async" decision resolved the one real
      async step: a WASM import must return synchronously and does — the only async work is MAYO's
      ONE-TIME Emscripten instantiation, so ComputeRuntime gained an `host.init` hook (a stringified
      `async (ctx, declared) => bindings` factory) AWAITED before the guest is instantiated; it loads
      MAYO once and ONLY when the guest declares `env.xmbl_mayo_verify`, then binds SYNCHRONOUS verify
      functions (`MAYOWasm.verifySync`, added as the sync twin of the async wrapper; Cubic-SIG verify
      is already sync). The init factory `import()`s the real module INSTEAD of inlining Cubic-SIG/MAYO
      math into the eval'd string — the "capability by real module, not eval'd source" direction C2 in
      COMPUTE-ISOLATION-THREAT-MODEL.md asks for, so this SHRINKS the eval surface. DETERMINISM
      (ContractHost drives a shared root): the signature MATERIAL is chain-staged via `ctx.data.crypto`
      (identical on every node); the guest supplies only the message bytes. Proven by a hand-encoded
      contract (no LNG dependency, like COUNTER) whose call returns 1 for a VALID Cubic-SIG / MAYO
      signature and 0 for one over a different message — a real cryptographic verdict — plus a
      deny-by-default check that the same import without the `cryptoHost` flag is refused. — *xcl/abi.js
      (`HOST_ABI_CRYPTO_INIT_SOURCE`); xcl/contract-host.js; storage-compute/compute.js;
      identity/wasm-wrapper.js (`verifySync`); contract-host.test.mjs (21/21)*
- [ ] **T6.1-d — LNG source can CALL the crypto verifiers, and `xmbl_lwe_decrypt` (open).** The
      runtime/ABI half of the crypto calls (T6.1-c) is reachable today only from a hand-encoded WASM
      contract; the LNG compiler does not yet emit `env.xmbl_cubic_sig_verify` / `env.xmbl_mayo_verify`
      from `~contract` source (needs surface syntax + typecheck + backend emission). Separately,
      `xmbl_lwe_decrypt` is deliberately NOT provided: decryption needs a SECRET key, which is neither
      chain-derivable nor safe to place in a guest's reach — its determinism and key-custody model is
      an open design question, not a build task. Both are the remaining §3.1 surface.
- [x] **T6.2 — contracts LINK xmbl UTXOs to the Verkle state machine, provably and reproducibly.** A
      contract can now SPEND committed xmbl UTXOs and CREATE new ones, into the SAME Verkle tree the
      state machine already commits ledger blocks to (`state-machine.js` maps a `utxo` block to
      `utxo:<block.id>`), so contract execution and value transfer share one provable state root. The
      spend model matches the ledger's own type-6/type-7 rule (`micromine.js`): spent-ness is derived
      from a SEPARATE nullifier key `spend:<id>`, never by mutating the immutable value record — a
      double-spend is simply a key that already exists. A contract does not hardcode the ids it spends;
      it enumerates the inputs the caller PRESENTED (`xmbl_input_count`/`xmbl_input_id`), so the same
      bytecode spends a content-addressed ledger id it could not have known at compile time. **The
      security property — value conservation — is enforced by the HOST, fail-closed:** `ContractHost`
      sums the spent inputs against the created outputs + fee AFTER the run and BEFORE any write lands,
      so a contract that mints value (out > in) is refused and applies NOTHING (root unmoved). Proven as
      OUTCOMES on hand-encoded contracts (no LNG dependency, like COUNTER):
      *(1)* a valid transfer spends an input and creates a conserved output, moving the root;
      *(2)* a mint (out > in) is refused fail-closed, root unmoved;
      *(3)* a double-spend of the same input is refused, root unmoved;
      *(4)* two independent hosts fed the same transfer converge to ONE root;
      *(5)* a contract spends a LEDGER-PRODUCED key (real `Block.fromTransaction` +
      `StateMachine._stateChangesFor`, not a fabricated key);
      *(6)* the spend is provable against the committed Verkle root via `generateProof`/`verifyProof`,
      and a TAMPERED value is rejected;
      *(7)* the committed UTXO-bearing set reproduces the same root under any insertion order.
      — *xcl/abi.js (`HOST_ABI_UTXO_SOURCE`, `utxoKey`, `spendKey`); xcl/contract-host.js (`utxoHost`
      flag, input staging, conservation enforcement); contract-host.test.mjs (28/28)*
- [ ] **T6.2 open remainders (HONEST scope of the "≥ Ethereum, fraction of resources" claim).** What
      T6.2 does NOT yet prove, and must not be claimed: *(a)* the UTXO proof contracts are hand-encoded
      and use **i64** amounts, not the `~u256` word width — LNG cannot yet EMIT `xmbl_utxo_*` calls from
      `~contract` source (same gap as T6.1-d for crypto); *(b)* **contract-to-contract calls** do not
      exist — `ContractHost` cannot reenter itself, a real power gap vs the EVM; *(c)* multi-node
      convergence is proven IN-PROCESS (independent hosts, same calls → same root), not yet across real
      node boundaries; *(d)* the **"fraction of the resources" claim is unmeasured** — finding C1
      (`storage-compute` metering disconnected from execution) means there is no measured CPU/memory
      basis to compare against Ethereum; the caps are enforced, the meter is not. These are the
      substance of the remaining smart-contract parity work.

## `@xmbl/consensus` — user-as-validator, five-stage mempool, sealing

- [x] Ingress guard + invalid-eviction covered by node tests. — *ingress-guard, invalid-eviction*
- [x] Byzantine / no-fork test matrix drives the **real** `SealRoundManager` across an in-memory
      gossip bus with a partition mask, asserting the one safety property — honest seal-leads
      converge on ONE sealed set-hash or safely STALL, never seal two different sets: **(a)** an
      equivocating Byzantine peer cannot manufacture a second sealed set (pigeonhole: ≤1 vote per
      hash per node); **(b)** a minority without the member data STALLS (never fabricates) and later
      ADOPTS the identical hash once data arrives; **(c)** a partition with divergent pools STALLS on
      both sides under the correct fixed quorum, then converges on heal — contrasted against the
      presence-shrunk quorum, which forks PERMANENTLY (a sealed member cannot be re-adopted). Mutation
      (`decideRound` seals one vote short) reproduces the fork → red. — *byzantine-matrix*
- [x] **FORK DEFECT FOUND + FIXED (this gate):** the seal quorum (`XMBLCore._sealQuorum`) divided the
      strict-majority threshold by the **presence-live** lead subset (`getLiveLeaders()`, TTL-filtered),
      so a network partition shrank the denominator and each side independently reached a smaller
      majority → two honest partitions seal two different faces from divergent pools → **permanent
      fork with f=0** (on heal neither can `adoptSet` the other's set: its members already left the
      pool). Seal is a *selection* (which set becomes this face), unlike validation's *predicate*
      (idempotent, safe to shrink). Fixed: the denominator is now the **fixed configured lead set**
      (`sealQuorumFrom(_leadAllowlist)`) — mainnet multinode REQUIRES `XPC_LEAD_ALLOWLIST` (the genesis
      validator set); no allowlist ⇒ single-node dev (quorum 1). Regression + mutation in
      *seal-quorum* (`packages/core`). Handoff task + issue track the finding for the auditors.

## `@xmbl/state-machine` — Verkle virtual state machine

- [x] Every tx type reaches the tree; root is a cross-node commitment; **survives restart via
      diff replay**; cube-complete writes the root. — *apply-path, verkle-integration*
- [x] **Feature-creep removed**: the duplicate, insecure `WASMExecutor` (raw WebAssembly with a
      fake fallback that fabricated state transitions) and `executeTransaction` were DELETED.
      WASM execution is storage-compute's; this module owns state only. — *state-machine.js*
- [x] Verkle proof verification against an **independent** verifier (not the same code that
      produced the proof). A from-scratch reconstruction (only `node:crypto`, nothing imported from
      `verkle-tree.js`) recomputes the committed root from `(key, value, proof.path)` — leaf =
      `sha256(value)`, internal = `sha256(256×32-byte child slots)`, nibble = `sha256(key)[depth]` —
      and binds the verdict to the tree's **real** root (`getRoot()`), never the attacker-supplied
      `proof.root`. Valid proofs verify; tampered value, key, root-binding, sibling hash, and a
      spliced keyA→keyB proof are all rejected; a stale proof fails against a changed root. A mutation
      drifting `_hashValue` (shared by the prover **and** the tree's own `verifyProof`) leaves the
      built-in verifier green but the independent one goes red — so a bug shared by prover+verifier
      cannot pass both. — *verkle-tree.js; verkle-independent-verify.test.mjs*

## `@xmbl/cubic-ledger` — blocks → faces → cubes

- [x] Deterministic placement, cross-node cube-sync convergence, membership persistence, golden
      micromine vector — all covered. — *6 suites*
- [x] Adversarial sync: a peer feeding an inconsistent block set is rejected, not merged. The live
      ingestion path (`CubeSyncManager._onCube` → `adopt`) runs the self-certifying `verifyCube`
      gate before any write; every contradictory set — tampered member tx, swapped hash, truncated/
      padded/short face count, lying face or cube merkleRoot, and a valid cube served under the
      **wrong id** (fork attempt) — is rejected and **local state is left byte-for-byte unchanged**
      (no cube record, no member block, no partial adoption). A mutation dropping the requested-id
      binding adopts the id-substituted and fork payloads → the test fails. Honest sync still
      converges (control). — *cube-sync.js; cube-sync-manager.js; cube-sync-adversarial.test.mjs*

## `@xmbl/networking` — libp2p P2P

- [x] In-package own-logic coverage (was ZERO test files). Adversarial suite over the logic this
      package actually owns: `ConnectionManager` enforces its connection **cap** (a flood cannot
      exceed `maxConnections`); `MessageRouter` is **deny-by-default** (an unknown/forged message
      type invokes no handler — it throws, never silently dispatches) and never cross-wires types;
      `PeerDiscovery` **never dials itself** (a self-only seed list dials nothing and arms no retry
      loop) and never re-dials an already-connected seed. Mutations removing the cap, the
      deny-by-default throw, or the self-dial guard each fail the suite. — *connection.js; routing.js;
      discovery.js; own-logic.test.mjs*
- [ ] ⛔ INTEGRATION/AUDIT (refiled from the row above) — discovery under NAT, gossip fan-out
      rounds, and Kademlia routing-table poisoning resistance are behaviour of libp2p / WebTorrent
      reached through thin wrappers here (this package has no peer routing table of its own), so they
      are **not** unit-testable against this module. They belong to the simulator/integration surface
      (where they are exercised indirectly today) and the whole-protocol external review (see
      `@xmbl` audit gates). Do not close with an in-package mock.

## `@xmbl/core` — node runtime

- [x] Orchestrates the modules; ZK kept strictly additive.
- [x] **Mainnet boot is refused while audits are open.** `start()` throws on
      `XMBL_PROFILE=mainnet` whenever `AUDIT_GATES_OPEN` is true (its default). There is NO
      env override — the only way to open mainnet is the reviewed source change that flips
      `AUDIT_GATES_OPEN` to false once the ⛔ AUDIT gates below are closed. — *core/index.js;
      boot-gate.test.mjs*

---

## Cross-cutting (all modules)

- [ ] ⛔ AUDIT — one external security review of the protocol as a whole before mainnet.
- [ ] Reproducible builds for the WASM artifacts (`mayo.wasm`) pinned to source commits.
- [ ] The eight Rust crates are primitive stubs (11 unit tests); they must reach parity with the
      JS reference or be labeled non-production in their crate docs before crates.io consumers
      rely on them.
- [ ] Version `0.x` communicates pre-mainnet. Do **not** cut `1.0.0` until every ⛔ AUDIT gate
      above is closed.

## Audit-prep deliverables (author in-repo BEFORE the ⛔ AUDIT reviews)

Each ⛔ AUDIT gate needs a signed **external** report, but the reviewer-facing package it attacks
is our own work and is currently **unwritten**. These are in-repo, closable now, and each is tracked
as a handoff PREP task under the audit goal. Nothing external can start until the matching item is
`[x]`.

- [x] **T2.1-a** — upstream pin recorded in `packages/identity/MAYO-PROVENANCE.md`: PQCMayo/MAYO-C
      @ `4b7cd94c96b9522864efe40c6ad1fa269584a807`, MAYO_1 `opt` param set, verified against the live
      upstream (39/40 files of the compiled `src/`+`include/` subtree byte-identical), vendored inventory
      documented. *(blocks T2.1-b, T2.1-c)*
- [ ] **T2.1-b** — reproducible `mayo.wasm` build. DONE: `build-mayo-cube-wasm.sh` pins all build INPUTS
      (sources/defines/flags/exports) + `--check` mode; rebuild passes the identity suite (functional
      equivalence, 5/5) and its sha is recorded. BLOCKED on an operator decision for BYTE-identity: the
      shipped artifact's emsdk version is not recorded and not recoverable (wasm `producers` section
      stripped), and a rebuild under the drifted toolchain is not byte-identical — must either pin the
      original emsdk or adopt a freshly-built artifact as canonical (see MAYO-PROVENANCE.md T2.1-b).
- [x] **T2.1-c** — MAYO fork-vs-upstream diff explained: exactly one file differs (`fips202.h` `shake256`
      `int`→`void`, matching upstream's own `void` definition — a stale-forward-declaration build fix, zero
      algorithm change). Committed as `packages/identity/mayo-cube/mayo-fork.diff`; rationale in
      MAYO-PROVENANCE.md §T2.1-c.
- [x] **T2.2** — formal Cubic-curve construction + security-assumptions spec authored:
      `docs/xmbl-cubic-cryptography-whitepaper.md` (the reviewer-facing package the ⛔ AUDIT attacks).
      Specifies `CubicCurveSource` step-by-step (§3), states the cryptanalysis assumptions A1–A3 + open
      questions O1/O2 (§2, incl. the honest finding that derived curves have NO group-order/weak-curve
      screening), and Cubic-SIG's EUF-CMA-under-ECDLP-in-ROM reduction (§5.2) — flagging that Cubic-SIG
      signs on **standard secp256k1** (`a=0`), so its group security is inherited, not novel. Resolves the
      code's previously-dangling whitepaper citations (curve-source §2/§3.1, cubic-sig §5.2, cubic-lwe
      §3.2/§5.3). Claims nothing secure; `secure/audited` stay false pending the external report.
- [x] **T2.3** — Cubic-LWE parameter-justification authored as whitepaper §4: N=729/q=3329 rationale,
      ternary-η=1 construction, and a decryption-failure analysis verified empirically (noise σ≈25.4 at
      N=729, ≈32σ margin to q/4; worst-case bound 2N+1=1459 > q/4 flagged for a rigorous DFP bound). States
      L1 (IND-CPA ⇐ LWE/SVP, quantum-safe) and enforced L4 (seal.js fails closed below N=729), and records
      two real findings for the audit: M1 the ternary sampler's 86/85/85 modulo bias, and M2 the KEM is
      IND-CPA-only (no Fujisaki–Okamoto ⇒ not IND-CCA2). Flags the in-source 2^168 Core-SVP claim as
      unverified-in-repo (reproduce via lattice estimator).
- [x] **T2.4** — compute-market isolation threat model authored:
      `packages/storage-compute/COMPUTE-ISOLATION-THREAT-MODEL.md`. Documents the trust boundaries and the
      three ENFORCED+tested properties (cross-thread wall-clock termination, bounded WASM/V8 memory,
      deny-by-default imports with inert stubs), the host-hook staged read/write path and its trusted-caller
      `eval` assumption. Surfaces real findings for the audit: **C1 metering is DISCONNECTED** (`MarketPricing`
      is exported but never called; `execute`/`runJob` measure no duration/memory and return no price → no
      billing basis for a paid surface), C2 the host-source `eval` footgun, and open questions O1/O2 (no
      aggregate/concurrency admission control), O3 (co-tenancy side/covert channels unmitigated — Worker
      threads share the process), O4 (fuzz the hand-rolled section parser), O5 (contract-path determinism
      unscreened). Claims nothing secure; the ⛔ AUDIT gate stays open.
- [x] **T2.5** — FRI parameter/soundness write-up authored:
      `packages/zero-knowledge/FRI-SOUNDNESS.md`. Records the shipped params (BabyBear p=15·2²⁷+1 31-bit
      field, K=32, N=128, ρ=1/4, nq=12) and computes soundness CONCRETELY: ~24 bits conjectured / ~8 bits
      provable — a demonstration parameterisation, NOT 100/128-bit secure. Findings: F1 the 31-bit base
      field makes Fiat–Shamir challenges grindable at 2³¹ (no extension field — the decisive gap), F2 no
      grinding PoW / extension-field repetition, F3 the `friVerify` fold-consistency check has dead/
      degenerate logic needing hand-verification. States the changes required (≥124-bit extension field,
      raise nq/lower ρ, clean+re-prove the verifier) and confirms FRI must stay firewalled from consensus/
      ledger/sealing until resolved. Claims nothing secure.
- [x] **T2.6** — whole-protocol threat model authored: `docs/WHOLE-PROTOCOL-THREAT-MODEL.md`. The
      composition view no single-module doc gives: the 10-module stack + one-directional dependency hygiene
      (untrusted-WASM execution isolated to storage-compute; contracts injected, no cycle), the 7 trust
      boundaries B1–B7, sealing as the highest-severity surface (the seal=selection-not-predicate invariant
      and the fixed fork defect), and the **economic/DoS surface that only emerges in composition** — E1
      compute market unmetered (no billing basis), E2 no aggregate admission control, E3/E4 ingress
      cheap-send/expensive-verify asymmetry, E5 transport/NAT, plus cross-module risks X1 (keep FRI
      firewalled) / X2 (contract determinism) / X3 (classical-vs-PQ sig boundaries) / X4 (state-proof
      independence). Cross-references T2.1–T2.5. Claims nothing secure.
