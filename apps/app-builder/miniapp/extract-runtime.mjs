// Extract the assembled body <script> into a standalone runtime.js for the
// runtime-as-dep model (docs/app.md Part B). Run AFTER assemble.mjs.
// Produces in dist-miniapp/:
//   runtime.js         — the classic IIFE runtime (reads window.__XMBL__)
//   runtime-index.html — the runtime dep's own entry: loads runtime.js, no payload
//                        (falls back to DEFAULT_APP so the dep renders standalone)
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const dir = fileURLToPath(new URL('../dist-miniapp/', import.meta.url))
const src = readFileSync(dir + 'index.html', 'utf8')

const styles = [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n').trim()
const scriptM = src.match(/<script[^>]*>([\s\S]*?)<\/script>/)
if (!scriptM) throw new Error('no inlined script found (run assemble.mjs first)')
const code = scriptM[1]

if (/(^|[;}\s])(import|export)[\s{*]/.test(code) || code.includes('import.meta')) {
  throw new Error('runtime has top-level ESM syntax; would break renderApp function-body wrapping')
}
if (styles) {
  // The current build emits empty styles (all styling is inline in the descriptor).
  // If that ever changes, styles must be injected into the shadow root by runtime.js.
  throw new Error(`unexpected non-empty <style> (${styles.length}B) — extend extract-runtime to inject it`)
}

writeFileSync(dir + 'runtime.js', code)

// The runtime dep's standalone entry — references runtime.js by RELATIVE path so
// handoff's inlineAssets splices it in at bundle time (req A). No __XMBL__ → DEFAULT_APP.
const runtimeIndex = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>xmbl runtime</title>
</head>
<body style="margin:0">
<div id="app"></div>
<script src="runtime.js"></script>
</body>
</html>`
writeFileSync(dir + 'runtime-index.html', runtimeIndex)

console.log('extracted runtime.js:', Buffer.byteLength(code), 'bytes raw /',
  Buffer.from(code).toString('base64').length, 'base64')
