// main.miniapp.js — xmbl compiled as a self-contained handoff miniapp.
//
// Two modes, one bundle:
//   • PAYLOAD app  — a composed app sets `window.__XMBL__ = {descriptor}` before this
//                    runtime loads; we render it with the real layout + content.
//   • BUILDER      — no payload → we mount the VISUAL APP BUILDER: a palette, a live
//                    WYSIWYG stage (real xmbl components), an inspector, an interactive
//                    canvas widget, and an export drawer (descriptor JSON + host command).
//
// Boot seams illegal in the render sandbox are bypassed (not reimplemented):
//   state.js fetch('/defaults/*.json') → inlined; db.js localStorage / git.js LightningFS → not imported.
// Interactivity uses Vue reactivity + addEventListener only — NO `new Function`/eval, so it
// survives the shadow-DOM feed surface AND the stricter opaque-origin iframe.

import { createApp, h, reactive, ref, onMounted } from 'vue'
import layout from '../src/components/layout.vue'
import content from '../src/components/content.vue'

// The published xmbl runtime dependency (compose payload apps against this).
const RUNTIME_HASH = '67f42503b5f285aa201cad372f9255697ee6e13353af6f5a'

// Feed/market surface runs this as a blob module with a RESTRICTED `document` proxy.
// Vue needs a few more methods (createComment for fragment anchors, etc.) — backfill
// them from the real document; DOM queries stay scoped to the shadow via the proxy.
if (typeof document !== 'undefined' && typeof document.createComment !== 'function') {
  const rd = window.document
  for (const m of ['createComment', 'createDocumentFragment', 'createTextNode', 'createElement', 'createElementNS', 'importNode']) {
    if (typeof document[m] !== 'function') document[m] = (...a) => rd[m](...a)
  }
}

// --- minimal faithful $api ----------------------------------------------------
async function sha256hex(str) {
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str))
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
  } catch {
    let hHi = 0xdeadbeef, hLo = 0x41c6ce57
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i)
      hHi = Math.imul(hHi ^ c, 2654435761)
      hLo = Math.imul(hLo ^ c, 1597334677)
    }
    return (hHi >>> 0).toString(16).padStart(8, '0') + (hLo >>> 0).toString(16).padStart(8, '0')
  }
}
const $api = {
  init() {},
  get() { return undefined },
  utils({ utype, udata }) {
    if (utype === 'hash') {
      const p = typeof udata?.content === 'string' ? udata.content : JSON.stringify(udata?.content ?? '')
      return sha256hex(p).then((full) => [full, 'x' + full.slice(0, 12)])
    }
    if (utype === 'validate') return true
    if (utype === 'compact') return (udata || []).filter((x) => x !== '' && x != null)
    return undefined
  }
}

const $state = reactive({ app: {}, db: { data: {} }, config: {}, scopes: { scopes: {} }, show: {} })
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// =============================================================================
// The palette: each xmbl component type the builder can place, with how it maps
// to real xmbl `content`/`general` descriptor props for both preview and export.
// =============================================================================
const PALETTE = [
  { t: 'heading', label: 'Heading', def: 'New heading' },
  { t: 'text', label: 'Text', def: 'Some **markdown** text.' },
  { t: 'html', label: 'HTML', def: '<em>raw html</em>' },
  { t: 'list', label: 'List', def: 'first item\nsecond item' },
  { t: 'image', label: 'Image', def: 'https://picsum.photos/480/200' },
  { t: 'canvas', label: 'Canvas', def: '' }
]
const defFor = (t) => (PALETTE.find((p) => p.t === t) || {}).def || ''

// Map a builder item → an xmbl descriptor component (the thing that gets exported/hosted).
function toDescriptor(item) {
  const xid = item.id
  if (item.t === 'heading') return { type: 'content', props: { xid, xtype: 'html', xvalue: '<h2 style="margin:0 0 8px">' + esc(item.value) + '</h2>' } }
  if (item.t === 'text') return { type: 'content', props: { xid, xtype: 'markdown', xvalue: item.value } }
  if (item.t === 'html') return { type: 'content', props: { xid, xtype: 'html', xvalue: item.value } }
  if (item.t === 'list') return { type: 'content', props: { xid, xtype: 'olist', xvalue: item.value.split('\n').map((s) => s.trim()).filter(Boolean) } }
  if (item.t === 'image') return { type: 'content', props: { xid, xtype: 'image', xvalue: item.value } }
  if (item.t === 'canvas') {
    // Exports as a `general` component: an interactive scribble canvas whose draw
    // handler is wired through xmbl's xelements/xmethods (the owner's canvas feature).
    return {
      type: 'general',
      props: {
        xid,
        xelements: [{ tag: 'canvas', id: xid + '-cv', style: { width: '100%', height: '180px', border: '1px solid #2a2a33', borderRadius: '8px', background: '#0e0e14', touchAction: 'none', cursor: 'crosshair' }, events: { pointerdown: 'draw', pointermove: 'draw' } }],
        xmethods: { draw: "if(event.type==='pointerdown')ctx.on=true;if(event.type==='pointermove'&&!ctx.on)return;var c=event.target,b=c.getBoundingClientRect(),x=event.clientX-b.left,y=event.clientY-b.top,g=c.getContext('2d');g.fillStyle='#7aa2ff';g.beginPath();g.arc(x,y,3,0,7);g.fill();" }
      }
    }
  }
  return { type: 'content', props: { xid, xtype: 'text', xvalue: item.value } }
}

// Live preview of a single item using the REAL xmbl content component (canvas gets a
// dedicated interactive widget so the stage is genuinely WYSIWYG + interactive).
const CanvasWidget = {
  setup() {
    const el = ref(null)
    onMounted(() => {
      const c = el.value
      if (!c || !c.getContext) return
      const g = c.getContext('2d')
      let on = false
      const dot = (e) => {
        const b = c.getBoundingClientRect()
        g.fillStyle = '#7aa2ff'
        g.beginPath()
        g.arc(e.clientX - b.left, e.clientY - b.top, 3, 0, 7)
        g.fill()
      }
      c.addEventListener('pointerdown', (e) => { on = true; dot(e) })
      c.addEventListener('pointermove', (e) => { if (on) dot(e) })
      c.addEventListener('pointerup', () => { on = false })
      c.addEventListener('pointerleave', () => { on = false })
    })
    return () => h('canvas', { ref: el, width: 480, height: 180, style: 'width:100%;height:180px;display:block;border:1px solid #2a2a33;border-radius:8px;background:#0e0e14;touch-action:none;cursor:crosshair' })
  }
}
function previewOf(item) {
  if (item.t === 'canvas') return h(CanvasWidget, { key: item.id + '-cv' })
  const d = toDescriptor(item)
  return h(content, { key: item.id, ...d.props })
}

// =============================================================================
// The visual builder.
// =============================================================================
const btn = (extra) => 'background:#1b1b24;color:#e8e8ea;border:1px solid #2a2a33;border-radius:8px;padding:7px 12px;font:inherit;font-size:13px;cursor:pointer;' + (extra || '')
const Builder = {
  setup() {
    const items = reactive([])
    const sel = ref(null)
    const showOut = ref(false)
    let nid = 1
    const add = (t) => { const id = 'c' + nid++; items.push({ id, t, value: defFor(t) }); sel.value = id }
    const remove = (id) => { const i = items.findIndex((x) => x.id === id); if (i >= 0) items.splice(i, 1); if (sel.value === id) sel.value = null }
    const move = (id, dir) => { const i = items.findIndex((x) => x.id === id); const j = i + dir; if (j < 0 || j >= items.length) return; const [x] = items.splice(i, 1); items.splice(j, 0, x) }
    const selected = () => items.find((x) => x.id === sel.value)

    const descriptor = () => ({
      style: { background: '#0b0b0f', color: '#e8e8ea', minHeight: '100vh' },
      display: { main: { type: 'div', style: 'padding:28px 24px;max-width:760px;margin:0 auto;font-family:ui-sans-serif,system-ui,sans-serif;line-height:1.5', components: items.map(toDescriptor) } }
    })
    const entryHtml = () => {
      const json = JSON.stringify(descriptor(), null, 2)
      const tag = '<' + '/script>'
      return '<body>\n  <script>window.__XMBL__ = ' + json + ';' + tag + '\n  <script src="runtime.js">' + tag + '\n</body>'
    }

    // seed with a couple items so the stage is not empty on first view
    add('heading'); add('text'); items[0].value = 'My xmbl app'

    return () => {
      const s = selected()
      return h('div', { style: 'background:#0b0b0f;color:#e8e8ea;min-height:100vh;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;line-height:1.5' }, [
        // header
        h('div', { style: 'padding:20px 22px 0;max-width:1040px;margin:0 auto' }, [
          h('div', { style: 'display:flex;align-items:center;gap:10px' }, [
            h('b', { style: 'font-size:24px' }, 'xmbl'),
            h('span', { style: 'opacity:.6;font-size:13px' }, '· visual app builder — place components, edit live, publish a hostable payload')
          ]),
          h('hr', { style: 'border:none;border-top:1px solid #2a2a33;margin:14px 0 0' })
        ]),
        // toolbar
        h('div', { style: 'padding:14px 22px;max-width:1040px;margin:0 auto;display:flex;flex-wrap:wrap;gap:8px;align-items:center' }, [
          h('span', { style: 'font-size:12px;opacity:.6;text-transform:uppercase;letter-spacing:.5px;margin-right:4px' }, 'Add'),
          ...PALETTE.map((p) => h('button', { style: btn(), onClick: () => add(p.t) }, '+ ' + p.label)),
          h('span', { style: 'flex:1' }),
          h('button', { style: btn('background:#4b6bff;color:#fff;border-color:#4b6bff;font-weight:600'), onClick: () => { showOut.value = !showOut.value } }, showOut.value ? 'Hide payload' : 'Export payload →')
        ]),
        // main row: stage + inspector
        h('div', { style: 'padding:0 22px 28px;max-width:1040px;margin:0 auto;display:flex;gap:18px;flex-wrap:wrap;align-items:flex-start' }, [
          // STAGE (the visual canvas of the app being built)
          h('div', { style: 'flex:1 1 420px;min-width:300px;background:#101017;border:1px solid #23232c;border-radius:12px;padding:22px' },
            items.length === 0
              ? [h('div', { style: 'opacity:.5;font-size:14px;text-align:center;padding:40px 0' }, 'Empty app — add a component above.')]
              : items.map((item) => h('div', {
                  key: item.id,
                  onClick: () => { sel.value = item.id },
                  style: 'position:relative;margin:0 0 12px;padding:12px 12px 12px 14px;border-radius:8px;cursor:pointer;border:1px solid ' + (sel.value === item.id ? '#4b6bff' : 'transparent') + ';background:' + (sel.value === item.id ? '#141a2e' : 'transparent')
                }, [
                  h('div', { style: 'display:flex;align-items:center;gap:6px;margin-bottom:6px' }, [
                    h('span', { style: 'font-size:10px;text-transform:uppercase;letter-spacing:.5px;opacity:.45' }, item.t),
                    h('span', { style: 'flex:1' }),
                    h('button', { style: btn('padding:2px 7px;font-size:12px'), onClick: (e) => { e.stopPropagation(); move(item.id, -1) } }, '↑'),
                    h('button', { style: btn('padding:2px 7px;font-size:12px'), onClick: (e) => { e.stopPropagation(); move(item.id, 1) } }, '↓'),
                    h('button', { style: btn('padding:2px 7px;font-size:12px;color:#ff8a8a'), onClick: (e) => { e.stopPropagation(); remove(item.id) } }, '✕')
                  ]),
                  previewOf(item)
                ]))
          ),
          // INSPECTOR
          h('div', { style: 'flex:0 0 300px;min-width:260px;background:#101017;border:1px solid #23232c;border-radius:12px;padding:18px' }, [
            h('div', { style: 'font-size:12px;opacity:.6;text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px' }, 'Inspector'),
            !s
              ? h('div', { style: 'opacity:.5;font-size:13px' }, 'Select a component to edit it.')
              : s.t === 'canvas'
                ? h('div', { style: 'font-size:13px;opacity:.75' }, 'Interactive canvas — draw on it in the stage. Exports as an xmbl general component with a pointer-draw handler.')
                : h('div', {}, [
                    h('div', { style: 'font-size:11px;opacity:.55;margin-bottom:4px' }, s.t === 'list' ? 'Items (one per line)' : s.t === 'image' ? 'Image URL' : s.t === 'text' ? 'Markdown' : 'Content'),
                    h(s.t === 'image' ? 'input' : 'textarea', {
                      rows: s.t === 'image' ? undefined : 5,
                      value: s.value,
                      onInput: (e) => { s.value = e.target.value },
                      style: 'width:100%;box-sizing:border-box;background:#15151c;color:#e8e8ea;border:1px solid #2a2a33;border-radius:8px;padding:9px 11px;font:inherit;font-size:13px'
                    })
                  ])
          ])
        ]),
        // EXPORT drawer
        showOut.value
          ? h('div', { style: 'padding:0 22px 32px;max-width:1040px;margin:0 auto' }, [
              h('div', { style: 'background:#101017;border:1px solid #23232c;border-radius:12px;padding:18px' }, [
                h('div', { style: 'font-size:13px;opacity:.8;margin-bottom:8px' }, ['Host this app with only its payload — compose against runtime dep ', h('code', {}, RUNTIME_HASH.slice(0, 12) + '…'), '. You pay only your payload’s net-new bytes; publishing uses ', h('b', {}, 'your own'), ' agent_key.']),
                h('div', { style: 'font-size:11px;opacity:.55;text-transform:uppercase;letter-spacing:.5px;margin:10px 0 4px' }, 'entry_html'),
                h('pre', { style: 'white-space:pre-wrap;word-break:break-word;background:#0c0c12;border:1px solid #23232c;border-radius:8px;padding:12px;font:12px/1.5 ui-monospace,Menlo,monospace;color:#c9d4ff;max-height:280px;overflow:auto;margin:0' }, entryHtml())
              ])
            ])
          : null
      ])
    }
  }
}

// =============================================================================
// Boot: payload app renders normally; no payload → the visual builder.
// =============================================================================
const payload = (typeof window !== 'undefined' && window.__XMBL__) || null
if (payload) {
  $state.app = payload
  createApp({ render: () => h(layout, { xid: 'scopes', xdisplay: payload }) })
    .component('content', content)
    .component('layout', layout)
    .provide('$state', $state)
    .provide('$api', $api)
    .mount('#app')
} else {
  createApp(Builder)
    .component('content', content)
    .provide('$state', $state)
    .provide('$api', $api)
    .mount('#app')
}
