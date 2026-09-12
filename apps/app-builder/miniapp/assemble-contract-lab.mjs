// Transform the vite-singlefile output for the Contract Lab so it renders on BOTH handoff
// surfaces (same transform as assemble.mjs, for the dist-contract-lab build). handoff.js
// renderApp (feed) copies only <head> <style> and executes only <body> <script> as a blob
// module function body; the singlefile build emits the app as a <head><script type="module">,
// so we relocate it to <body> as a classic, import/export-free <script> (verified) and keep
// the styles in <head>.
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const dir = fileURLToPath(new URL('../dist-contract-lab/', import.meta.url))
// vite names the output after the entry (contract-lab.html); consume it and emit index.html.
const inPath = existsSync(dir + 'contract-lab.html') ? dir + 'contract-lab.html' : dir + 'index.html'
const src = readFileSync(inPath, 'utf8')

const styles = [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n')
const scriptM = src.match(/<script[^>]*>([\s\S]*?)<\/script>/)
if (!scriptM) throw new Error('no inlined script found in singlefile output')
const code = scriptM[1]

if (/(^|[;}\s])(import|export)[\s{*]/.test(code) || code.includes('import.meta')) {
  throw new Error('bundle has top-level ESM syntax; would break renderApp function-body wrapping')
}

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>XMBL Contract Lab</title>
<style>${styles}</style>
</head>
<body style="margin:0">
<div id="app"></div>
<script>${code}</script>
</body>
</html>`

writeFileSync(dir + 'index.html', html)
if (inPath !== dir + 'index.html') rmSync(inPath)
console.log(
  'assembled:',
  Buffer.byteLength(html),
  'bytes raw /',
  Buffer.from(html).toString('base64').length,
  'base64 (styles',
  styles.length,
  '/ script',
  code.length,
  ')'
)
