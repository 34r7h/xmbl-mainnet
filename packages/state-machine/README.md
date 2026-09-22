# @xmbl/state-machine

XMBL's state layer: a **Verkle tree** whose root moves as the chain applies transactions. A moving
state root is health, not drift.

```sh
npm install @xmbl/state-machine
```

## What it owns

| Export | What it is |
|---|---|
| `VerkleStateTree` | The tree. Proofs verify **independently** — `verkle-independent-verify.test.mjs` checks a proof against the root alone, with no access to the prover's tree. |
| `StateDiff` | An app-centric diff: what a transaction changes, as a value. |
| `StateShard` | Sharded state. |
| `StateAssembler` | Assembles diffs into current state. |
| `StateMachine` | The machine that applies diffs and **emits `state:committed`** when a cube commits a state root — the one moment the chain commits state must be observable outside this file. |

## Rehydration

State survives a restart: `rehydration.test.mjs` and `applied-count.test.mjs` hold the count of
applied diffs across a reopen, because a state machine that silently reapplies or silently skips is
indistinguishable from a working one until the root diverges.

## Tests

```sh
node ../../scripts/run-node-tests.mjs .
```
