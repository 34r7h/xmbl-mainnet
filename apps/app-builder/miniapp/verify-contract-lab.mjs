// Faithful two-surface verification of the XMBL Contract Lab miniapp.
// Surface B (profile): opaque-origin <iframe sandbox="allow-scripts"> loading the bundle.
// Surface A (feed): reproduces handoff.js renderApp EXACTLY — a shadow root, copied <head>
//   <style>, and each <body> <script> run as a blob module function body
//   `export default async function(__r,__handoff){<docProxy>...code}` with the restricted
//   document proxy.
// On BOTH surfaces it asserts the lifecycle actually works: the compiler-derived fields and
// entrypoints render, calling an entrypoint changes a field's committed value, and the
// content-addressed `xc1_` id appears in the Deploy stage. It ALSO proves the id the page
// derives in-browser equals the id @xmbl/contracts derives in node over the same bytes — so
// the Deploy panel is trustworthy, not a look-alike string.
import { chromium } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildContract, SAMPLES } from './contract-lab.js'
import { contractId } from '@xmbl/contracts'

const htmlPath = fileURLToPath(new URL('../dist-contract-lab/index.html', import.meta.url))
const outDir = fileURLToPath(new URL('../dist-contract-lab/', import.meta.url))
const html = readFileSync(htmlPath, 'utf8')

// Node-side expected identity over the SAME compiled bytes the page compiles on load.
const { wasm: vaultWasm } = await buildContract(SAMPLES.Vault)
const EXPECTED_ID = contractId(vaultWasm)

const ok = (t) => {
  const l = (t || '').toLowerCase()
  return l.includes('xmbl contract lab') && l.includes('create') && l.includes('test') &&
    l.includes('deploy') && l.includes('entrypoints') && l.includes('deposit')
}
// The lifecycle worked if: a call changed bal to 100, and the derived id matches node's.
const worked = (o) => !!o && o.bal === '100' && o.id === EXPECTED_ID && o.idMatchesOwn === true

// The in-shadow / in-frame driver: compile-on-load has run; set deposit's arg to 100, call it,
// read back bal, and read the derived contract id from the Deploy descriptor. Returns a plain
// object (must be serializable across the evaluate boundary).
const DRIVE = `async (scope) => {
  const q = (s) => scope.querySelector(s)
  const qa = (s) => [...scope.querySelectorAll(s)]
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  // Wait for the async compile-on-load to render entrypoints.
  for (let i = 0; i < 40 && !qa('.call-row').length; i++) await sleep(50)
  const rows = qa('.call-row')
  const depositRow = rows.find((r) => (r.querySelector('.ep')?.textContent || '').trim() === 'deposit')
  if (depositRow) {
    const inp = depositRow.querySelector('input.arg')
    if (inp) inp.value = '100'
    depositRow.querySelector('button')?.click()
    for (let i = 0; i < 40; i++) { await sleep(50); if (balOf() === '100') break }
  }
  function balOf() {
    const cell = qa('.state-cell').find((c) => (c.querySelector('.sc-name')?.textContent || '').trim() === 'bal')
    return cell ? (cell.querySelector('.sc-val')?.textContent || '').trim() : null
  }
  // The derived id lives in the Deploy descriptor <pre> and the 'Contract id' kv row.
  const descriptor = q('pre.descriptor')?.textContent || ''
  let id = null, idMatchesOwn = false
  const m = descriptor.match(/xc1_[0-9a-f]{64}/)
  if (m) { id = m[0]; idMatchesOwn = (descriptor.match(/xc1_[0-9a-f]{64}/g) || []).every((x) => x === id) }
  const text = (q('#app')?.innerText || scope.textContent || '').replace(/\\s+/g, ' ').trim()
  return { text, bal: balOf(), id, idMatchesOwn }
}`

const browser = await chromium.launch()

// ---- Surface B: opaque-origin sandboxed iframe (profile) --------------------
const pB = await browser.newPage()
const errB = []
pB.on('pageerror', (e) => errB.push(e.message))
pB.on('console', (m) => m.type() === 'error' && errB.push(m.text()))
const parentPath = outDir + 'parent.html'
writeFileSync(
  parentPath,
  `<!doctype html><body style="margin:0"><iframe sandbox="allow-scripts" style="width:900px;height:700px;border:0" src="file://${htmlPath}"></iframe></body>`
)
await pB.goto('file://' + parentPath)
await pB.waitForTimeout(400)
let outB = null
try {
  const fr = pB.frames()[1]
  outB = await fr.evaluate(`(${DRIVE})(document.body)`)
} catch (e) {
  outB = { text: '<<' + e.message + '>>', bal: null, id: null, idMatchesOwn: false }
}
await pB.screenshot({ path: outDir + 'surface-profile.png', fullPage: true })

// ---- Surface A: faithful renderApp reproduction (feed/market) ---------------
const pA = await browser.newPage()
const errA = []
pA.on('pageerror', (e) => errA.push(e.message))
pA.on('console', (m) => m.type() === 'error' && errA.push(m.text()))
await pA.setContent('<div id="host"></div>')
const outA = await pA.evaluate(async ({ bundleHtml, drive }) => {
  const el = document.getElementById('host')
  const shadow = el.attachShadow({ mode: 'open' })
  const doc = new DOMParser().parseFromString(bundleHtml, 'text/html')
  for (const s of doc.head.querySelectorAll('style')) {
    const st = document.createElement('style')
    st.textContent = s.textContent
    shadow.appendChild(st)
  }
  const scripts = []
  for (const node of [...doc.body.childNodes]) {
    if (node.nodeName === 'SCRIPT') { scripts.push(node.textContent); continue }
    shadow.appendChild(document.importNode(node, true))
  }
  const docProxy =
    "const document={getElementById:id=>__r.querySelector('#'+id),querySelector:s=>__r.querySelector(s),querySelectorAll:s=>__r.querySelectorAll(s),createElement:t=>window.document.createElement(t),createElementNS:(ns,t)=>window.document.createElementNS(ns,t),createTextNode:t=>window.document.createTextNode(t),body:__r};"
  for (const code of scripts) {
    const blob = new Blob(
      [`export default async function(__r,__handoff){${docProxy}\nconst handoff=__handoff;\n${code}}`],
      { type: 'application/javascript' }
    )
    const url = URL.createObjectURL(blob)
    try { const mod = await import(url); await mod.default(shadow, {}) } finally { URL.revokeObjectURL(url) }
  }
  const driver = eval('(' + drive + ')')
  return await driver(shadow)
}, { bundleHtml: html, drive: DRIVE })
await pA.screenshot({ path: outDir + 'surface-feed.png', fullPage: true })

await browser.close()

console.log('expected contract id (node @xmbl/contracts):', EXPECTED_ID)
console.log('=== Surface A (feed — faithful renderApp) ===')
console.log('  rendered:', ok(outA.text) ? 'YES' : 'NO', '| errors:', errA.length ? errA.join(' | ') : 'none')
console.log('  deposit(100) → bal:', outA.bal, '| derived id:', outA.id, '| matches node:', outA.id === EXPECTED_ID)
console.log('  lifecycle worked:', worked(outA) ? 'YES' : 'NO')
console.log('  text:', (outA.text || '').slice(0, 160))
console.log('=== Surface B (profile — opaque-origin iframe) ===')
console.log('  rendered:', ok(outB.text) ? 'YES' : 'NO', '| errors:', errB.length ? errB.join(' | ') : 'none')
console.log('  deposit(100) → bal:', outB.bal, '| derived id:', outB.id, '| matches node:', outB.id === EXPECTED_ID)
console.log('  lifecycle worked:', worked(outB) ? 'YES' : 'NO')
console.log('  text:', (outB.text || '').slice(0, 160))

const allGood = ok(outA.text) && worked(outA) && ok(outB.text) && worked(outB) && !errA.length && !errB.length
console.log('\n' + (allGood ? '✅ PASS — both surfaces: create → test (state changed) → deploy (id matches node)' : '❌ FAIL — see above'))
process.exit(allGood ? 0 : 1)
