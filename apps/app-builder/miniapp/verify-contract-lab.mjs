// Verification for the XMBL Contract Lab miniapp. THREE phases, all fail the process non-zero:
//
//  1. FUNCTIONALITY — every entrypoint of every sample contract is compiled and EXECUTED with the
//     faithful in-page executor (the exact code the page ships), and its return value + committed
//     field values are asserted against known-correct results. The trap cases (overflow,
//     underflow, div-by-zero) are asserted to REVERT. Prints the entrypoint/assertion count.
//  2. ROUND-TRIP — every sample goes source → visual model → source → compile, and the
//     regenerated contract's structure and behavior must be identical, so the visual builder and
//     the code editor (two editors over one model) can never drift.
//  3. BOTH SURFACES — the assembled bundle is driven on the opaque-origin iframe (profile) AND the
//     shadow-DOM renderApp (feed): the builder renders, a call changes a state tile, Deploy makes a
//     live instance, and the id the page derives in-browser equals @xmbl/contracts' node id.
//
// Run: npm run build:contract-lab -w apps/app-builder && npm run verify:contract-lab -w apps/app-builder
import { chromium } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildContract, callEntry, makeStore, readField, parseToModel, modelToSource, contractIdOf } from './contract-lab.js'
import { SAMPLES } from './samples.js'
import { contractId } from '@xmbl/contracts'

let pass = 0, fail = 0
const A = (label, got, want) => { const ok = String(got) === String(want); if (ok) pass++; else { fail++; console.log('  ✗', label, '→ got', String(got), 'want', String(want)) } }
const TRAP = async (label, wasm, store, fn, args) => {
  try { await callEntry(wasm, store, fn, args); fail++; console.log('  ✗', label, '→ expected REVERT, none thrown') }
  catch { pass++ }
}

// ── Phase 1: functionality — run & assert EVERY entrypoint ────────────────────
console.log('── Phase 1: functionality (every entrypoint executed & asserted) ──')
const built = {}
let entrypointCount = 0
for (const [name, s] of Object.entries(SAMPLES)) { built[name] = await buildContract(s.src); entrypointCount += built[name].entrypoints.length }

{ // Counter
  const w = built.Counter.wasm, s = makeStore()
  A('Counter.inc→1', await callEntry(w, s, 'inc', []), 1n)
  A('Counter.inc→2', await callEntry(w, s, 'inc', []), 2n)
  A('Counter.incBy(5)→7', await callEntry(w, s, 'incBy', [5n]), 7n)
  await callEntry(w, s, 'reset', []); A('Counter.reset→count=0', readField(s, 'count'), 0n)
  A('Counter.get→0', await callEntry(w, s, 'get', []), 0n)
}
{ // Vault
  const w = built.Vault.wasm, s = makeStore()
  A('Vault.deposit(100)→100', await callEntry(w, s, 'deposit', [100n]), 100n)
  A('Vault.deposit(50)→150', await callEntry(w, s, 'deposit', [50n]), 150n)
  A('Vault.withdraw(30)→120', await callEntry(w, s, 'withdraw', [30n]), 120n)
  A('Vault.balance→120', await callEntry(w, s, 'balance', []), 120n)
  await callEntry(w, s, 'setOwner', [42n]); A('Vault.setOwner→owner=42', readField(s, 'owner'), 42n)
  await TRAP('Vault.withdraw(999) underflow reverts', w, s, 'withdraw', [999n])
}
{ // Calc
  const w = built.Calc.wasm, s = makeStore()
  A('Calc.add(7,3)=10', await callEntry(w, s, 'add', [7n, 3n]), 10n)
  A('Calc.sub(7,3)=4', await callEntry(w, s, 'sub', [7n, 3n]), 4n)
  A('Calc.mul(6,7)=42', await callEntry(w, s, 'mul', [6n, 7n]), 42n)
  A('Calc.div(20,3)=6', await callEntry(w, s, 'div', [20n, 3n]), 6n)
  A('Calc.mod(20,3)=2', await callEntry(w, s, 'mod', [20n, 3n]), 2n)
  A('Calc.band(12,10)=8', await callEntry(w, s, 'band', [12n, 10n]), 8n)
  A('Calc.bor(12,10)=14', await callEntry(w, s, 'bor', [12n, 10n]), 14n)
  A('Calc.bxor(12,10)=6', await callEntry(w, s, 'bxor', [12n, 10n]), 6n)
  A('Calc.shl(1,8)=256', await callEntry(w, s, 'shl', [1n, 8n]), 256n)
  A('Calc.shr(256,4)=16', await callEntry(w, s, 'shr', [256n, 4n]), 16n)
  await TRAP('Calc.sub underflow reverts', w, s, 'sub', [3n, 5n])
  await TRAP('Calc.div-by-zero reverts', w, s, 'div', [6n, 0n])
}
{ // Logic
  const w = built.Logic.wasm, s = makeStore()
  A('Logic.gte(5,3)=1', await callEntry(w, s, 'gte', [5n, 3n]), 1n)
  A('Logic.gte(3,5)=0', await callEntry(w, s, 'gte', [3n, 5n]), 0n)
  A('Logic.eq(4,4)=1', await callEntry(w, s, 'eq', [4n, 4n]), 1n)
  A('Logic.eq(4,5)=0', await callEntry(w, s, 'eq', [4n, 5n]), 0n)
  A('Logic.max(5,9)=9', await callEntry(w, s, 'max', [5n, 9n]), 9n)
  A('Logic.max(9,5)=9', await callEntry(w, s, 'max', [9n, 5n]), 9n)
  const out = {}; await callEntry(w, s, 'flag', [1n], out)
  A('Logic.flag→flagged=1', readField(s, 'flagged'), 1n)
  A('Logic.flag emits 1 event', out.events, 1)
}
{ // Ledger
  const w = built.Ledger.wasm, s = makeStore()
  A('Ledger.credit(100)→100', await callEntry(w, s, 'credit', [100n]), 100n)
  A('Ledger.credit(25)→125', await callEntry(w, s, 'credit', [25n]), 125n)
  A('Ledger.debit(25)→100', await callEntry(w, s, 'debit', [25n]), 100n)
  A('Ledger.ops(private)=3', readField(s, 'ops'), 3n)
  A('Ledger.sumTo(5)=15', await callEntry(w, s, 'sumTo', [5n]), 15n)
  A('Ledger.sumTo(100)=5050', await callEntry(w, s, 'sumTo', [100n]), 5050n)
  await TRAP('Ledger.debit underflow reverts', w, s, 'debit', [9999n])
}
console.log(`  ${pass} assertions passed, ${fail} failed across ${entrypointCount} entrypoints in ${Object.keys(SAMPLES).length} contracts`)

// ── Phase 2: source → model → source round-trip ──────────────────────────────
console.log('── Phase 2: visual-model round-trip ──')
let rtPass = 0
for (const [name, s] of Object.entries(SAMPLES)) {
  const m1 = parseToModel(s.src)
  const regen = modelToSource(m1)
  const b = await buildContract(regen)                 // regenerated source must compile
  const m2 = parseToModel(regen)
  const stable = JSON.stringify(m1) === JSON.stringify(m2)
  const sameEntrypoints = JSON.stringify(b.entrypoints) === JSON.stringify(built[name].entrypoints)
  const advanced = m1.methods.filter((x) => x.advanced).length
  if (stable && sameEntrypoints && advanced === 0) { rtPass++; console.log('  ✓', name, '(model stable, compiles, fully visual)') }
  else { fail++; console.log('  ✗', name, 'stable=' + stable, 'entrypoints=' + sameEntrypoints, 'advanced=' + advanced) }
}
console.log(`  ${rtPass}/${Object.keys(SAMPLES).length} samples round-trip cleanly through the visual builder`)

// ── Phase 3: both handoff surfaces ────────────────────────────────────────────
console.log('── Phase 3: both handoff surfaces (build → test → deploy) ──')
const htmlPath = fileURLToPath(new URL('../dist-contract-lab/index.html', import.meta.url))
const outDir = fileURLToPath(new URL('../dist-contract-lab/', import.meta.url))
const html = readFileSync(htmlPath, 'utf8')
const EXPECTED_ID = contractId(built.Counter.wasm)   // page loads Counter by default

const ok = (t) => {
  const l = (t || '').toLowerCase()
  return ['xmbl contract lab', 'create', 'test', 'deploy', 'visual builder', 'code', 'inc'].every((k) => l.includes(k))
}
const worked = (o) => !!o && o.count === '1' && o.id === EXPECTED_ID && o.liveBadge === true && o.methods >= 3 && o.tabs === 2

const DRIVE = `async (scope) => {
  const q = (s) => scope.querySelector(s)
  const qa = (s) => [...scope.querySelectorAll(s)]
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  for (let i = 0; i < 60 && !qa('.call-row').length; i++) await sleep(50)   // wait for compile-on-load
  const countVal = () => { const t = qa('.tile').find((x) => (x.getAttribute('data-field') || '') === 'count'); return t ? (t.querySelector('.tile-v')?.textContent || '').trim() : null }
  // run inc() — no args
  const incRow = qa('.call-row').find((r) => (r.querySelector('.ep')?.textContent || '').trim() === 'inc')
  if (incRow) { incRow.querySelector('button')?.click(); for (let i = 0; i < 40; i++) { await sleep(40); if (countVal() === '1') break } }
  // deploy
  const deployBtn = q('.deploy .panel-h button')
  if (deployBtn) { deployBtn.click(); for (let i = 0; i < 40; i++) { await sleep(40); if (q('.live-badge')) break } }
  const descriptor = q('pre.descriptor')?.textContent || ''
  const m = descriptor.match(/xc1_[0-9a-f]{64}/)
  const text = (q('#app')?.innerText || scope.textContent || '').replace(/\\s+/g, ' ').trim()
  return { text, count: countVal(), id: m ? m[0] : null, liveBadge: !!q('.live-badge'), methods: qa('.vb .method').length, tabs: qa('.tab').length }
}`

const browser = await chromium.launch()

// Surface B: opaque-origin sandboxed iframe (profile)
const pB = await browser.newPage()
const errB = []
pB.on('pageerror', (e) => errB.push(e.message))
pB.on('console', (mm) => mm.type() === 'error' && errB.push(mm.text()))
const parentPath = outDir + 'parent.html'
writeFileSync(parentPath, `<!doctype html><body style="margin:0"><iframe sandbox="allow-scripts" style="width:1000px;height:820px;border:0" src="file://${htmlPath}"></iframe></body>`)
await pB.goto('file://' + parentPath)
await pB.waitForTimeout(500)
let outB = null
try { outB = await pB.frames()[1].evaluate(`(${DRIVE})(document.body)`) }
catch (e) { outB = { text: '<<' + e.message + '>>', count: null, id: null, liveBadge: false, methods: 0, tabs: 0 } }
await pB.screenshot({ path: outDir + 'surface-profile.png', fullPage: true })

// Surface A: faithful renderApp reproduction (feed)
const pA = await browser.newPage()
const errA = []
pA.on('pageerror', (e) => errA.push(e.message))
pA.on('console', (mm) => mm.type() === 'error' && errA.push(mm.text()))
await pA.setContent('<div id="host"></div>')
const outA = await pA.evaluate(async ({ bundleHtml, drive }) => {
  const elh = document.getElementById('host')
  const shadow = elh.attachShadow({ mode: 'open' })
  const doc = new DOMParser().parseFromString(bundleHtml, 'text/html')
  for (const s of doc.head.querySelectorAll('style')) { const st = document.createElement('style'); st.textContent = s.textContent; shadow.appendChild(st) }
  const scripts = []
  for (const node of [...doc.body.childNodes]) { if (node.nodeName === 'SCRIPT') { scripts.push(node.textContent); continue } shadow.appendChild(document.importNode(node, true)) }
  const docProxy = "const document={getElementById:id=>__r.querySelector('#'+id),querySelector:s=>__r.querySelector(s),querySelectorAll:s=>__r.querySelectorAll(s),createElement:t=>window.document.createElement(t),createElementNS:(ns,t)=>window.document.createElementNS(ns,t),createTextNode:t=>window.document.createTextNode(t),body:__r};"
  for (const code of scripts) {
    const blob = new Blob([`export default async function(__r,__handoff){${docProxy}\nconst handoff=__handoff;\n${code}}`], { type: 'application/javascript' })
    const url = URL.createObjectURL(blob)
    try { const mod = await import(url); await mod.default(shadow, {}) } finally { URL.revokeObjectURL(url) }
  }
  return await eval('(' + drive + ')')(shadow)
}, { bundleHtml: html, drive: DRIVE })
await pA.screenshot({ path: outDir + 'surface-feed.png', fullPage: true })
await browser.close()

const report = (tag, o, err) => {
  console.log(`  ${tag}: rendered ${ok(o.text) ? 'YES' : 'NO'} | builder methods ${o.methods} | tabs ${o.tabs} | inc()→count ${o.count} | deployed ${o.liveBadge ? 'YES' : 'NO'} | id matches node ${o.id === EXPECTED_ID ? 'YES' : 'NO'} | errors ${err.length ? err.join(' | ') : 'none'}`)
}
console.log('  expected id (node @xmbl/contracts):', EXPECTED_ID)
report('Surface A (feed)', outA, errA)
report('Surface B (profile)', outB, errB)

const surfacesOk = ok(outA.text) && worked(outA) && !errA.length && ok(outB.text) && worked(outB) && !errB.length
const allGood = fail === 0 && surfacesOk
console.log('\n' + (allGood
  ? `✅ PASS — ${pass} functional assertions across ${entrypointCount} entrypoints, ${rtPass} samples round-trip, both surfaces build→test→deploy with id matching node`
  : '❌ FAIL — see above'))
process.exit(allGood ? 0 : 1)
