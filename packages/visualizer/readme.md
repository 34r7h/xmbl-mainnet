# @xmbl/visualizer

Real-time visualization of a running XMBL system: the cubic constructions (the main cube and the
partial ones being filled), the state machine, consensus mempools, storage use and compute activity,
plus a block explorer over transaction hashes.

This is the library. The app that renders it is the **[Explorer](../../apps/visualizer)**:

```sh
npm run visualizer          # from the repo root
```

## What it draws

| Surface | What you see |
|---|---|
| Cubic ledger | 9 blocks sealing a face, 3 faces sealing a cube, cubes composing into the super-cube — the structure forming as transactions land. |
| State machine | The Verkle root moving as diffs apply. A moving root is health. |
| Consensus | Mempool contents and the seal rounds over them. |
| Storage / compute | What the market is actually holding and running. |
| Explorer | Look up a transaction by hash; minimal information for ZK proofs. |

Private to this repo — it ships as part of the Explorer app, not as a published package.
