# @xmbl/cubic-ledger

The ledger. **Not a linear chain**: transactions are hashed into blocks, **9 blocks seal a face**,
**3 faces seal a cube**, and cubes compose into the super-cube. Membership is a pure function of the
block *set*, so every node independently builds the identical structure — placement is derived, never
negotiated.

```sh
npm install @xmbl/cubic-ledger
```

## What it owns

| Export | What it is |
|---|---|
| `Ledger` | The store: append, read, rebuild, and the anchoring pipeline. `anchorTimestampNanos` / `blockTimestampNanos` / `consensusBody` / `contentKey` are the exact derivations consensus agrees over. |
| `Block`, `Face`, `Cube`, `SuperCube` | The geometry. A block's content address is derived from the WHOLE transaction. |
| `calculateDigitalRoot` | The digital root that drives placement. |
| `getBlockPosition`, `getFaceIndex`, `verifyPlacement` | **Deterministic placement.** Where a block lands is computable by anyone and checkable by everyone. |
| `validateTransaction`, `validateShape`, `validateXid`, `getTransactionType`, `typeCodeOf`, `typeOfXid` | Transaction validation and the type system. |
| `micromine`, `micromineTx`, `micromineBody`, `verifyMicromine`, `oidOf`, `type6TxBody`, `type7PointerBody` | Micromine — the small proof-of-work each transaction carries. |
| `CubeSyncManager`, `verifyCube`, `planAdoption`, `diffWanted`, `setDigest`, `TOPIC_DIGEST`, `TOPIC_LIST`, `TOPIC_CUBE` | Cube sync: the gossip topics and the adoption plan a node computes before it accepts anything. |

## Determinism is the property

Two nodes given the same block set must produce byte-identical cubes, faces and roots. That is
asserted directly (`ledger-determinism.test.mjs`, `micromine.golden.test.mjs`,
`cube-sync-adversarial.test.mjs`, `xid-poisoning.test.mjs`) rather than assumed — an adversarial peer
must not be able to steer placement, poison an xid, or make a rebuild drop value transactions.

## Tests

```sh
node ../../scripts/run-node-tests.mjs .
```
