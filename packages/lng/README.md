# @xmbl/lng

**LNG** — the XMBL smart-contract language. A standalone language with an interpreter, a type and
**determinism** checker, a WASM backend, an EVM/Solidity transpiler, and a Solidity importer. It owns
the language and nothing else: binding a compiled contract to the chain is `@xmbl/contracts`.

```sh
npm install @xmbl/lng
```

## What it owns

| Export | What it is |
|---|---|
| `run`, `lex`, `parse`, `INT_WIDTHS`, `isTypeName`, `intRange`, `DEC_ONE` | The interpreter and its front end. Fixed-width integers and a decimal type — no floats. |
| `check`, `checkDeterminism`, `assertDeterministic` | The type checker and the **determinism gate**. A contract that could behave differently on two nodes is refused at compile time, with the same message on both the node and browser paths. |
| `compile`, `contractFields` | The WASM backend. Compilation is byte-reproducible: the same source gives the same module bytes. |
| `transpile` | LNG → Solidity, for deploying the same contract to an EVM chain. |
| `importSolidity` | Solidity → LNG. |
| `VERSION` | The version of the code this process loaded. |

## Browser

`dist/lng.browser.js` is a committed, self-contained bundle that runs in a bare context — **no
`process`, no `Buffer`, no `require`** — and produces byte-identical WASM to the node build. It is
built by `npm run build:browser`; its `VERSION` is baked in at build time, so it must be rebuilt
whenever the package version moves (`browser-bundle.test.mjs` fails if it was not).

## Tests

```sh
node ../../scripts/run-node-tests.mjs .
```

Conformance, types, determinism, crypto, the EVM transpile and deploy paths, the Solidity import and
the browser bundle each have their own suite.
