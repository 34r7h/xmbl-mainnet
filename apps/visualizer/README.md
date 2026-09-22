# XMBL Explorer

A live, educational visualizer of the cube-curve ledger. It renders the real geometry of the chain:
raw transactions become blocks, exactly **9 blocks seal a face**, exactly **3 faces seal a cube**,
and cubes compose into the super-cube.

```sh
npm run visualizer          # from the repo root — serves on http://localhost:5180
```

No build step and no bundler: `index.html` plus `src/app.js` and `src/styles.css`, served statically.

## Live, or demo — and it always says which

Point it at a running node and it reads that node's status endpoint. With no node it runs a
**deterministic demo** so the mechanism is teachable on its own.

**Nothing here fabricates chain state it did not read.** The `demo` pill makes the difference
explicit on screen, because a visualizer that invents a plausible-looking chain is worse than no
visualizer: it is a screenshot of a system that does not exist.

## What you can watch

| | |
|---|---|
| Blocks → faces → cubes | The structure forming as transactions land, with placement derived — not negotiated — so every node builds the identical thing. |
| The state root | Moving as diffs apply. A moving root is health, not drift. |
| Explorer | Transactions by hash, with minimal information for ZK proofs. |

Private to this repo; it ships as the app, not as a published package. The drawing library it is the
front end for is [`@xmbl/visualizer`](../../packages/visualizer).
