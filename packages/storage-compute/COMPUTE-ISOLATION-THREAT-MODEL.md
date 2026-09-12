# Compute-market isolation threat model (audit prep — T2.4)

**Status: PRE-AUDIT REVIEWER PACKAGE.** `@xmbl/storage-compute` runs **untrusted,
third-party WASM for pay** on an operator's node. This document is the isolation
model an outside reviewer is asked to break: what the sandbox promises, exactly how
each promise is enforced, the trust boundaries, and — stated without softening —
the findings and open questions the code does *not* currently answer. Nothing here
asserts the compute market is safe to run against value; the matching ⛔ AUDIT gate
in [`MAINNET-GATES.md`](../../MAINNET-GATES.md) (§`@xmbl/storage-compute`) stays open
until a signed external report closes it.

Authoritative sources (every claim below is traceable to these):

- `src/compute.js` — `ComputeRuntime.execute`, the Worker sandbox + WASM policy
- `src/compute-node.js` — `ComputeNode.runJob` / `runContract`, the market/contract seam
- `src/pricing.js` — `MarketPricing` (see Finding C1)
- `src/compute.test.mjs` — the isolation properties proven as outcomes
- `../contracts/src/xcl/contract-host.js` — the trusted host-hook path

---

## 1. Assets, actors, trust boundaries

**Actors.**
- *Node operator* — runs `ComputeNode`, sells CPU/memory. Wants: no unbounded
  execution, no host compromise, correct billing, no ambient capability leak.
- *Job submitter (UNTRUSTED)* — supplies `wasmCode` + `functionName` + `args` over
  a pubsub topic (`compute:job_request`) or in-process `runJob`. Assumed hostile.
- *Contract caller (TRUSTED-ish)* — drives `runContract` through an injected
  `ContractHost`; supplies the *host module* source (see §4). This is the caller's
  **own** code, not the guest's.

**Assets.** Operator host integrity (thread, event loop, filesystem, network,
process memory), other tenants' jobs on the same process, billing correctness, and
— on the contract path — the staged verkle state read/write set.

**The central trust boundary** is the `Worker` thread boundary: the untrusted guest
WASM executes on a dedicated `worker_threads.Worker` (`eval: true`,
`WORKER_SOURCE`), never on the host thread. Everything the guest can touch must be
passed explicitly through `workerData`; there is no ambient host handle.

---

## 2. Properties the sandbox ENFORCES (as tested outcomes)

These three are enforced, and `compute.test.mjs` proves each as an outcome (a
killed loop / a rejected module), not an assertion:

### 2.1 Wall-clock termination (liveness against a hostile guest)

The prior implementation raced a `Promise.race` timer on the **host** thread — a
synchronous `while(1)` in the guest wedged the event loop so the timer never fired.
The current design runs the guest on a **separate thread** and the host calls
`worker.terminate()` when `setTimeout(this.maxTime)` fires. A synchronous infinite
loop is therefore killed by a different thread (test: *"infinite-loop guest is
terminated by the deadline"* → rejects `/time limit/i`). Default `maxTime` = 5 s
(`ComputeRuntime`), 10 s (`ComputeNode`).

### 2.2 Bounded memory

- The guest's own memory section (WASM section id 5) is parsed *after*
  `WebAssembly.compile` validates structure. A module is **rejected** if it declares
  **multiple** memories, **shared** memory (threads proposal — cross-thread mutable
  state), **unbounded** memory (no maximum), or a maximum/minimum **over the page
  cap** (tests: unbounded → `/unbounded/i`, oversized → `/exceeds limit/i`, shared →
  rejected).
- An **imported** memory is created by the host with a hard `maximum: maxPages`.
- Belt-and-braces: an exported memory whose `byteLength` exceeds the cap after
  instantiation is rejected.
- `resourceLimits.maxOldGenerationSizeMb` caps the Worker's **V8 heap** too, so a
  JS-side (host-hook) allocation bomb dies with the thread. `maxPages =
  ceil(maxMemory / 64 KiB)`, default `maxMemory` = 64 MiB.

### 2.3 Deny-by-default imports (no ambient capability)

Every import the guest declares is resolved as: a host-provided function for that
exact `module.name` key (contract path only, §4), **else** an allow-listed *inert*
value (memory → bounded `Memory`; global → immutable `0`; function → a **stub that
traps if called**), **else denied** and the run is rejected (test: *"guest import is
denied by default"* → `/denied import: env\.foo/`). An allow-listed function name
therefore still grants **no real host behaviour** unless a host module binds it.
The raw market path (`runJob`) forwards **no host and no allow-list widening** —
untrusted jobs never get a state-bearing binding.

---

## 3. Threats and how the model handles them

| # | Threat | Handling | Residual risk |
|---|--------|----------|---------------|
| T1 | CPU DoS (infinite loop) | Cross-thread `terminate()` on deadline (§2.1) | Per-job only — see O1 (concurrency), O2 (thread-spawn cost) |
| T2 | Memory exhaustion | Section parse + import cap + V8 heap cap (§2.2) | Guest can still churn up to the cap × concurrent jobs (O1) |
| T3 | Ambient capability / host escape via imports | Deny-by-default; inert stubs (§2.3) | Depends on Worker isolation holding (O3) |
| T4 | Shared-memory cross-thread attack | Shared memory rejected at compile (§2.2) | — |
| T5 | Malformed/adversarial module bytes | `WebAssembly.compile` validates before the hand-rolled limit parser runs | Limit parser trusts post-validation layout; fuzz it (O4) |
| T6 | Guest wedges host event loop | Guest is on another thread; host never runs guest code | — |
| T7 | Contract host-hook abuse | Host runs in-worker over a *staged* read-set; writes are a collected set applied by the caller AFTER the run (§4) | Host source is `eval`'d — trusted-caller assumption (§4, C2) |

---

## 4. The host-hook path (contract execution) and its trust assumption

`runContract` → `ContractHost.call` → `runtime.execute(wasm, fn, args, { host })`.
The `host.source` string is `eval`'d **inside the worker** as a
`(ctx) => ({ "env.name": fn })` factory. This is deliberate and is what makes
*synchronous* WASM host imports possible without giving the guest thread a live
handle to parent state: the host functions run in-worker over a **staged read-set**
(`ctx.data`) and collect a **write-set** (`ctx.writes`) that is posted back and
applied to real state by the caller *after* the sandboxed run.

**Trust assumption (load-bearing):** `host.source` is the **caller's own trusted
code** (e.g. the XCL contract ABI), **never** the untrusted guest's. `ContractHost`
scopes the allow-surface to exactly the ABI keys for that one call and does **not**
widen the runtime's persistent `allowedImports` (so one call's allowance cannot leak
to later jobs on a shared runtime). If a deployment ever lets an untrusted party
supply `host.source`, the sandbox is void — this boundary must be enforced by the
caller and checked in audit.

---

## 5. Findings (real, surfaced by this review)

### C1 — Metering connected to execution (billing-integrity gap — RESOLVED for completed jobs)

**Status: the measurement half is CLOSED.** The worker now measures the guest's
execution. `cpuMs` is `process.threadCpuUsage()` across the `fn(...)` call — the CPU
actually consumed by THIS worker thread (user + system, microsecond-resolution), **not**
wall-clock, so a job is not billed for time the thread spent descheduled (OS preemption,
GC in this isolate, co-tenants on the box); the same guest bills the same regardless of
node load. `wallMs` (elapsed real time via `performance.now()`) is reported alongside for
observability but is not the billed figure; `cpuMs <= wallMs` is asserted as the invariant
that distinguishes per-thread CPU from the old wall-clock measurement. `peakMemBytes` is
the guest's **WASM linear memory only** — it never shrinks within a run (there is no shrink
instruction), so its byte length after the call is the run's PEAK. `execute()` surfaces
`{ cpuMs, wallMs, peakMemBytes, peakMemPages }`: always on the host path, and on the raw
path via opt-in `{ meter: true }` (the bare return stays the default, so every existing
caller is unchanged). `ComputeNode.runJob` meters each job and returns its measured metrics
plus a `price` = `MarketPricing.calculateComputePrice(cpuMs, peakMemBytes/MiB)` — the price
is now MarketPricing applied to what the runtime actually measured. Proven as outcomes in
`compute.test.mjs` (a memory-growing guest measures a larger peak than a no-memory one; a
50M-iteration loop measures more cpuMs than a single add; `cpuMs <= wallMs` holds; a node's
job price is exactly the model over the measured figures, strictly positive for a job that
used real CPU time and memory).

*Originally:* `MarketPricing.calculateComputePrice(durationMs, memoryMB)` existed but was
called by nothing in the execution path; `execute()`/`runJob()` never measured duration or
memory and returned no price — `maxTime`/`maxMemory` were enforced as *caps*, not *meters*.

**Still open (deliberately, tracked here):** *(a)* a job TERMINATED at the deadline (an
over-time guest) still consumed resources that go **unbilled** — the worker is killed before
it can post metrics, so only jobs that COMPLETE within caps are metered; charging for killed
jobs needs the parent to attribute elapsed wall-clock on termination. *(b)* the measured
basis is not yet a **comparison to Ethereum** — establishing "a fraction of the resources"
requires a like-for-like benchmark (the same computation as an EVM contract vs. an XCL
contract, both measured), which is separate work and must not be asserted from this alone.
*(c)* `peakMemBytes` is the guest's **WASM linear memory only**; the worker's V8 heap —
which holds host-binding and marshalling allocations (e.g. XCL staging read-sets and
marshalling 32-byte words through a `host.source` binding) — is **capped** by
`maxOldGenerationSizeMb` (§2.2) but is **not metered**, so a guest that drives its cost
through host-side allocation rather than linear memory is under-billed on the memory term.

### C2 — `eval` of host source is a standing footgun

§4's `(0, eval)('(' + hostSource + ')')` is safe **only** under the trusted-caller
assumption. There is no in-code guard that the host source is caller-originated;
the safety is architectural/contractual. Audit should confirm no path routes
untrusted input into `host.source`, and consider a capability object passed by
structured clone instead of `eval` of a source string.

**Direction taken for crypto (T6.1-c).** The signature-verification host calls
(`env.xmbl_cubic_sig_verify` / `env.xmbl_mayo_verify`) do **not** inline Cubic-SIG or
MAYO math into an eval'd string. They use the `host.init` hook, an `async (ctx,
declared)` factory the worker **awaits before instantiation**, whose body `import()`s
the **real** `@xmbl/identity` module and returns synchronous verify bindings (loading
MAYO's Emscripten module once, only when the guest declares its import). This is the
"capability by real module, not eval'd source" direction this finding recommends: the
crypto path **shrinks** the eval surface rather than growing it. The signature material
is chain-staged via `ctx.data.crypto` (identical on every node), so a gated contract's
verdict is deterministic — a requirement, since `ContractHost` drives a shared root.

---

## 6. Open questions for the reviewer (NOT handled in-code)

- **O1 — Concurrency / aggregate caps.** Every property in §2 is **per-job**. A node
  that accepts many simultaneous jobs multiplies memory (cap × N) and threads (N) with
  **no global admission control** in this package. The DoS surface is aggregate, not
  per-job; a scheduler with total-resource caps is out of scope here and must exist
  above it.
- **O2 — Thread-spawn amplification.** Each job spawns a fresh `Worker` (`eval:true`,
  compiling `WORKER_SOURCE`). A flood of tiny jobs is a thread-creation DoS distinct
  from T1/T2; needs a worker pool or rate limit.
- **O3 — Side channels / covert channels.** Worker threads **share the process** (and
  hardware): timing, cache, and `SharedArrayBuffer`-free but still same-process memory
  pressure can leak across tenants. WASM has no high-resolution timer here, but
  co-tenancy timing/Spectre-class channels are **not** addressed and are a real
  concern for a multi-tenant paid surface. Threat model presently offers **no**
  mitigation beyond process/thread separation; true isolation may require
  process- or VM-level sandboxing.
- **O4 — Hand-rolled ULEB/section parser.** `readMemoryLimits` re-parses the binary
  to read limits the WASM API does not expose. It runs only post-`compile`, but should
  be **fuzzed** against adversarial section layouts to confirm it cannot be desynced
  from what the engine actually instantiates (a parser/engine disagreement on the
  memory max would defeat T2).
- **O5 — Nondeterminism on the contract path.** If contract results must be
  consensus-reproducible, the guest must be denied nondeterministic sources (float
  NaN bit patterns, `Date`, RNG); the deny-by-default import policy blocks host
  imports, but WASM-internal nondeterminism and the host module's own use of
  `Date.now`/RNG are not screened here.

---

## 7. Summary

| Property | Status |
|---|---|
| Wall-clock termination (cross-thread) | Enforced + tested (§2.1) |
| Bounded WASM/V8 memory | Enforced + tested (§2.2) |
| Deny-by-default imports, inert stubs | Enforced + tested (§2.3) |
| Host-hook staged read/write, per-call scoping | Enforced; trusted-caller assumption (§4) |
| **Metering → billing** | **Finding C1 — measurement CONNECTED (per-thread cpuMs + WASM-linear peak memory measured, priced); killed-job billing, worker-heap metering, EVM comparison still open** |
| `eval` of host source | Finding C2 — safe only by contract |
| Aggregate/concurrency caps | Open O1/O2 — out of scope here |
| Side/covert channels (co-tenancy) | Open O3 — unmitigated |
| Section-parser robustness | Open O4 — fuzz required |
| Contract determinism | Open O5 — unscreened |

The per-job isolation core (T1–T7) is enforced and tested. The **market** half —
metered billing (C1), aggregate admission control (O1/O2), and multi-tenant side
channels (O3) — is **not** production-ready and is the substance of what the ⛔ AUDIT
gate must resolve. This document claims nothing secure; it states precisely what is
enforced and what is open.
