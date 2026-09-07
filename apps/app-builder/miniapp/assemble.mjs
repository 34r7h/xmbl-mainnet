// Transform the vite-singlefile output so it renders on BOTH handoff surfaces.
// handoff.js renderApp (feed/market) copies only <head> <style> and executes only
// <body> <script> (as a blob module function body). The singlefile build emits the
// app as a <head><script type="module">; we relocate it to <body> as a classic
// <script> (import/export-free IIFE, verified) and keep styles in <head>.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const dir = fileURLToPath(new URL('../dist-miniapp/', import.meta.url))
const src = readFileSync(dir + 'index.html', 'utf8')

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
<title>xmbl miniapp</title>
<style>${styles}</style>
</head>
<body style="margin:0">
<div id="app"></div>
<script>${code}</script>
</body>
</html>`

writeFileSync(dir + 'index.html', html)
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
