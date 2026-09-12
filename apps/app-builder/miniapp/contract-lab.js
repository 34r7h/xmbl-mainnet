// XMBL Contract Lab — a handoff miniapp: author an LNG contract, run it in a test mode,
// and derive its deterministic on-chain identity for deployment to xmbl.
//
// It uses the REAL compiler: `compile`/`contractFields`/`lex`/`parse` from @xmbl/lng (a
// pure-JS toolchain with zero node: imports, so it bundles into the page verbatim). The
// three stages mirror the contract lifecycle proven headlessly by
// `reproductions/agentic-contract-e2e.mjs`:
//
//   CREATE  — author LNG source; the compiler derives the contract's public fields and its
//             entrypoints (the entrypoint list is read from the compiled WASM's own exports,
//             the same machine-derivation the reproduction machine-checks against).
//   TEST    — compile to WASM in-page and instantiate it via WebAssembly.instantiate with a
//             hand-written host ABI that is byte-for-byte the XCL byte-pointer state ABI
//             (packages/contracts/src/xcl/abi.js: HOST_ABI_SOURCE_BYTES) plus the LNG word
//             calling convention (XCL_WORD_MARSHAL_SOURCE). Committed state lives in an
//             in-page key→word map standing in for the Verkle tree; every entrypoint call
//             stages the whole read-set, runs the guest, and folds its write-set back — the
//             exact staging ContractHost._runFrame does, minus the parts that cannot exist in
//             a browser (see the honesty banner rendered in the Test stage).
//   DEPLOY  — compute the content-addressed contract id (`xc1_` + sha256(wasm), matching
//             placement.contractId) and its cubic coordinates (matching
//             placement.contractCoordinates), both with an in-page SHA-256 so the browser
//             derives the identical id a node derives, and emit the deploy descriptor an
//             operator applies with ContractHost.deploy on a node.
//
// HONEST BOUNDARY: in-page WebAssembly.instantiate runs the REAL compiled bytecode, but it is
// NOT the production execution path. The node runs the same bytes under storage-compute's
// worker-thread isolation with CPU metering, committed to the Verkle state machine, behind the
// delegation gate (ContractHost.call with an authorizer). None of that — isolation, metering,
// the Verkle commitment, the root→coordinator→agent gate — exists in this sandbox, and the
// Test stage says so on screen. This is the same Node-vs-browser split MODULE-STATUS.md flags.

import { compile, contractFields, lex, parse } from '@xmbl/lng'

// The LNG compiler emits a field/method name's bytes with `[...Buffer.from(name, 'utf8')]`
// (compile-wasm.js) — a node global absent in the browser. It only needs the UTF-8 bytes as an
// iterable, so a TextEncoder-backed shim is exact and sufficient (no other node global is
// reached on the compile/contractFields/lex/parse paths). Installed before any compile runs.
if (typeof globalThis.Buffer === 'undefined') {
  globalThis.Buffer = {
    from(input, enc) {
      if (typeof input === 'string') {
        if (enc === 'hex') {
          const out = new Uint8Array(input.length / 2)
          for (let i = 0; i < out.length; i++) out[i] = parseInt(input.slice(i * 2, i * 2 + 2), 16)
          return out
        }
        return new TextEncoder().encode(input)
      }
      return Uint8Array.from(input)
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// SHA-256 (pure JS, no crypto.subtle) — so the browser-derived contract id equals
// placement.contractId's node-derived id in EVERY context (the feed surface runs on an
// origin where crypto.subtle may be unavailable). Verified byte-identical to node's
// createHash('sha256') by verify-contract-lab.mjs before the panel is trusted.
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
])

function sha256Bytes(msg) {
  const rotr = (x, n) => (x >>> n) | (x << (32 - n))
  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ])
  const l = msg.length
  const bitLen = l * 8
  // padded length: multiple of 64, room for the 1-bit and the 64-bit length
  const withPad = (((l + 8) >> 6) + 1) << 6
  const buf = new Uint8Array(withPad)
  buf.set(msg)
  buf[l] = 0x80
  // 64-bit big-endian length (high 32 bits are 0 for our sizes)
  const dv = new DataView(buf.buffer)
  dv.setUint32(withPad - 4, bitLen >>> 0, false)
  dv.setUint32(withPad - 8, Math.floor(bitLen / 0x100000000) >>> 0, false)

  const w = new Uint32Array(64)
  for (let off = 0; off < withPad; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false)
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0
    }
    let [a, b, c, d, e, f, g, h] = H
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (h + S1 + ch + K[i] + w[i]) | 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) | 0
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0
  }
  const out = new Uint8Array(32)
  const odv = new DataView(out.buffer)
  for (let i = 0; i < 8; i++) odv.setUint32(i * 4, H[i], false)
  return out
}

const hex = (u8) => { let s = ''; for (let i = 0; i < u8.length; i++) s += u8[i].toString(16).padStart(2, '0'); return s }
export const sha256Hex = (u8) => hex(sha256Bytes(u8))
const utf8 = (s) => new TextEncoder().encode(s)

// ────────────────────────────────────────────────────────────────────────────
// PLACEMENT — replicates packages/contracts/src/xcl/placement.js in-browser so the id and
// coordinates the Deploy stage shows are the SAME a node derives (content-addressed identity).
export function contractIdOf(wasmBytes) {
  return 'xc1_' + sha256Hex(wasmBytes instanceof Uint8Array ? wasmBytes : Uint8Array.from(wasmBytes))
}
const coord = (h, i) => ((parseInt(h.slice(i * 2, i * 2 + 2), 16) % 3) - 1)
export function contractCoordinatesOf(id) {
  let h = sha256Hex(utf8(id))
  for (let attempt = 0; attempt < 8; attempt++) {
    const p = [0, 1, 2].map((k) => ({
      x: coord(h, k * 3 + 0), y: coord(h, k * 3 + 1), z: coord(h, k * 3 + 2)
    }))
    const u = { x: p[1].x - p[0].x, y: p[1].y - p[0].y, z: p[1].z - p[0].z }
    const v = { x: p[2].x - p[0].x, y: p[2].y - p[0].y, z: p[2].z - p[0].z }
    const n = { x: u.y * v.z - u.z * v.y, y: u.z * v.x - u.x * v.z, z: u.x * v.y - u.y * v.x }
    if (n.x !== 0 || n.y !== 0 || n.z !== 0) {
      return { cubeAddress: 'cube-' + parseInt(h.slice(0, 8), 16).toString(16), coordinates: p }
    }
    h = sha256Hex(utf8(h))
  }
  throw new Error('contractCoordinates: could not derive a non-collinear plane')
}

// ────────────────────────────────────────────────────────────────────────────
// IN-PAGE EXECUTOR — the XCL byte-pointer state ABI (abi.js HOST_ABI_SOURCE_BYTES) + the LNG
// word calling convention (abi.js XCL_WORD_MARSHAL_SOURCE), replicated for the main thread.
// State persists ONLY through the store (the browser stand-in for committed Verkle state):
// each call instantiates a fresh module (like a worker execute()), the guest's prologue loads
// every field from the store via xmbl_verkle_get, and its writes flush back via xmbl_verkle_set.
const WORD = 32
const fieldHexKey = (name) => hex(utf8(name))

export function makeStore() { return new Map() } // hexKey(field-name bytes) -> hexValue(64 chars, LE)

export function readField(store, name) {
  const hv = store.get(fieldHexKey(name))
  if (!hv) return 0n
  let v = 0n
  for (let i = 0; i < WORD; i++) v |= BigInt(parseInt(hv.slice(i * 2, i * 2 + 2), 16)) << BigInt(i * 8)
  return v
}

// Instantiate the compiled module and invoke one entrypoint with word-marshalled args.
// Returns the (decoded) return value; mutates `store` with the frame's writes.
// `touched`, if given, is a Set that collects the hex key of every field the frame WRITES
// (via xmbl_verkle_set) — even a write to the same value or to zero, which a before/after
// value diff would miss but a real Verkle commitment would still record as a root-moving write.
export async function callEntry(wasm, store, fn, argVals, touched) {
  let inst = null
  const mem = () => inst.exports.memory
  const imports = {
    env: {
      // xmbl_verkle_get(key_ptr, key_len, val_out_ptr) -> 0 ok / 1 key OOB / 2 val OOB
      xmbl_verkle_get(keyPtr, keyLen, valOutPtr) {
        const v = new Uint8Array(mem().buffer)
        if (keyPtr < 0 || keyLen < 0 || keyPtr + keyLen > v.length) return 1
        if (valOutPtr < 0 || valOutPtr + WORD > v.length) return 2
        const k = hex(v.subarray(keyPtr, keyPtr + keyLen))
        const stored = store.get(k)
        for (let i = 0; i < WORD; i++) v[valOutPtr + i] = stored ? parseInt(stored.slice(i * 2, i * 2 + 2), 16) : 0
        return 0
      },
      // xmbl_verkle_set(key_ptr, key_len, val_ptr, val_len) -> 0 ok / 1 key OOB / 2 val OOB / 3 len>32
      xmbl_verkle_set(keyPtr, keyLen, valPtr, valLen) {
        const v = new Uint8Array(mem().buffer)
        if (keyPtr < 0 || keyLen < 0 || keyPtr + keyLen > v.length) return 1
        if (valLen > WORD) return 3
        if (valPtr < 0 || valLen < 0 || valPtr + valLen > v.length) return 2
        const k = hex(v.subarray(keyPtr, keyPtr + keyLen))
        let val = ''
        for (let i = 0; i < WORD; i++) { const b = i < valLen ? v[valPtr + i] : 0; val += b.toString(16).padStart(2, '0') }
        store.set(k, val)
        if (touched) touched.add(k)
        return 0
      }
    }
  }
  // Async instantiate (the sync WebAssembly.Module/Instance constructors throw for buffers
  // >4KB on the main thread; a compiled contract is typically larger).
  const { instance } = await WebAssembly.instantiate(wasm, imports)
  inst = instance
  const ex = inst.exports
  if (typeof ex.__alloc !== 'function') throw new Error('contract is missing __alloc (was it compiled by @xmbl/lng with hostState?)')
  if (typeof ex.__reset === 'function') ex.__reset()
  const MASK64 = (1n << 64n) - 1n, FULL = (1n << BigInt(WORD * 8)) - 1n, LIMBS = WORD / 8
  const ptrs = (argVals || []).map((a) => {
    const p = ex.__alloc()
    let val = BigInt(a) & FULL
    const d = new DataView(mem().buffer)
    for (let i = 0; i < LIMBS; i++) { d.setBigUint64(p + i * 8, val & MASK64, true); val >>= 64n }
    return p
  })
  const ret = ex[fn](...ptrs)
  // Decode a returned 32-byte word pointer to a BigInt; pass a void/non-pointer return through.
  if (typeof ret !== 'number') return ret
  const d = new DataView(mem().buffer)
  let v = 0n
  for (let i = LIMBS - 1; i >= 0; i--) v = (v << 64n) | d.getBigUint64(ret + i * 8, true)
  return v
}

// ────────────────────────────────────────────────────────────────────────────
// COMPILE + INTROSPECT — one call that compiles the source and returns everything the three
// stages render: the WASM bytes, the compiler-derived public fields, the entrypoints read
// from the WASM's OWN exports (machine-derived), and each entrypoint's params from the AST.
export async function buildContract(src) {
  const wasm = compile(src, { hostState: true })
  const fields = contractFields(src) // ordered public field names, from the compiler
  // Entrypoints = the WASM's own function exports, minus housekeeping (__alloc/__reset/…).
  const mod = await WebAssembly.compile(wasm)
  const entrypoints = WebAssembly.Module.exports(mod)
    .filter((e) => e.kind === 'function' && !e.name.startsWith('__'))
    .map((e) => e.name)
  // Params per entrypoint, from the AST (names + types), matched by handler name.
  const contract = parse(lex(src)).body.find((n) => n.kind === 'contract')
  const methodParams = {}
  if (contract) for (const m of contract.methods) methodParams[m.name] = m.params.map((p) => ({ name: p.name, type: p.type || '~u256' }))
  const params = entrypoints.map((name) => ({ name, params: methodParams[name] || [] }))
  return { wasm, fields, entrypoints, params }
}

// ────────────────────────────────────────────────────────────────────────────
// SAMPLE CONTRACTS — real LNG, the Vault used by the headless reproduction plus a Counter.
export const SAMPLES = {
  Vault:
    '~contract `Vault {\n' +
    '  ~state { ~public { `bal ~u256 0\n `owner ~u256 0 } }\n' +
    '  ~on `deposit(`v ~u256) { `bal = `v }\n' +
    '  ~on `accrue(`v ~u256) { `bal = `bal + `v }\n' +
    '  ~on `setOwner(`o ~u256) { `owner = `o }\n' +
    '  ~on `withdraw(`amt ~u256) { `bal = 0 }\n' +
    '}\n',
  Counter:
    '~contract `Counter {\n' +
    '  ~state { ~public { `count ~u256 0 } }\n' +
    '  ~on `incBy(`n ~u256) { `count = `count + `n }\n' +
    '  ~on `reset(`z ~u256) { `count = 0 }\n' +
    '}\n'
}

// ────────────────────────────────────────────────────────────────────────────
// UI — plain DOM (no framework): builds into #app with createElement + addEventListener,
// the only DOM surface the handoff feed's restricted document proxy provides. No eval, no
// innerHTML for anything untrusted, no top-level import beyond @xmbl/lng (bundled inline).
function boot() {
  const root = document.getElementById('app')
  if (!root) return
  const el = (tag, attrs = {}, kids = []) => {
    const n = document.createElement(tag)
    for (const k in attrs) {
      if (k === 'class') n.className = attrs[k]
      else if (k === 'text') n.textContent = attrs[k]
      else if (k === 'html') n.textContent = attrs[k] // deliberately textContent; never inject markup
      else n.setAttribute(k, attrs[k])
    }
    for (const c of [].concat(kids)) if (c != null) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c)
    return n
  }
  const clear = (n) => { while (n.firstChild) n.removeChild(n.firstChild) }
  const chip = (t, cls) => el('span', { class: 'chip ' + (cls || ''), text: t })

  // Session state.
  const S = { built: null, store: makeStore(), src: SAMPLES.Vault }

  // ── shell ──────────────────────────────────────────────────────────────────
  const header = el('header', { class: 'lab-head' }, [
    el('div', { class: 'brand' }, [
      el('span', { class: 'logo', text: '◧' }),
      el('div', {}, [
        el('h1', { text: 'XMBL Contract Lab' }),
        el('p', { class: 'sub', text: 'Author an LNG contract · run it in a test mode · derive its on-chain identity for xmbl' })
      ])
    ])
  ])

  // Stage 1: CREATE
  const editor = el('textarea', { class: 'code', spellcheck: 'false', rows: '15' })
  editor.value = S.src
  const sampleSel = el('select', { class: 'select' }, Object.keys(SAMPLES).map((k) => el('option', { value: k, text: k })))
  const compileBtn = el('button', { class: 'btn primary', text: 'Compile ▶' })
  const createOut = el('div', { class: 'out' })
  const stage1 = el('section', { class: 'stage' }, [
    el('div', { class: 'stage-head' }, [chip('1', 'num'), el('h2', { text: 'Create' }), el('span', { class: 'stage-note', text: 'the compiler derives fields + entrypoints from your source' })]),
    el('div', { class: 'row wrap' }, [el('label', { class: 'lbl', text: 'Sample' }), sampleSel]),
    editor,
    el('div', { class: 'row' }, [compileBtn]),
    createOut
  ])

  // Stage 2: TEST
  const testBody = el('div', { class: 'test-body', text: 'Compile a contract to enable the test mode.' })
  const stage2 = el('section', { class: 'stage disabled', id: 'stage2' }, [
    el('div', { class: 'stage-head' }, [chip('2', 'num'), el('h2', { text: 'Test' }), el('span', { class: 'stage-note', text: 'runs the REAL compiled WASM in-page over an in-memory state map' })]),
    el('div', { class: 'banner warn' }, [
      el('strong', { text: 'Test mode ≠ production execution. ' }),
      document.createTextNode('This page instantiates the compiled bytecode directly in your browser. A node runs the same bytes under worker-thread isolation with CPU metering, commits state to the Verkle state machine, and gates every call through the root→coordinator→agent delegation chain — none of which exists in this sandbox.')
    ]),
    testBody
  ])

  // Stage 3: DEPLOY
  const deployBody = el('div', { class: 'test-body', text: 'Compile a contract to derive its deployment identity.' })
  const stage3 = el('section', { class: 'stage disabled', id: 'stage3' }, [
    el('div', { class: 'stage-head' }, [chip('3', 'num'), el('h2', { text: 'Deploy to xmbl' }), el('span', { class: 'stage-note', text: 'content-addressed id + cubic coordinates (identical on every node)' })]),
    deployBody
  ])

  root.appendChild(el('div', { class: 'lab' }, [header, stage1, stage2, stage3]))

  // ── behavior ────────────────────────────────────────────────────────────────
  sampleSel.addEventListener('change', () => { editor.value = SAMPLES[sampleSel.value] || editor.value })

  const enable = (sec) => sec.classList.remove('disabled')

  async function doCompile() {
    clear(createOut)
    S.built = null
    S.store = makeStore()
    let built
    try {
      built = await buildContract(editor.value)
    } catch (e) {
      createOut.appendChild(el('div', { class: 'banner err', text: 'Compile error: ' + (e && e.message ? e.message : String(e)) }))
      return
    }
    S.built = built
    createOut.appendChild(el('div', { class: 'kv' }, [
      el('div', { class: 'k', text: 'WASM size' }), el('div', { class: 'v mono', text: built.wasm.length + ' bytes' })
    ]))
    createOut.appendChild(el('div', { class: 'field-block' }, [
      el('div', { class: 'blk-lbl', text: 'Public fields (compiler-derived)' }),
      el('div', { class: 'chips' }, built.fields.length ? built.fields.map((f) => chip(f, 'field')) : [chip('none', 'muted')])
    ]))
    createOut.appendChild(el('div', { class: 'field-block' }, [
      el('div', { class: 'blk-lbl', text: 'Entrypoints (read from WASM exports)' }),
      el('div', { class: 'chips' }, built.entrypoints.map((f) => chip(f + '()', 'entry')))
    ]))
    renderTest()
    await renderDeploy()
    enable(stage2)
    enable(stage3)
  }

  function renderTest() {
    clear(testBody)
    const b = S.built
    // live state readout
    const stateRow = el('div', { class: 'state-grid' })
    const refreshState = () => {
      clear(stateRow)
      for (const f of b.fields) {
        stateRow.appendChild(el('div', { class: 'state-cell' }, [
          el('div', { class: 'sc-name', text: f }),
          el('div', { class: 'sc-val mono', text: readField(S.store, f).toString() })
        ]))
      }
    }
    // entrypoint caller rows
    const callArea = el('div', { class: 'calls' })
    const log = el('div', { class: 'log' })
    const logLine = (t, cls) => { const line = el('div', { class: 'log-line ' + (cls || ''), text: t }); log.insertBefore(line, log.firstChild) }
    for (const ep of b.params) {
      const inputs = ep.params.map((p) => {
        const inp = el('input', { class: 'arg mono', type: 'text', value: '0', placeholder: p.name + ' ' + p.type })
        inp._param = p
        return inp
      })
      const callBtn = el('button', { class: 'btn', text: 'call' })
      const row = el('div', { class: 'call-row' }, [
        el('code', { class: 'ep', text: ep.name }),
        el('div', { class: 'args' }, inputs.length ? inputs : [el('span', { class: 'muted', text: '(no args)' })]),
        callBtn
      ])
      callBtn.addEventListener('click', async () => {
        let argVals
        try {
          argVals = inputs.map((i) => { const t = (i.value || '').trim(); if (!/^\d+$/.test(t)) throw new Error('arg "' + i._param.name + '" must be a non-negative integer'); return BigInt(t) })
        } catch (e) { logLine('✗ ' + e.message, 'bad'); return }
        try {
          const touched = new Set()
          const ret = await callEntry(b.wasm, S.store, ep.name, argVals, touched)
          const changed = b.fields.filter((f) => touched.has(fieldHexKey(f)))
          refreshState()
          logLine('✓ ' + ep.name + '(' + argVals.join(', ') + ')' + (ret !== undefined ? ' → ' + ret.toString() : '') + (changed.length ? '  ·  wrote: ' + changed.join(', ') : '  ·  no state change'), 'ok')
        } catch (e) { logLine('✗ ' + ep.name + ': ' + (e && e.message ? e.message : String(e)), 'bad') }
      })
      callArea.appendChild(row)
    }
    const resetBtn = el('button', { class: 'btn ghost', text: 'reset state' })
    resetBtn.addEventListener('click', () => { S.store = makeStore(); refreshState(); logLine('— state reset —', 'muted') })
    testBody.appendChild(el('div', { class: 'blk-lbl', text: 'Committed state (in-page stand-in for Verkle)' }))
    testBody.appendChild(stateRow)
    testBody.appendChild(el('div', { class: 'row between' }, [el('div', { class: 'blk-lbl', text: 'Call an entrypoint' }), resetBtn]))
    testBody.appendChild(callArea)
    testBody.appendChild(el('div', { class: 'blk-lbl', text: 'Trace' }))
    testBody.appendChild(log)
    refreshState()
  }

  async function renderDeploy() {
    clear(deployBody)
    const b = S.built
    const id = contractIdOf(b.wasm)
    const place = contractCoordinatesOf(id)
    const descriptor = {
      contractId: id,
      cubeAddress: place.cubeAddress,
      coordinates: place.coordinates,
      wasmBytes: b.wasm.length,
      deployFlags: { byteState: true, wordAbi: true, fields: b.fields },
      entrypoints: b.entrypoints
    }
    deployBody.appendChild(el('div', { class: 'kv' }, [
      el('div', { class: 'k', text: 'Contract id' }), el('div', { class: 'v mono break', text: id })
    ]))
    deployBody.appendChild(el('div', { class: 'kv' }, [
      el('div', { class: 'k', text: 'Cube address' }), el('div', { class: 'v mono', text: place.cubeAddress })
    ]))
    deployBody.appendChild(el('div', { class: 'kv' }, [
      el('div', { class: 'k', text: 'Coordinates' }), el('div', { class: 'v mono', text: place.coordinates.map((p) => '(' + p.x + ',' + p.y + ',' + p.z + ')').join('  ') })
    ]))
    deployBody.appendChild(el('div', { class: 'blk-lbl', text: 'Deploy descriptor (apply on a node with ContractHost.deploy)' }))
    deployBody.appendChild(el('pre', { class: 'descriptor mono', text: JSON.stringify(descriptor, null, 2) }))
    deployBody.appendChild(el('div', { class: 'banner info' }, [
      el('strong', { text: 'No live node endpoint is wired into this sandbox. ' }),
      document.createTextNode('Deployment executes on a node — where worker isolation and the Verkle commitment live. Apply the descriptor with '),
      el('code', { text: "host.deploy(wasm, [], { byteState:true, wordAbi:true, fields })" }),
      document.createTextNode(' then drive it with '),
      el('code', { text: 'host.call(id, fn, args, { auth })' }),
      document.createTextNode('; the end-to-end proof is reproductions/agentic-contract-e2e.mjs (run: node reproductions/agentic-contract-e2e.mjs).')
    ]))
  }

  compileBtn.addEventListener('click', () => { doCompile() })
  // Compile the default sample on load so the page opens in a working state.
  doCompile()
}

if (typeof document !== 'undefined') boot()
