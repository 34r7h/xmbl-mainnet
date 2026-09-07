// Local simulation of a payload-only composed app (docs/app.md Part B), so we can
// verify the window.__XMBL__ seam on both surfaces BEFORE spending a publish.
// Reproduces exactly what handoff's inlineAssets produces at bundle time: the entry
// with a __XMBL__ payload <script> first, then runtime.js inlined as a <script>.
// Writes dist-miniapp/index.html; run `node miniapp/verify.mjs` after.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const dir = fileURLToPath(new URL('../dist-miniapp/', import.meta.url))
const runtime = readFileSync(dir + 'runtime.js', 'utf8')

// A DISTINCTIVE payload — proves the composed descriptor (not DEFAULT_APP) rendered.
// Includes the tokens verify.mjs asserts ('xmbl' + 'runtime-as-dep') plus a unique marker.
const payload = {
  style: { background: '#0b0b0f', color: '#e8e8ea', minHeight: '100vh' },
  display: {
    main: {
      type: 'div',
      style: 'padding:28px 24px;max-width:760px;margin:0 auto;font-family:ui-sans-serif,system-ui,sans-serif;line-height:1.5',
      components: [
        {
          type: 'content',
          props: {
            xid: 'title',
            xtype: 'html',
            xvalue: '<b style="font-size:26px">xmbl</b> <span style="opacity:.6">· PAYLOAD-ONLY-DEMO</span>'
          }
        },
        {
          type: 'content',
          props: {
            xid: 'body',
            xtype: 'markdown',
            xvalue: 'This panel is **only a JSON payload** — the runtime came from a composed dep (runtime-as-dep). Ship JSON, host an app.'
          }
        }
      ]
    }
  }
}

const composed = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>xmbl payload-only demo</title>
</head>
<body style="margin:0">
<div id="app"></div>
<script>window.__XMBL__=${JSON.stringify(payload)};</script>
<script>${runtime}</script>
</body>
</html>`

writeFileSync(dir + 'index.html', composed)
console.log('composed sim:', Buffer.byteLength(composed), 'bytes (payload script + inlined runtime)')
