// Faithful two-surface verification.
// Surface B (profile): opaque-origin <iframe sandbox="allow-scripts"> loading the bundle.
// Surface A (feed): reproduces handoff.js renderApp EXACTLY — attach a shadow root,
//   copy <head> <style>, collect <body> <script> textContent, run each as a blob
//   module `export default async function(__r,__handoff){<docProxy>...code}` with the
//   restricted document proxy. This is the real path my earlier test skipped.
import { chromium } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const htmlPath = fileURLToPath(new URL('../dist-miniapp/index.html', import.meta.url))
const outDir = fileURLToPath(new URL('../dist-miniapp/', import.meta.url))
const html = readFileSync(htmlPath, 'utf8')
const ok = (t) => {
  const l = (t || '').toLowerCase()
  return l.includes('xmbl') && l.includes('visual app builder') && l.includes('inspector') && l.includes('canvas')
}
// Export fired if the drawer shows a real payload entry_html; canvas add works if a <canvas> appears.
const built = (o) => !!o && typeof o.entry === 'string' && o.entry.includes('__XMBL__') && o.entry.includes('runtime.js') && o.entry.includes('"display"') && o.hasCanvas === true

const browser = await chromium.launch()

// ---- Surface B: opaque-origin sandboxed iframe (profile) --------------------
const pB = await browser.newPage()
const errB = []
pB.on('pageerror', (e) => errB.push(e.message))
pB.on('console', (m) => m.type() === 'error' && errB.push(m.text()))
const parentPath = outDir + 'parent.html'
writeFileSync(
  parentPath,
  `<!doctype html><body style="margin:0"><iframe sandbox="allow-scripts" style="width:820px;height:560px;border:0" src="file://${htmlPath}"></iframe></body>`
)
await pB.goto('file://' + parentPath)
await pB.waitForTimeout(800)
let textB = ''
let builtB = null
try {
  const fr = pB.frames()[1]
  textB = (await fr.locator('#app').innerText()).replace(/\s+/g, ' ').trim()
  await fr.locator('button:has-text("Canvas")').first().click({ timeout: 2000 })
  await pB.waitForTimeout(60)
  await fr.locator('button:has-text("Export payload")').first().click({ timeout: 2000 })
  await pB.waitForTimeout(80)
  const entry = (await fr.locator('pre').first().textContent()) || ''
  const hasCanvas = (await fr.locator('canvas').count()) > 0
  builtB = { entry, hasCanvas }
} catch (e) {
  textB = '<<' + e.message + '>>'
}
await pB.screenshot({ path: outDir + 'surface-profile.png' })

// ---- Surface A: faithful renderApp reproduction (feed/market) ---------------
const pA = await browser.newPage()
const errA = []
pA.on('pageerror', (e) => errA.push(e.message))
pA.on('console', (m) => m.type() === 'error' && errA.push(m.text()))
await pA.setContent('<div id="host"></div>')
const textA = await pA.evaluate(async (bundleHtml) => {
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
    if (node.nodeName === 'SCRIPT') {
      scripts.push(node.textContent)
      continue
    }
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
    try {
      const mod = await import(url)
      await mod.default(shadow, {})
    } finally {
      URL.revokeObjectURL(url)
    }
  }
  await new Promise((r) => setTimeout(r, 300))
  const text = (shadow.querySelector('#app')?.innerText || shadow.textContent || '').replace(/\s+/g, ' ').trim()
  // Exercise the builder: add a Canvas component, then Export the payload.
  const findBtn = (txt) => [...shadow.querySelectorAll('button')].find((b) => (b.textContent || '').includes(txt))
  let built = null
  const addCanvas = findBtn('Canvas')
  if (addCanvas) {
    addCanvas.click()
    await new Promise((r) => setTimeout(r, 60))
    findBtn('Export payload')?.click()
    await new Promise((r) => setTimeout(r, 80))
    const entry = shadow.querySelector('pre')?.textContent || ''
    const hasCanvas = !!shadow.querySelector('canvas')
    built = { entry, hasCanvas }
  }
  return { text, built }
}, html)
await pA.screenshot({ path: outDir + 'surface-feed.png' })

await browser.close()

console.log('=== Surface A (feed — faithful renderApp) ===')
console.log('  rendered:', ok(textA.text) ? 'YES' : 'NO', '| errors:', errA.length ? errA.join(' | ') : 'none')
console.log('  add-canvas + export fired:', built(textA.built) ? 'YES' : 'NO', '| canvas:', textA.built?.hasCanvas)
console.log('  text:', textA.text.slice(0, 140))
console.log('=== Surface B (profile — opaque-origin iframe) ===')
console.log('  rendered:', ok(textB) ? 'YES' : 'NO', '| errors:', errB.length ? errB.join(' | ') : 'none')
console.log('  add-canvas + export fired:', built(builtB) ? 'YES' : 'NO', '| canvas:', builtB?.hasCanvas)
console.log('  text:', textB.slice(0, 140))

const allGood = ok(textA.text) && built(textA.built) && ok(textB) && built(builtB) && !errA.length && !errB.length
console.log('\n' + (allGood ? '✅ PASS — both surfaces render + builder fires' : '❌ FAIL — see above'))
process.exit(allGood ? 0 : 1)
