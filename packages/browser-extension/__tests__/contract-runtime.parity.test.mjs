// Parity gate for the extension's in-page contract runtime.
//
// The extension deploys contracts by a content-addressed id it derives IN-PAGE (pure-JS SHA-256,
// no node, no crypto.subtle). This test proves that id is byte-identical to the one a node derives
// with @xmbl/contracts' `contractId`, for every starter sample — the same guarantee
// verify-contract-lab.mjs makes for the miniapp. If they ever diverge, a contract "deployed" in the
// extension would carry a different identity than the same bytes on a node, silently. Run with:
//   node __tests__/contract-runtime.parity.test.mjs
// (also the package's `npm test`).

import assert from 'node:assert'
import { buildContract, contractIdOf, contractCoordinatesOf, makeStore, callEntry, readField } from '../src/contract-runtime.js'
import { SAMPLES } from '../src/contract-samples.js'
import { contractId, contractCoordinates } from '@xmbl/contracts'

let checks = 0

// 1. id parity: extension contractIdOf(wasm) === node contractId(wasm), per sample.
for (const [name, s] of Object.entries(SAMPLES)) {
  const { wasm } = await buildContract(s.src)
  const mine = contractIdOf(wasm)
  const node = contractId(wasm)
  assert.strictEqual(mine, node, `${name}: extension id ${mine} must equal node id ${node}`)
  assert.ok(/^xc1_[0-9a-f]{64}$/.test(mine), `${name}: id must be xc1_<64 hex>`)
  checks++
}
console.log(`  id parity: ${checks}/${Object.keys(SAMPLES).length} samples — extension id byte-identical to node @xmbl/contracts`)

// 2. coordinate parity: same content-addressed plane a node places the contract on.
{
  const { wasm } = await buildContract(SAMPLES.Counter.src)
  const id = contractIdOf(wasm)
  const mine = contractCoordinatesOf(id)
  const node = contractCoordinates(id)
  assert.strictEqual(JSON.stringify(mine), JSON.stringify(node), 'Counter: extension coordinates must equal node coordinates')
  console.log('  coordinate parity: Counter plane byte-identical to node')
}

// 3. execution: the in-page executor actually runs the compiled bytecode and commits state.
{
  const b = await buildContract(SAMPLES.Counter.src)
  const store = makeStore()
  const r1 = await callEntry(b.wasm, store, 'inc', [])
  assert.strictEqual(r1, 1n, 'inc() must return 1')
  await callEntry(b.wasm, store, 'incBy', [41])
  assert.strictEqual(readField(store, 'count'), 42n, 'count must be 42 after inc + incBy(41)')
  const r3 = await callEntry(b.wasm, store, 'get', [])
  assert.strictEqual(r3, 42n, 'get() must return the committed 42')
  await callEntry(b.wasm, store, 'reset', [])
  assert.strictEqual(readField(store, 'count'), 0n, 'reset() must zero count')
  console.log('  execution: Counter inc/incBy/get/reset commit and read back correctly')
}

// 4. checked arithmetic still traps in-page (a debit below zero REVERTS, leaving state unmoved).
{
  const b = await buildContract(SAMPLES.Vault.src)
  const store = makeStore()
  await callEntry(b.wasm, store, 'deposit', [100])
  assert.strictEqual(readField(store, 'bal'), 100n, 'bal must be 100 after deposit')
  await assert.rejects(callEntry(b.wasm, store, 'withdraw', [250]), 'over-withdraw must REVERT (underflow trap)')
  assert.strictEqual(readField(store, 'bal'), 100n, 'bal must be unchanged after a reverted withdraw')
  console.log('  trap: Vault over-withdraw reverts, balance unmoved')
}

console.log('ALL EXTENSION CONTRACT-RUNTIME PARITY TESTS PASSED!')
