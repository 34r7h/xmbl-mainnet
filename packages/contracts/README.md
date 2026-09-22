# @xmbl/contracts

**XCL — the XMBL Contract Layer.** It binds a compiled contract to the running chain and owns only
that binding: placement, the slot ↔ Verkle mapping, and read-set / write-set staging.

Everything else is delegated, and no module re-implements another's job:

| Concern | Owner |
|---|---|
| the language, compilation to WASM | [`@xmbl/lng`](../lng) |
| executing the contract | [`@xmbl/storage-compute`](../storage-compute) (the hardened sandbox) |
| the state it reads and writes | [`@xmbl/state-machine`](../state-machine) (Verkle) |
| signatures and identity | [`@xmbl/identity`](../identity) |
| where the contract lives | [`@xmbl/cubic-ledger`](../cubic-ledger) (deterministic placement) |

```sh
npm install @xmbl/contracts
```

## Use

```js
import { /* XCL surface */ } from '@xmbl/contracts';
```

`index.js` re-exports `src/xcl/index.js` whole; `src/xcl/contract-host.js` is where placement, the
slot↔Verkle mapping and the read/write staging live.

## Tests

```sh
node ../../scripts/run-node-tests.mjs .
```
