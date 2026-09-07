import { chromium } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { writeFileSync } from 'node:fs'
const htmlPath = fileURLToPath(new URL('../dist-miniapp/live-bundle.html', import.meta.url))
const outDir = fileURLToPath(new URL('../dist-miniapp/', import.meta.url))
const b = await chromium.launch()
const p = await b.newPage()
const errs=[]; p.on('pageerror',e=>errs.push(e.message)); p.on('console',m=>m.type()==='error'&&errs.push(m.text()))
writeFileSync(outDir+'live-parent.html', `<!doctype html><body style="margin:0"><iframe sandbox="allow-scripts" style="width:820px;height:560px;border:0" src="file://${htmlPath}"></iframe></body>`)
await p.goto('file://'+outDir+'live-parent.html')
await p.waitForTimeout(800)
const fr = p.frames()[1]
const txt = (await fr.locator('#app').innerText()).replace(/\s+/g,' ').trim()
await p.screenshot({path:outDir+'live-profile.png'})
console.log('LIVE bundle in opaque-origin iframe rendered:', txt.includes('xmbl')&&txt.includes('runtime-as-dep')?'YES':'NO')
console.log('text:', txt.slice(0,120))
console.log('errors:', errs.length?errs.join('|'):'(none)')
await b.close()
