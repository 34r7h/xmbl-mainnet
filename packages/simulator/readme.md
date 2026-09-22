# @xmbl/simulator

Drives the whole XMBL system under load so the protocol is exercised end to end rather than module by
module: identities created, transactions posted, validations run, storage written, compute
scheduled, state diffs applied and assembled into current state.

```sh
npm install @xmbl/simulator
```

## Two modes

| Mode | For |
|---|---|
| **deterministic** | System e2e tests. The expected outcome is known exactly, so a divergence is a failure and not a maybe. |
| **random** | Chaos. Arrival order, faults and timing vary, which is where the invariants that only hold "usually" fall over. |

It runs indefinitely; the interesting output is what breaks, not what it prints.

## Where it sits

The simulator is the **integration surface**. Behaviour that belongs to libp2p, WebTorrent or the
network as a whole — discovery under NAT, gossip fan-out rounds, Kademlia routing-table poisoning —
is not unit-testable inside the module it passes through, and those gates are filed here and against
the external review rather than closed with an in-package mock. See
[MAINNET-GATES.md](../../MAINNET-GATES.md).

## Tests

```sh
node ../../scripts/run-node-tests.mjs .
```
