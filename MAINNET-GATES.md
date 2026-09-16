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
- [x] **EVM backend output is DEPLOYED and EXECUTED — in-process, on every run, in the hard gate.** The same
      LNG source goes down all three roads and must compute the same answers: interpreter, WASM (no imports),
      and `transpile` → solc 0.8.37 (in-process solcjs, a pinned dev dependency — the old `which solcjs`
      lottery skipped on every machine without one) → bytecode deployed into @ethereumjs/evm (the JS
      reference EVM, dev-only) and called through the real ABI (solc's `methodIdentifiers`). Proven: inc/
      sumTo/classify three-way parity (5 calls), full 256-bit width (`inc(2^200)`), overflow reverts on all
      three, `~e 'too big'` → `revert("too big")` → an EVM REVERT carrying that reason with state intact
      after it, `~decimal 1.05` → `1.05e18` fixed-point on-chain. Not a public chain (a product step, not a
      readiness one); external review of the backend stays under the ⛔ audits. — *lng/evm-deploy.test.mjs
      (16/16); lng/transpile-evm.test.mjs (22/22, solc compile now unconditional)*
- [x] **Browser panel ports: the browser build ships IN the module — nothing is ported by hand.** LNG is a
      module; its users import it, they never copy it. `@xmbl/lng` ships `dist/lng.browser.js` — ONE
      dependency-free ES module generated from the SAME `src/*.js` the node runs by `build-browser.mjs` (no
      bundler, no toolchain, no timestamps: byte-reproducible) — as `@xmbl/lng/browser` (and the `browser`
      field). The gate `src/browser-bundle.test.mjs` (34 checks, in `test:protocol`) rebuilds it and FAILS on
      a byte of drift; proves the browser surface == `index.js`'s; that the SAME programs give the SAME bytes
      through both (interpreter output, WASM incl. hostState/compose, Solidity text, diagnostics, identical
      refusal messages, Solidity import); and that it runs in a bare V8 context with no process/Buffer/require,
      where its WASM validates and instantiates; and it was loaded in a REAL Chromium 153 (Playwright) through a
      `<script type=module>` import: run → 'Hello, World!', a 5664-byte WASM validates and instantiates, Solidity
      transpiles, `typeof process`/`Buffer` both undefined — RESULT=PASS. The sources no longer assume Node (`run`'s default sink,
      `TextEncoder` for names). The hand-synced copies in the handoff repo
      (`web/views/config-panels/lng-{interp,evm,wasm,typecheck}.js`, 4 files) are the CONSUMER's to delete for
      one `import … from '@xmbl/lng/browser'` — sent to handoff-claude 2026-09-16 as a fleet-contract
      requirement; closes when that repo counts 0 `lng-*.js` ports. — *lng/build-browser.mjs;
      lng/dist/lng.browser.js; lng/src/browser-bundle.test.mjs (34/34)*
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
      from `~contract` source. This is a LANGUAGE-DESIGN task, not compiler wiring: both verifiers take
      a MESSAGE as `(msg_ptr, msg_len)` bytes (see `abi.js` `HOST_ABI_CRYPTO_INIT_SOURCE`), and the WASM
      backend's value model is 32-byte `~u256` words only — it has no bytes/`str` surface (the same
      reason word-READ names field INDICES, not string names). Emitting these needs a new LNG byte-string
      type (surface syntax + typecheck + a memory layout the backend can lower for BOTH backends), which
      is out of scope for the composition increments and is tracked as its own language feature. Separately,
      `xmbl_lwe_decrypt` is deliberately NOT provided: decryption needs a SECRET key, which is neither
      chain-derivable nor safe to place in a guest's reach — its determinism and key-custody model is
      an open design question, not a build task. **DECIDED 2026-09-16: `xmbl_lwe_decrypt` is WON'T-BUILD —**
      decryption stays off-host by design (a guest never holds a secret key; contracts ADD ciphertexts via
      `env.xmbl_he_add` and never read them). What keeps this row `[ ]` is the byte-string type alone
      (docs/MAINNET-CLOSEOUT.md B1).
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
      *(7)* the committed UTXO-bearing set reproduces the same root under any insertion order;
      *(8)* the `fee` term is load-bearing in BOTH directions — a fee-withholding transfer conserves
      ONLY at the exact fee (refused at fee±1), and a fee charged on a full-value output is refused
      (fee is on the OUTPUT side, cannot mint); *(9)* multi-OUTPUT conservation — a split creates two
      outputs summing to the input; *(10)* multi-INPUT — `xmbl_input_count` drives a consolidate loop
      that spends EVERY presented input into one conserved output; *(11)* a partial spend is safe — with
      two inputs staged, spending only input 0 leaves the other unspent and still spendable in a later call.
      **REPRODUCTION ACROSS A SMALL SET OF TEST NODES** (the mandate's "spin up test nodes"):
      *utxo-multinode.test.mjs* boots THREE independent nodes built from the real node subsystems
      (a genuine `Ledger` + `StateMachine` pair each, as `@xmbl/core` composes), feeds each the
      identical set of xmbl `utxo` transactions, and proves as outcomes that *(i)* all three seal +
      derive ONE identical Verkle root with no coordination; *(ii)* all three hold the identical set
      of ledger `utxo:<id>` keys; *(iii)* a contract that spends a ledger-produced UTXO run on each
      node leaves all three STILL at one identical root, each committing the same spend-marker and
      new UTXO record. — *xcl/abi.js (`HOST_ABI_UTXO_SOURCE`, `utxoKey`, `spendKey`); xcl/contract-host.js
      (`utxoHost` flag, input staging, conservation enforcement); xcl/utxo-fixtures.mjs;
      contract-host.test.mjs (33/33); utxo-multinode.test.mjs (3/3)*
- [x] **T6.2c — CONTRACT COMPOSITION with reentrancy IMPOSSIBLE BY DESIGN** (the EVM power gap, closed —
      and closed more safely than the EVM). A contract interacts with another through two primitives:
      *(1)* **`xmbl_read(peer, slot)`** — a SYNCHRONOUS cross-contract state read that executes NO peer
      code (it is served from a pre-staged, DECLARED read footprint), so it carries zero reentrancy risk
      and covers the balanceOf/oracle/allowance case that makes composition usable; *(2)* **`xmbl_send(peer,
      amount)`** — an ASYNCHRONOUS message whose target runs as a SEPARATE frame AFTER the sender completes,
      never nested. The host runs the entry call plus every message it transitively emits as ONE atomic
      transaction (a shared overlay giving read-your-writes across frames, conservation checked once over
      the UNION, a frame cap so a loop terminates in a revert, and a whole-cascade revert if any frame
      throws). Because a contract can NEVER yield control to another contract's code mid-execution, the
      classic reentrancy attack is not guarded against — it is **inexpressible**. What this eliminates is
      SYNCHRONOUS re-entry, not every cross-contract ordering hazard: message cascades still interleave
      effects across frames, so an author can still act on a `xmbl_read` value a later frame in the same
      cascade invalidates (the actor-model analogue of a race) — the DAO drain is impossible, careless
      cross-frame sequencing is still the author's responsibility, exactly as it is on any actor system.
      Proven as OUTCOMES in
      *xcl/contract-compose.test.mjs (5/5)*: the canonical DAO-vulnerable withdraw (send BEFORE zeroing the
      balance) pays out exactly ONCE across a vault→attacker→vault cascade (cumulative payout 100, not the
      200 the identical EVM ordering drains); a synchronous read returns a peer's committed state; a read
      outside the declared footprint traps; an unbounded cascade reverts at the frame cap with no partial
      commit; a trapping frame reverts the whole transaction. — *xcl/abi.js (`HOST_ABI_COMPOSE_SOURCE`,
      `HOST_IMPORT_KEYS_COMPOSE`, `callerTag`); xcl/contract-host.js (transaction boundary + `_runFrame`
      cascade + `link()`); contract-compose.test.mjs (5/5)*
- [ ] **T6.2 open remainders (HONEST scope of the "≥ Ethereum, fraction of resources" claim).** What
      T6.2 does NOT yet prove, and must not be claimed: *(a)* the UTXO proof contracts are hand-encoded
      and use **i64** amounts, not the `~u256` word width — LNG cannot yet EMIT `xmbl_utxo_*` calls from
      `~contract` source. Same LANGUAGE-DESIGN blocker as T6.1-d: the UTXO ABI names UTXO ids and
      recipients as `(id_ptr, id_len)` / `(to_ptr, to_len)` BYTES (see `abi.js` `HOST_ABI_UTXO_SOURCE`),
      and the WASM backend has no bytes surface — so emitting it needs the same new LNG byte-string type
      (plus a decision on i64 vs `~u256` amount width), not compiler wiring. The value-conservation
      SECURITY property is host-enforced and proven today on hand-encoded contracts regardless; *(b)* contract composition's **word-ABI SEND and
      READ are now EMITTED from `~contract` source** — `xmbl.coord.send(peer, amount)` lowers to the real
      `env.xmbl_send` import and `xmbl.coord.read(peer, field)` to `env.xmbl_read` (word-ABI compose source
      in `abi.js`, the `compose` opt in `compile-wasm.js`), both carrying a FULL 256-bit value by 32-byte
      word pointer, proven end-to-end: an LNG sender's message sets a peer's `~u256` field to exactly
      `2^100+7` (NOT truncated), and an LNG reader mirrors a peer's committed `~u256` field back through
      result-pointer marshalling, adding NO frame (synchronous, runs no peer code) — *contracts/xcl/
      contract-compose-lng.test.mjs 10/10*, *lng/compile-wasm.test.mjs* compose unit (send + read). READ keys
      the peer's state by FIELD NAME (the word-contract model) but the reader names only INDICES: the guest
      passes a peer index and a field index, `link()` range-checks the field index against the peer's
      deployed ordered `fields` list (a word-read REQUIRES the peer to declare `fields` and be `byteState`).
      That `fields` list is **compiler-DERIVED, not operator-typed**: `@xmbl/lng` exports `contractFields(src)`,
      which returns the contract's field names in the compiler's own slot order (the exact `c.fields` order
      the WASM backend keys byte-state by), so a deploy declares `fields: contractFields(SRC)` and the list
      is authoritative by construction. This closes the transposition class — a hand-typed `['b','a']` would
      have made index 0 silently resolve to the wrong REAL field (a plausible, undetectable wrong value); a
      derived list cannot be mis-ordered, and the only way to pass the wrong list is to pass a different
      contract's source, which compiles to different bytes and a different content-addressed id. The host
      resolves the index → field name → `byteKey` when it stages the read-set. An UNDECLARED (peer, field)
      read TRAPS (reverts the cascade), never returns a silent-zero word. This half therefore also touched `link()` (footprint validation) and the staging
      block in `call()` — NOT the cascade machinery, which is unchanged. **Multi-arg messages are now
      also DONE:** `xmbl.coord.send(peer, a, b, …)` carries one OR MORE `~u256` arguments — the WASM
      backend packs the value args into a contiguous 32-byte-word block and lowers to
      `env.xmbl_send(peer_ptr, args_ptr, arg_count)`; the host reads `arg_count` words (rejecting a count
      outside [1,16] or a block past guest memory, fail-safe), enqueues them as ONE message
      `{from,to,fn,args[]}`, and the target frame's word marshal turns each back into a word pointer.
      Proven end-to-end: a two-arg message delivers two DISTINCT 256-bit words intact and IN ORDER (a
      swap or i64 truncation would fail) in a single frame — *contract-compose-lng.test.mjs 11/11*,
      *compile-wasm.test.mjs* compose unit (arg_count 1 and 2, contiguous block). So the `~u256` word
      form of contract composition (SEND, multi-arg SEND, and READ) is COMPLETE; the composite gate
      here stays open only for remainders (a), (c), and (d) below. The
      hand-encoded **i32-slot** form (`xmbl_read`/`xmbl_send` over numbered slots, one i32 arg) remains
      proven separately (*contract-compose.test.mjs 5/5*). Also scoped: authorization is checked on the
      EXTERNAL entry only — internal messages inherit it (like an EVM internal call), and per-message
      authorization is a future refinement;
      *(c)* multi-node
      reproduction is proven across independent real node SUBSYSTEMS (three `Ledger`+`StateMachine`
      pairs converge on one root), but NOT yet across the full networking/consensus stack under
      adversarial timing (that stack's safety is covered separately by `@xmbl/consensus`'s
      byzantine-matrix); *(d)* the **"fraction of the resources" claim now has a MEASURED basis but no
      COMPARISON yet** — finding C1 is resolved for completed jobs (the compute worker measures real
      per-thread CPU time via `process.threadCpuUsage` — not wall-clock, so descheduled time is not
      billed — plus WASM-linear peak memory; `execute` surfaces `{cpuMs, wallMs, peakMemBytes,
      peakMemPages, heapUsedBytes, killed}`, and `ComputeNode.runJob` prices from them via MarketPricing;
      proven in compute.test.mjs 15/15, including the `cpuMs <= wallMs` invariant). **Two of the three
      sub-gaps here are now CLOSED:** a job KILLED at the deadline is BILLED (the runtime attaches
      maximum-charge metrics — full time budget, memory cap — to the deadline rejection; `runJob` counts
      and prices it, returning `ok:false, killed:true, billed:true, price>0`), so an infinite-loop guest
      can no longer occupy a node's capacity for free (the E1/E2 economic-DoS hole); and worker V8-heap
      use (host-binding/marshalling allocations) is now METERED (`heapUsedBytes` sampled after the run,
      surfaced alongside the WASM-linear peak). What REMAINS is the like-for-like benchmark against
      Ethereum (the SAME computation as an EVM contract vs. an XCL contract, BOTH measured): it requires
      an in-repo EVM EXECUTION engine to measure the EVM side (solc gives us compile + structural
      assertion, not runtime cost), which is a new mainnet-repo dependency DECISION, not a wiring task —
      a gas-estimate-vs-measured-cpuMs comparison is not like-for-like and is NOT claimed. So the
      "fraction of the resources" claim keeps its honest scope: a real MEASUREMENT basis, no cross-VM
      COMPARISON. **(d) is CLOSED BY SCOPE (2026-09-16):** no user-facing document makes a cross-VM claim
      any more (README carries none; the only remaining mention, `COMPUTE-ISOLATION-THREAT-MODEL.md`, is
      the disclaimer that the basis is not a comparison), so there is nothing to prove. Should a like-for-
      like number ever be wanted, the EVM execution engine is now in-repo as a DEV dependency of `@xmbl/lng`
      (@ethereumjs/evm, used by `evm-deploy.test.mjs`) — but a JS EVM interpreter measured in-process is
      not "Ethereum", and no such number will be published under that name.

## `@xmbl/consensus` — user-as-validator, five-stage mempool, sealing

- [x] **EVERY TRANSACTION IS TYPED BY ITS XID (operator, 2026-09-16).** tokens.json gives every type its xmbl
      code (identity 1, utxo 2, token_creation 3, contract 4, state_diff 5, tx 6, anchor 7 — the broker's
      type-7 pointer); the xid = SHA256(oid + nonce) with prefix '0'+code over the type's canonical body
      (`micromineBody`: type-6 and the anchor pointer keep their golden shapes, every other type is its fields
      minus the envelope with keys sorted). `micromineTx` mines it; `validateXid` re-derives it. A tx without a
      verifiable xid is UNTYPED and refused at every door — consensus ingress, ledger admission, boot
      rehydration (untyped rows DELETED and counted, never evicted: the typed successor is welcome), canonical
      rebuild (untyped feed rows skipped and reported as `untyped`). A typed forgery is evicted by its xid.
      Producers mine BEFORE signing (the node, the CLI, the devnet) so the signature covers the xid.
      MEASURED before the rule: 16,313 of 17,628 anchors on the audited node carried no xid. An anchor's wire
      tx must now carry `prior` (the previous anchor xid, '' for the first) — the pointer body cannot be
      re-mined without it; sent to handoff-claude as a fleet-contract requirement together with the canonical
      feed carrying xid + nonce + prior. — *cubic-ledger/tokens.json; transaction-validator.js; block.js;
      ledger.js; consensus/validate.js; ingress-guard.test.mjs (+7 refusals); content-id-rekey-on-boot.test.mjs*
- [x] **AUTHORIZATION IS READ FROM THE TYPE TABLE — "signed by a sender, OR content-addressed" (operator).**
      tokens.json now carries `authority` per type: `content-addressed` for type 6 and type 7, `signed` for the
      other five; `authorityOf()` / `contentAddressedTypes()` export it and stage 1 reads it instead of testing
      `tx.type === 'tx'`. MEASURED 2026-09-16 before the fix, on the real ingress: a correctly typed broker
      anchor whose xid verifies was refused `REJECT [can-happen] unsigned` — so every anchor the fleet produces
      died at the first door and "0 untyped anchors" was unreachable. An ANCHOR is a pointer to a digest: it
      moves no value, its body is {from:[prior],to:[hash],how:'anchor'}, and the broker that mints it is
      node-less and custodial, so no end user ever signs one. Its authority IS its xid, re-derived at stage 2 —
      an untyped, forged or prior-less anchor is still refused. The exemption is EXACTLY {anchor, tx}, asserted
      against the table; an unsigned utxo / identity / state_diff still rejects at stage 1. Proven by outcome,
      not by shape: a live XMBLCore returned rawTxId f0391afa… for an unsigned broker anchor whose user does
      not resolve, where it previously returned null ("rejected at ingress"). — *tokens.json (authority,
      authorityRule, 1.2.0); transaction-validator.js; consensus/validate.js; workflow.js `_isContentAddressed`;
      ingress-guard.test.mjs (45 checks)*
- [x] **THE ORDER OF CONSENSUS VALIDATION (operator, 2026-09-16): 1. can the tx happen, 2. is the xid correct,
      3. is the geometric placement right.** `consensus/validate.js` names the stages: `validateCanHappen`
      (shape via `validateShape`, authorization — signed by a sender or content-addressed —, a value that can
      exist), `validateXidStage`, `validatePlacementStage` (`verifyPlacement`: a block's position is its hash
      rank among its face's nine, a face's index the rank of its root among the cube's three — re-derived and
      compared with any claim). Ingress runs 1→2 and names the failing stage in every refusal
      (`REJECT [can-happen] …` / `[xid]`); every local seal (`sealAgreedBlocks`, `_sealReadyFaces`) asserts 3;
      `verifyCube` runs 2 unconditionally and 3 before adoption. — *consensus/validate.js; workflow.js;
      cubic-ledger/deterministic-placement.js; cube-sync.js*
- [x] **CONTENT-ONLY BLOCK HASH — every node seals the same cubes (A7, operator: rolled out to every node).**
      `block.hash` = sha256 of the consensus body (the xid; for an anchor {type,event,hash,ts,xid}), never the
      envelope (relayer, signature, validator clock, submitter id), so two honest nodes holding the same typed
      set hash-sort identical faces and seal identical cubes; `block.id` is its first 16 hex. A wire-format
      change: old and new nodes cannot verify each other's cubes, so it ships with the fleet-wide canonical
      rebuild the operator ordered. — *block.js; cube-sync.js; content-id-eviction.test.mjs; ledger-determinism.test.mjs*

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
- [x] The eight Rust crates are primitive stubs (11 unit tests); they had to reach parity with the
      JS reference **or** be labeled non-production in their crate docs before crates.io consumers
      rely on them. Closed via the label branch: every crate's `src/lib.rs` carries a crate-level
      (`//!`) "⚠ NON-PRODUCTION (pre-mainnet stub)" notice (rendered at the top of the docs.rs page,
      where a consumer looks), and a regression guard FAILS if any label is removed — it also
      discovers the crate set from the filesystem, so a ninth crate added without a label fails too.
      Parity itself remains future work; the label is the honest, enforced interim. — *crates/crate-status.test.mjs (9/9), in `test:protocol`*
- [ ] Version `0.x` communicates pre-mainnet. Do **not** cut `1.0.0` until every ⛔ AUDIT gate
      above is closed.

- [x] **A NODE SAYS WHEN AND WHY IT DIED (B5).** MEASURED on the audited node: ~199 of 264 exits left NO
      marker, `node.log` carried no timestamps, and ten FATALs could not be placed in time. The daemon now
      installs both before it can log or die: an ISO-8601 timestamp on every LINE (a multi-line banner stays
      parseable line by line) and ONE exit marker per process naming how it ended — `clean-exit`,
      `error-exit`, `uncaught-exception`, `unhandled-rejection` — with the code, the pid and the uptime. An
      uncaught error still prints its stack and still terminates the process; a node that keeps running after
      one lies about its own state. Only on the start path: `xmbl-node status` prints JSON the coordinator
      parses. SOAKED against the real binary, 3 boots killed by SIGTERM / SIGINT / SIGTERM: **3 exits, 3
      exit-marker lines, 60 of 60 log lines ISO-stamped, 0 unstamped.** — *core/lifecycle-log.js;
      bin/xmbl-node.js; lifecycle-log.test.mjs (16/16)*
- [x] **FACES ARE DERIVED STATE — the phantom `face:` keyspace is gone (B6).** No code path has ever written a
      `face:` row, yet `rebuildFromAnchors` cleared that prefix on every rebuild, which read as durable face
      state a rebuild had to discard — exactly backwards. Faces are re-sealed deterministically from their nine
      blocks on every boot and every rebuild, and that determinism is the whole convergence argument. The wipe
      list is now `block:`/`cube:`/`pool:`; the in-memory formation reset above it IS the face reset. **Zero
      references to a `face:` row remain** (the surviving `face:complete` hits are an event name). Ledger
      suite 12/12, core 7/7 unchanged. — *cubic-ledger/src/ledger.js*

- [x] **THE CONSENSUS CLOCK LEFT THE SIGNED BODY, AND THE LEDGER VERIFIES AGAIN (A5 + B7).** `moveToProcessing`
      wrote its quorum-averaged `validationTimestamp` INTO txData, and identity's signing message covers every
      field but `sig`/`publicKey` — so a finalized transaction carried a value its signer never saw and could
      not re-verify. That is why the ledger's signature check, which `addTransaction` and `addSealedBatch` have
      always implemented, was never given a resolver on any running node: consensus was the ONLY place a
      signature was ever checked, and a tx tampered with after consensus reached the block store unexamined.
      The clock now travels BESIDE the tx (the finalized event's own field) and is handed to the ledger as an
      argument; the BLOCK carries it, serialises it and reads it back, with the legacy in-tx value kept as a
      fallback for rows already on disk. `validatedHash` is still hashed over {...txData, validationTimestamp},
      so the processing key and the finalized txId are byte-identical — no wire impact. The daemon then wires
      the same peer-registry resolver into the ledger, so a signed tx is verified at BOTH doors. PROVEN AT THE
      REAL SITE, not on a hand-built object: raw tx → quorum timestamps → `moveToProcessing` →
      `finalizeTransaction` → `addTransaction` with a resolver — the body carries no `validationTimestamp`, the
      finalized tx verifies against its signer's key, the block carries the clock as its own field, and a tx
      tampered after consensus is REFUSED at the ledger. The old assertion here pinned the DEFECT as a property
      of `verifyTransaction` itself, which no fix could ever flip; it is replaced by one that exercises the
      pipeline. Convergence unchanged: the 20-anchor epoch rebuild still yields 2 faces, 1 cube and
      set_digest 9093792ad91b3e96…. — *consensus/workflow.js; cubic-ledger/block.js, ledger.js, face.js,
      cube.js, timestamps.js, deterministic-placement.js; core/index.js, lead-worker.js;
      simulator/devnet.test.mjs (27 checks)*

- [x] **THE CLIENT SUITES ARE IN THE HARD GATE (B4) — 61 → 65 suites.** `cli` (41 tests) and `desktop-app`
      (5) are jest suites that `run-node-tests.mjs` never ran, so they could regress silently; the runner now
      skips `__tests__` (a jest suite cannot be run by plain `node`) and each package carries one
      `jest-suite.test.mjs` that runs the real jest process and exits with its status. `browser-extension`'s
      two node suites join directly; its Playwright check still needs a Chromium binary and stays on demand
      (`npm run verify:extension`). **desktop-app was 2/5 and is now 5/5** — three real defects, not test
      noise: `main/main.js` exported a constructed INSTANCE (so `new MainProcess()` threw "not a constructor")
      and booted the app as an import side effect, `createWindow()` returned nothing so no caller could reach
      the window it made, and four directories of CommonJS files sat under a `"type": "module"` package, which
      is why the suite could not even load. A recording `electron` double lets the real main-process code run
      outside Electron. — *scripts/run-node-tests.mjs; packages/{cli,desktop-app}/jest-suite.test.mjs;
      desktop-app/main/main.js, __mocks__/electron.cjs, jest.config.cjs*

- [x] **A REBUILD THAT WOULD EMPTY THE CHAIN IS REFUSED — the race no restart ordering can close.** The
      coordinator's feed gate lives in the RUNNING coordinator process, so a coordinator still holding old
      code, or restarted after a node's OTA rather than before it, drives the default 4008-row feed into a
      typed-only node. Nothing in the 0.1.11 roll restarts a coordinator — `xmbl-node`'s OTA restarts ITSELF
      (exit 75 under a supervisor, self-respawn otherwise) — so ordering is a promise made outside this repo.
      The node no longer depends on it: `rebuildFromAnchors` now does a DRY PASS before deleting anything and
      refuses when the offered set would rebuild to ZERO blocks while the ledger holds some, returning
      `refused: 'would-empty-the-chain'` with the counts and the fix named; `rebuild_ledger` answers `ok:false`.
      The rule is narrow — a rebuild that legitimately SHRINKS a divergent chain still runs, and an empty node
      is never refused. PROVEN ON THE LIVE FEEDS: a node holding the 20-block epoch chain was handed the
      broker's default feed (3991 untyped, 17 rejected, 0 would rebuild) and kept all 20 blocks and its cube.
      — *cubic-ledger/src/ledger.js; core/control-socket.js; rebuild-refusal.test.mjs (13/13)*

- [x] **⚠ SECURITY: A FORGERY COULD DELETE THE TRANSACTION IT IMPERSONATED. FIXED.** Found by the new
      three-node reproduction on its first run: three nodes given the identical 36-anchor set plus one forged
      anchor ended at **36 / 35 / 36 blocks**. Two doors, the same attack, no key material required, and every
      xid and every anchor `event:hash` is public. (1) The ledger evicted an invalid TYPED datum by the xid it
      CLAIMED — but a datum fails `validateXid` precisely when its body does not hash to that xid, i.e. when
      the xid belongs to someone else's datum. So copying an honest anchor's xid and changing one byte evicted
      the HONEST anchor for good: refused forever if it had not arrived yet, and its stored rows DELETED by
      `evict()` if it had. (2) The anchor content key `event:hash` was claimed BEFORE validation and kept on
      failure, so a forgery sharing an honest anchor's event and hash made every later honest copy answer
      `duplicate: true` and vanish. Now: a datum whose claimed xid is not its content address is evicted under
      a digest of ITS OWN bytes (`forged:<sha256>`), the speculative content key is released on every failure,
      and both errors carry `code: 'XID_MISMATCH'`. The forgery is still refused forever; what it impersonated
      is untouched. — *cubic-ledger/src/ledger.js, transaction-validator.js; xid-poisoning.test.mjs (23/23)*
- [x] **THREE FULL NODES CONVERGE UNDER ADVERSARIAL DELIVERY (B2 / T6.2 c).**
      `reproductions/three-nodes.mjs` boots three real `XMBLCore` instances per run and delivers the same
      typed set to each in its own seeded shuffle, with ~20% re-gossiped duplicates and two forgeries spliced
      mid-stream. Two phases, because the fleet has two sealing modes and they do not converge alike:
      **eager local sealing** (the default, `XPC_CONSENSUS_V2` unset) converges the BLOCK SET on every run
      (36/36/36, identical block digest) but the cube partition follows arrival time — measured 3 distinct
      cube `set_digest`s in 2 of 3 runs, because a node cuts a hash-sorted nine whenever it happens to hold
      nine. That is why the live fleet converges through the canonical rebuild rather than through live
      sealing. **Agreed sealing** (`XPC_CONSENSUS_V2=1`) cuts the boundary before it is sealed and all three
      agree on blocks, faces, cubes, the cube `set_digest` AND the state root. Runs in ~2s for 3 runs, so it
      sits in the hard gate. — *reproductions/three-nodes.mjs*

## Rollout policy (operator, 2026-09-16): every node, latest version or suspended, updated over the air

- [x] **A node PROVES the version it runs.** `status` and the SIGNED `chain` claim carry `versions` (what the
      process loaded) and `build` — a sha-256 over the bytes of every @xmbl module in memory's provenance
      (`release.js codeDigest`, sorted paths, tests excluded); `release` serves the per-package digests. A
      version string can be typed; the digest of the code cannot. — *core/release.js; control-socket.js;
      suspension.test.mjs; release.test.mjs (23/23)*
- [x] **A node behind the fleet's latest version SUSPENDS ITSELF.** The daemon asks the release source
      (`XMBL_RELEASE_URL`, default the npm registry's `@xmbl/core` dist-tag — "xmbl npm always latest") every
      `XMBL_OTA_CHECK_MS` (10 min; first check 5 s after boot); behind → `core.suspend()`: no submits (control
      socket `submit_tx`/`submit_batch` answer `ok:false, suspended`), no `submitTransaction`, no validation
      ticks, no seal ticks — reads and the control socket stay up; `status.suspended` and the signed claim say
      so. An unreachable release source never suspends (latest unknown ≠ behind). — *core/index.js;
      bin/xmbl-node.js startOta; control-socket.js; suspension.test.mjs (14/14)*
- [x] **Updates are automatic, over the air.** Behind → `npm install @xmbl/core@<latest>` in the install that
      owns this core (`installRootOf`; `XMBL_INSTALL_DIR` overrides; a source checkout only suspends — git
      updates it) → restart onto the new code: exit `75` (`OTA_EXIT_CODE`) under a supervisor (`--ppid` /
      `XMBL_SUPERVISED=1`), respawn itself when unsupervised, after the ordinary shutdown released pidfile,
      socket, machine lock and stores. `XMBL_OTA=0` disables the loop; the proof is reported regardless.
      — *bin/xmbl-node.js; release.js (updateCommand, OTA_EXIT_CODE)*
- [x] **THE CANONICAL FEED IS REBUILDABLE AND THE REBUILD CONVERGES — measured on the LIVE broker 2026-09-16.**
      `GET /api/v1/xmbl/anchors/canonical?from_epoch=1` serves the epoch-scoped, confirmed set: 20 rows, 20
      typed, 20 carrying `prior`, 0 untyped, with `type_epoch` recorded (first typed anchor 07:52:35Z). Fed to
      the real `Ledger.rebuildFromAnchors` — the code `rebuild_ledger` calls — TWICE, on two independent
      ledgers, the second in REVERSED arrival order: both rebuilt 20/20, 0 untyped, 0 rejected, sealed 2 faces
      into 1 cube of 18 blocks, and both produced set_digest 9093792ad91b3e96… and block_digest
      d833fd8888… — identical. That is the convergence proof the coordinated rebuild needs, taken before the
      rollout rather than after. The default feed still serves all 4008 rows, of which 3991 are pre-epoch
      history whose xid was never minted and cannot be back-mined: a rebuild over the DEFAULT feed produces an
      empty chain (0 rebuilt, 3991 untyped, 17 rejected — measured), so the rollout must use `?from_epoch=1`.
      The rebuild is CONTENT-only, not continuity: a `prior` naming an anchor outside the set is a correct
      value and rebuilds, so the broker's head-advance-at-mint does not block it (it does mean the pointer
      chain is non-contiguous and nothing can audit an anchor's ancestry). — *broker deploys 4a1e942, c3f8ea8,
      6015c98; measured against cubic-ledger/src/ledger.js rebuildFromAnchors*
- [x] **THE NODE SAYS WHICH FEED IT MAY BE HANDED — `ledger_capabilities.requires_typed_anchors`.** The
      coordinator disarmed its automatic `rebuild_ledger` (handoff 08ed182) because a disk version read has
      INVERTED polarity during an OTA: its probe takes a min across install dirs and reports 0.1.9 while the
      process already runs 0.1.11, so a disk-gated feed pick would hand a typed-only node the default 4008-row
      feed and wipe its chain. The node now answers from the RUNNING code: a load-time probe validates one
      typed and one untyped anchor through the loaded validator, and `requires_typed_anchors` is true only when
      it refuses the untyped one AND accepts the typed one. Alongside it, `rebuild_counts_untyped` (a wrong
      feed appears in the counts, never as a silent wipe), `rebuild_is_content_addressed` (a `prior` outside the
      set is a valid value — continuity is not required) and `apply_canonical_accepts_untyped`. MEASURED on one
      node through the real socket: rebuild on an untyped feed rebuilds 0 of 3 and reports 3 untyped; on a typed
      feed rebuilds 3 of 3 with 0 rejected; `apply_canonical` applies all 3 untyped rows, leaves the block store
      byte-identical and lands on the same root in either order. — *control-socket.js TYPED_ANCHOR_POLICY;
      ledger-capabilities.test.mjs (11/11)*
- [ ] **The broker enforces it fleet-wide** — handoff-claude's: a node whose signed `chain` claim carries
      `versions.core` below npm latest, or a `build` digest that is not the published release's, is suspended
      at the broker (no chain blocks, no anchors accepted) until its next claim proves the latest; the bundle
      runs `@xmbl/core`'s `xmbl-node` under a supervisor that respawns on exit 75; one coordinated canonical
      rebuild follows the rollout (block ids and hashes changed). Sent 2026-09-16; closes when every live node's
      claim carries the same `build` digest.

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
      equivalence, 5/5) and its sha is recorded. The shipped artifact's emsdk version is not recorded and
      not recoverable (wasm `producers` section stripped), so a rebuild under the drifted toolchain is not
      byte-identical. DECIDED 2026-09-16 (operator): the shipped baseline is NOT rotated and the lost emsdk
      is NOT hunted — MAYO is to be adapted to the XMBL cubic coordinate system (the `'mayo-cube'` scheme
      slot in `wasm-schemes.js`) to reduce its computation requirements; that build pins its emsdk from its
      first commit, and T2.1-b closes when `build-mayo-cube-wasm.sh --check` matches its recorded sha
      (MAYO-PROVENANCE.md T2.1-b; docs/MAINNET-CLOSEOUT.md A1 / B9).
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
      `eval` assumption. Surfaces real findings for the audit: **C1 metering was DISCONNECTED** (`MarketPricing`
      was exported but never called; `execute`/`runJob` measured no duration/memory and returned no price → no
      billing basis for a paid surface) — **since RESOLVED for completed jobs** (per-thread CPU time +
      WASM-linear peak memory now measured and priced; killed-job billing and worker-heap metering since
      CLOSED, the EVM comparison still open — see T6.2 remainder (d)), C2 the host-source `eval` footgun, and open questions O1/O2 (no
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
