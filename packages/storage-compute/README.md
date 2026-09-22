# @xmbl/storage-compute

The storage and compute market: nodes sell disk and CPU, and the runtime that executes **untrusted,
third-party WASM for pay** is hardened to enforce its limits rather than assert them.

```sh
npm install @xmbl/storage-compute
```

## What it owns

| Export | What it is |
|---|---|
| `ComputeRuntime` | The sandbox. Guest code runs on a **dedicated Worker thread** the host can terminate, so a synchronous loop in the guest cannot wedge the event loop — a `Promise.race` "timeout" on the host thread can never fire against one. Memory is bounded and the import surface is policy, not default. |
| `ComputeNode` | A node offering compute to the market. |
| `StorageShard`, `StorageNode`, `computeProbeProof` | Sharded storage and the proof a node returns when probed. |
| `AvailabilityTester` | Availability probing — does the node that was paid still hold the data? |
| `MarketPricing` | Pricing for both resources. |

## The three properties the runtime enforces

1. **Wall-clock termination** — the guest runs where it can be killed.
2. **A memory bound** — set at instantiation, not hoped for.
3. **An import policy** — the guest reaches only what it was granted.

`compute.test.mjs` exercises these against guests that try to break each one.

## Tests

```sh
node ../../scripts/run-node-tests.mjs .
```
