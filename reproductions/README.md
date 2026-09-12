# XMBL reproductions — auditor-runnable proofs of each module's headline claim

Each file here is a **self-contained reproduction**: it imports the module's REAL code (the same
`@xmbl/*` workspace packages that ship), exercises it to reproduce one headline claim, prints a
transcript an auditor reads, and **exits non-zero if the claim fails** — so every reproduction is
also a regression test in the `npm run test:protocol` hard gate.

This is what "reproducible in a miniapp" means for a protocol module (see `MODULE-STATUS.md`): a
content-addressed, one-command reproduction of the claim. Protocol claims (reentrancy, conservation,
metering, soundness) are reproduced under `node` — the faithful environment for worker-thread
isolation and CPU metering, which cannot exist in a browser sandbox. App-render claims are
reproduced on the handoff browser surface instead (`apps/app-builder/miniapp/verify.mjs`).

Run one:

```
node reproductions/contracts-reentrancy.mjs
```

Run all (and everything else in the gate):

```
npm run test:protocol
```

Each reproduction prints a **content address** — a SHA-256 over its own source plus the contract
sources it compiles — so a reviewer can confirm the exact bytes that produced the transcript.

| Reproduction | Module | Claim reproduced |
|--------------|--------|------------------|
| `contracts-reentrancy.mjs` | `packages/contracts` | A called contract never runs nested inside its caller's frame, so classic reentrancy is inexpressible by construction. |
