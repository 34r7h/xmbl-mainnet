# @xmbl/consensus

Consensus for XMBL: **you validate your own transaction.** No miners, no staking cartel. A
transaction whose user cannot be resolved never advances. Leads agree on a seal; the rest of the
network checks the same derivation and reaches the same answer.

```sh
npm install @xmbl/consensus
```

## What it owns

| Module | What it is |
|---|---|
| `validate.js` — `validateForConsensus`, `validateCanHappen`, `validateXidStage`, `validatePlacementStage`, `STAGES` | The staged validation pipeline. Each stage is separately callable, so a failure names the stage it failed at instead of a boolean. |
| `mempool.js` | The pending set, with an ingress guard — an invalid transaction is evicted, not queued (`ingress-guard.test.mjs`, `invalid-eviction.test.mjs`). |
| `leader-election.js` | Lead selection over the configured lead set. |
| `seal-round.js`, `seal-agreement.js` | A seal round and the agreement over its result. |
| `validation-tasks.js`, `validation-worker.js`, `validation-retry.js` | Validation work dispatched off the main thread, with retry — a validator that drops a report stalls a transaction at 1/3 forever. |
| `workflow.js` | The end-to-end path a transaction takes through the above. |
| `gossip.js` | Consensus message fan-out. |

## What is asserted

`byzantine-matrix.test.mjs` runs the honest/faulty matrix: the suite holds the properties under
faulty participants rather than asserting them in prose. Quorum is taken over the FIXED configured
lead set, never the presence-live subset — a network partition must not be able to shrink the
threshold it has to clear.

## Tests

```sh
node ../../scripts/run-node-tests.mjs .
```
