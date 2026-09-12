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
// `out`, if given, is an object the call fills with observability for the UI:
//   out.touched — a Set of the hex key of every field the frame WROTE (via xmbl_verkle_set),
//     even a write to the same value or to zero, which a before/after value diff would miss
//     but a real Verkle commitment would still record as a root-moving write;
//   out.events  — the contract's event counter AFTER the call (what ~emit bumped this frame,
//     read from the module's own __events() export).
export async function callEntry(wasm, store, fn, argVals, out) {
  const touched = out ? (out.touched || (out.touched = new Set())) : null
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
  if (out && typeof ex.__events === 'function') { const e = ex.__events(); out.events = typeof e === 'bigint' ? Number(e) : (e | 0) }
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
  if (contract) for (const m of contract.methods) methodParams[m.name] = m.params.map((p) => ({ name: p.name, type: p.type || 'u256' }))
  const params = entrypoints.map((name) => ({ name, params: methodParams[name] || [] }))
  // Full field info (name/type/vis/init) from the AST — the state grid shows every field and
  // marks private ones; `fields` stays the ordered PUBLIC names the compiler reports.
  const fieldInfo = contract ? contract.fields.map((f) => ({ name: f.name, type: f.type || 'u256', vis: f.vis || 'public' })) : []
  const events = contract ? contract.events.map((e) => ({ name: e.name, params: e.params.map((p) => ({ name: p.name, type: p.type || 'u256' })) })) : []
  return { wasm, fields, fieldInfo, events, entrypoints, params }
}

// ────────────────────────────────────────────────────────────────────────────
// SAMPLE CONTRACTS — one per theme; together they exercise every call/statement/operator the
// host-state backend compiles and runs. Defined in samples.js (shared with verify-contract-lab).
// Imported into local scope (so boot() can read it) AND re-exported for consumers.
import { SAMPLES } from './samples.js'
export { SAMPLES }

// ────────────────────────────────────────────────────────────────────────────
// MODEL ⇄ SOURCE — the visual builder and the code editor are two editors over ONE thing: the
// LNG source. `parseToModel` derives an editable structural model from the compiler's own AST;
// `modelToSource` regenerates source from the model. verify-contract-lab.mjs round-trips every
// sample (source → model → source → compile → identical behavior), so the two never drift.
const isNum = (s) => /^\d+$/.test(String(s).trim())
const operandSrc = (s) => { s = String(s == null ? '' : s).trim(); return isNum(s) ? s : '`' + s }
const exprSrc = (e) => (!e || !e.op) ? operandSrc(e ? e.a : '0') : operandSrc(e.a) + ' ' + e.op + ' ' + operandSrc(e.b)
function stmtSrc (s) {
  if (s.t === 'set') return '`' + s.field + ' = ' + exprSrc(s.expr)
  if (s.t === 'local') return '`' + s.name + ' ~' + (s.type || 'u256') + ' ' + exprSrc(s.expr)
  if (s.t === 'return') return 'return ' + exprSrc(s.expr)
  if (s.t === 'emit') return '~emit `' + s.event + '(' + (s.args || []).map(operandSrc).join(', ') + ')'
  if (s.t === 'branch') return exprSrc(s.cond) + ' ? { ' + (s.then || []).map(stmtSrc).join('; ') + ' } | { ' + (s.els || []).map(stmtSrc).join('; ') + ' }'
  if (s.t === 'loop') return '~for `' + s.varName + ' ' + operandSrc(s.start) + ' ' + operandSrc(s.end) + ' { ' + (s.body || []).map(stmtSrc).join('; ') + ' }'
  return ''
}
export function modelToSource (m) {
  const pad = '  '
  const fsrc = (f) => '`' + f.name + ' ~' + (f.type || 'u256') + ' ' + (f.init === '' || f.init == null ? '0' : f.init)
  const out = ['~contract `' + (m.name || 'Contract') + ' {']
  if (m.fields && m.fields.length) {
    out.push(pad + '~state {')
    const pub = m.fields.filter((f) => f.vis !== 'private'), pri = m.fields.filter((f) => f.vis === 'private')
    if (pub.length) out.push(pad + pad + '~public { ' + pub.map(fsrc).join('\n' + pad + pad + '           ') + ' }')
    if (pri.length) out.push(pad + pad + '~private { ' + pri.map(fsrc).join('\n' + pad + pad + '            ') + ' }')
    out.push(pad + '}')
  }
  for (const e of (m.events || [])) out.push(pad + '~event `' + e.name + '(' + (e.params || []).map((p) => '`' + p.name + ' ~' + (p.type || 'u256')).join(', ') + ')')
  for (const mth of (m.methods || [])) {
    const ps = (mth.params || []).map((p) => '`' + p.name + ' ~' + (p.type || 'u256')).join(', ')
    if (mth.advanced && mth.raw != null) { out.push(pad + '~on `' + mth.name + '(' + ps + ') { ' + mth.raw + ' }'); continue }
    out.push(pad + '~on `' + mth.name + '(' + ps + ') {')
    for (const s of (mth.stmts || [])) out.push(pad + pad + stmtSrc(s))
    out.push(pad + '}')
  }
  out.push('}')
  return out.join('\n')
}

// AST → model (best-effort; a method body the structural editor can't represent is kept whole as
// `advanced` with regenerated `raw`, and the visual editor shows it read-only with a code-mode hint).
const astToOperand = (n) => {
  if (!n) return '0'
  if (n.kind === 'group') return astToOperand(n.expr)
  if (n.kind === 'num') return String(n.value)
  if (n.kind === 'ref') return n.name
  throw new Error('non-simple operand')
}
const astToExpr = (n) => {
  if (!n) return { a: '0', op: '', b: '' }
  if (n.kind === 'group') return astToExpr(n.expr)
  if (n.kind === 'binary') return { a: astToOperand(n.left), op: n.op, b: astToOperand(n.right) }
  return { a: astToOperand(n), op: '', b: '' }
}
const asBlockBody = (b) => {
  if (!b) return []
  if (b.kind === 'anonfn') return asBlockBody(b.body)
  if (b.kind === 'block') return b.body
  return [{ kind: 'exprstmt', expr: b }]
}
function nodesToStmts (nodes) {
  return nodes.map((n) => {
    if (n.kind === 'assign' && n.declType) return { t: 'local', name: n.name, type: n.declType, expr: astToExpr(n.value) }
    if (n.kind === 'assign') return { t: 'set', field: n.name, expr: astToExpr(n.value) }
    if (n.kind === 'return') return { t: 'return', expr: astToExpr(n.value) }
    if (n.kind === 'countedfor') return { t: 'loop', varName: n.varName, start: astToOperand(n.start), end: astToOperand(n.end), body: nodesToStmts(n.body.body) }
    if (n.kind === 'exprstmt') {
      const e = n.expr
      if (e.kind === 'emit') return { t: 'emit', event: e.name, args: e.args.map(astToOperand) }
      if (e.kind === 'return') return { t: 'return', expr: astToExpr(e.value) }
      if (e.kind === 'ternary') return { t: 'branch', cond: astToExpr(e.cond), then: nodesToStmts(asBlockBody(e.thenB)), els: nodesToStmts(asBlockBody(e.elseB)) }
    }
    throw new Error('unrepresentable statement: ' + n.kind)
  })
}
// A generic AST→source printer, used only to preserve `advanced` method bodies verbatim.
function astExprSrc (n) {
  if (!n) return ''
  switch (n.kind) {
    case 'num': return String(n.value)
    case 'ref': return '`' + n.name
    case 'group': return '(' + astExprSrc(n.expr) + ')'
    case 'unary': return (n.op || '') + astExprSrc(n.operand)
    case 'binary': return astExprSrc(n.left) + ' ' + n.op + ' ' + astExprSrc(n.right)
    case 'emit': return '~emit `' + n.name + '(' + (n.args || []).map(astExprSrc).join(', ') + ')'
    case 'return': return 'return ' + astExprSrc(n.value)
    case 'ternary': return astExprSrc(n.cond) + ' ? { ' + astStmtSrc(asBlockBody(n.thenB)) + ' } | { ' + astStmtSrc(asBlockBody(n.elseB)) + ' }'
    case 'call': return astExprSrc(n.callee) + '(' + (n.args || []).map(astExprSrc).join(', ') + ')'
    default: return ''
  }
}
function astStmtSrc (nodes) {
  return nodes.map((n) => {
    if (n.kind === 'assign' && n.declType) return '`' + n.name + ' ~' + n.declType + ' ' + astExprSrc(n.value)
    if (n.kind === 'assign') return '`' + n.name + ' = ' + astExprSrc(n.value)
    if (n.kind === 'return') return 'return ' + astExprSrc(n.value)
    if (n.kind === 'countedfor') return '~for `' + n.varName + ' ' + astExprSrc(n.start) + ' ' + astExprSrc(n.end) + ' { ' + astStmtSrc(n.body.body) + ' }'
    if (n.kind === 'exprstmt') return astExprSrc(n.expr)
    return ''
  }).join('; ')
}
export function parseToModel (src) {
  const c = parse(lex(src)).body.find((n) => n.kind === 'contract')
  if (!c) throw new Error('no ~contract found')
  const fields = c.fields.map((f) => ({ name: f.name, type: f.type || 'u256', init: f.init ? astExprSrc(f.init).replace(/^`/, '') : '0', vis: f.vis || 'public' }))
  const events = c.events.map((e) => ({ name: e.name, params: e.params.map((p) => ({ name: p.name, type: p.type || 'u256' })) }))
  const methods = c.methods.map((m) => {
    const params = m.params.map((p) => ({ name: p.name, type: p.type || 'u256' }))
    try { return { name: m.name, params, stmts: nodesToStmts(m.body.body) } }
    catch { return { name: m.name, params, advanced: true, raw: astStmtSrc(m.body.body), stmts: [] } }
  })
  return { name: c.name, fields, events, methods }
}

// ────────────────────────────────────────────────────────────────────────────
// UI — plain DOM (createElement/createTextNode/addEventListener only: the surface the handoff
// feed's restricted document proxy provides). No innerHTML, no eval, no top-level import beyond
// @xmbl/lng (bundled inline). Two modes (Visual builder / Code) over one source; a Test panel
// whose state tiles flash as each call writes them; a Deploy button that commits a persistent,
// content-addressed instance and switches Test onto it.
const DTYPE_NOTE = 'Fields and parameters are ~u256 here (what test mode executes). The language also has ~boolean, ~address, ~bytes, ~decimal, ~string — use Code mode for those.'
const OPS = ['', '+', '-', '*', '/', '%', 'b&', 'b|', 'b^', 'b<', 'b>', '==', '!==', '!<', '!>']
const OP_LABEL = { '': '(none)', '+': '+ add', '-': '− sub', '*': '× mul', '/': '÷ div', '%': '% mod', 'b&': '& and', 'b|': '| or', 'b^': '^ xor', 'b<': '« shl', 'b>': '» shr', '==': '= eq', '!==': '≠ ne', '!<': '≥ gte', '!>': '≤ lte' }

function boot () {
  const root = document.getElementById('app')
  if (!root) return
  const el = (tag, attrs = {}, kids = []) => {
    const n = document.createElement(tag)
    for (const k in attrs) {
      if (k === 'class') n.className = attrs[k]
      else if (k === 'text') n.textContent = attrs[k]
      else if (k === 'value') n.value = attrs[k]
      else if (k === 'type') n.type = attrs[k]
      else n.setAttribute(k, attrs[k])
    }
    for (const c of [].concat(kids)) if (c != null) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c)
    return n
  }
  const clear = (n) => { while (n.firstChild) n.removeChild(n.firstChild) }

  // Session state. `src` is canonical; `model` is the structural view of it.
  const S = { mode: 'visual', src: SAMPLES.Counter.src, model: null, built: null, store: makeStore(), deployed: null }
  try { S.model = parseToModel(S.src) } catch { S.model = { name: 'Counter', fields: [], events: [], methods: [] } }

  // ── shell ────────────────────────────────────────────────────────────────
  clear(root)
  const head = el('header', { class: 'head' }, [
    el('div', { class: 'brand' }, [
      el('span', { class: 'logo', text: '◧' }),
      el('div', {}, [
        el('h1', { class: 'title', text: 'XMBL Contract Lab' }),
        el('p', { class: 'sub', text: 'Build a contract visually or in code · run every call in test mode · deploy a live instance to xmbl' })
      ])
    ])
  ])
  root.appendChild(head)

  // ── sample picker + mode tabs ──────────────────────────────────────────────
  const sampleSel = el('select', { class: 'sel sample' })
  for (const key of Object.keys(SAMPLES)) sampleSel.appendChild(el('option', { value: key, text: SAMPLES[key].title + ' — ' + SAMPLES[key].blurb }))
  sampleSel.value = 'Counter'
  sampleSel.addEventListener('change', () => { loadSource(SAMPLES[sampleSel.value].src) })

  const tabVisual = el('button', { class: 'tab active', text: 'Visual builder' })
  const tabCode = el('button', { class: 'tab', text: 'Code' })
  tabVisual.addEventListener('click', () => setMode('visual'))
  tabCode.addEventListener('click', () => setMode('code'))
  const bar = el('div', { class: 'bar' }, [
    el('div', { class: 'tabs' }, [tabVisual, tabCode]),
    el('label', { class: 'pick' }, [el('span', { text: 'Start from' }), sampleSel])
  ])
  root.appendChild(bar)

  // ── editor column (visual + code) ───────────────────────────────────────────
  const visualPanel = el('div', { class: 'vb' })
  const codeArea = el('textarea', { class: 'code', spellcheck: 'false', rows: '18' })
  const parseMsg = el('div', { class: 'parse-msg' })
  const codeSync = el('button', { class: 'btn', text: 'Sync to builder ↑' })
  const codePanel = el('div', { class: 'panel', hidden: 'true' }, [
    el('div', { class: 'panel-h' }, [el('span', { text: 'LNG source' }), codeSync]),
    codeArea, parseMsg
  ])
  const editorPanel = el('section', { class: 'panel editor' }, [
    el('div', { class: 'panel-h' }, [el('span', { class: 'ph-title', text: 'Create' }), el('span', { class: 'ph-note', text: 'one contract, edited two ways' })]),
    visualPanel, codePanel
  ])

  // ── compile / test / deploy column ──────────────────────────────────────────
  const compileBtn = el('button', { class: 'btn primary', text: 'Compile →' })
  const buildMsg = el('div', { class: 'parse-msg' })
  const stateGrid = el('div', { class: 'state-grid' })
  const callsBox = el('div', { class: 'calls' })
  const trace = el('div', { class: 'trace' })
  const resetBtn = el('button', { class: 'btn ghost sm', text: 'Reset state' })
  const testNote = el('p', { class: 'note', text: 'Test mode runs the REAL compiled WASM in-page over a faithful copy of the XCL byte-pointer state ABI. It is NOT the production path — no worker isolation, metering, Verkle commitment, or delegation gate (those are the headless reproductions/agentic-contract-e2e.mjs).' })
  const testPanel = el('section', { class: 'panel test' }, [
    el('div', { class: 'panel-h' }, [el('span', { class: 'ph-title', text: 'Test' }), resetBtn]),
    el('div', { class: 'sub-h', text: 'Committed state (in-page stand-in for the Verkle tree)' }),
    stateGrid,
    el('div', { class: 'sub-h', text: 'Entrypoints — run any call; written fields flash' }),
    callsBox,
    el('div', { class: 'sub-h', text: 'Trace' }),
    trace, testNote
  ])

  const deployBtn = el('button', { class: 'btn primary', text: '⬢ Deploy to xmbl' })
  const deployBody = el('div', { class: 'deploy-body' })
  const deployPanel = el('section', { class: 'panel deploy' }, [
    el('div', { class: 'panel-h' }, [el('span', { class: 'ph-title', text: 'Deploy' }), deployBtn]),
    deployBody
  ])

  const cols = el('div', { class: 'cols' }, [
    editorPanel,
    el('div', { class: 'right' }, [el('div', { class: 'compile-row' }, [compileBtn, buildMsg]), testPanel, deployPanel])
  ])
  root.appendChild(cols)

  // ── source ⇄ model plumbing ────────────────────────────────────────────────
  function syncSourceFromModel () { S.src = modelToSource(S.model); codeArea.value = S.src }
  function loadSource (src) {
    S.src = src; codeArea.value = src
    try { S.model = parseToModel(src); parseMsg.className = 'parse-msg'; parseMsg.textContent = '' }
    catch (e) { parseMsg.className = 'parse-msg bad'; parseMsg.textContent = String(e.message || e) }
    renderVisual()
  }
  function setMode (m) {
    S.mode = m
    tabVisual.className = 'tab' + (m === 'visual' ? ' active' : '')
    tabCode.className = 'tab' + (m === 'code' ? ' active' : '')
    visualPanel.hidden = m !== 'visual'
    codePanel.hidden = m !== 'code'
    if (m === 'code') codeArea.value = S.src
  }
  codeSync.addEventListener('click', () => {
    try { S.model = parseToModel(codeArea.value); S.src = codeArea.value; parseMsg.className = 'parse-msg ok'; parseMsg.textContent = 'parsed ✓ — builder updated'; renderVisual(); setMode('visual') }
    catch (e) { parseMsg.className = 'parse-msg bad'; parseMsg.textContent = String(e.message || e) }
  })
  codeArea.addEventListener('input', () => { S.src = codeArea.value })

  // ── VISUAL BUILDER render ───────────────────────────────────────────────────
  const refsFor = (method) => {
    const r = (S.model.fields || []).map((f) => f.name).concat((method.params || []).map((p) => p.name))
    for (const s of (method.stmts || [])) { if (s.t === 'local') r.push(s.name); if (s.t === 'loop') r.push(s.varName) }
    return r
  }
  function operandInput (val, refs, on) {
    const inp = el('input', { class: 'in operand', value: val == null ? '' : String(val), placeholder: 'field / param / 0', list: 'refs' })
    inp.addEventListener('input', () => { on(inp.value.trim()); syncSourceFromModel() })
    return inp
  }
  function exprEditor (expr, refs) {
    expr.a = expr.a == null ? '0' : expr.a; expr.op = expr.op || ''; expr.b = expr.b == null ? '' : expr.b
    const wrap = el('span', { class: 'expr' })
    const a = operandInput(expr.a, refs, (v) => { expr.a = v })
    const opSel = el('select', { class: 'sel op' })
    for (const o of OPS) opSel.appendChild(el('option', { value: o, text: OP_LABEL[o] }))
    opSel.value = expr.op
    const b = operandInput(expr.b, refs, (v) => { expr.b = v })
    b.hidden = !expr.op
    opSel.addEventListener('change', () => { expr.op = opSel.value; b.hidden = !expr.op; if (expr.op && !expr.b) expr.b = '0'; syncSourceFromModel() })
    wrap.appendChild(a); wrap.appendChild(opSel); wrap.appendChild(b)
    return wrap
  }
  function stmtRow (list, i, method) {
    const s = list[i]; const refs = refsFor(method)
    const row = el('div', { class: 'stmt' })
    const kind = el('select', { class: 'sel skind' })
    for (const t of ['set', 'local', 'return', 'emit', 'branch', 'loop']) kind.appendChild(el('option', { value: t, text: t }))
    kind.value = s.t
    kind.addEventListener('change', () => { list[i] = defaultStmt(kind.value, method); syncSourceFromModel(); renderVisual() })
    row.appendChild(kind)
    if (s.t === 'set') {
      const sel = el('select', { class: 'sel' })
      for (const f of S.model.fields) sel.appendChild(el('option', { value: f.name, text: f.name }))
      sel.value = s.field || (S.model.fields[0] && S.model.fields[0].name) || ''
      sel.addEventListener('change', () => { s.field = sel.value; syncSourceFromModel() })
      row.appendChild(sel); row.appendChild(el('span', { class: 'tok', text: '=' })); row.appendChild(exprEditor(s.expr, refs))
    } else if (s.t === 'local') {
      const nm = el('input', { class: 'in name', value: s.name || 'tmp' })
      nm.addEventListener('input', () => { s.name = nm.value.trim(); syncSourceFromModel() })
      row.appendChild(el('span', { class: 'tok', text: 'let' })); row.appendChild(nm); row.appendChild(el('span', { class: 'tok', text: '~u256 =' })); row.appendChild(exprEditor(s.expr, refs))
    } else if (s.t === 'return') {
      row.appendChild(exprEditor(s.expr, refs))
    } else if (s.t === 'emit') {
      const sel = el('select', { class: 'sel' })
      for (const e of S.model.events) sel.appendChild(el('option', { value: e.name, text: e.name }))
      if (!S.model.events.length) sel.appendChild(el('option', { value: '', text: '(declare an event first)' }))
      sel.value = s.event || (S.model.events[0] && S.model.events[0].name) || ''
      sel.addEventListener('change', () => { s.event = sel.value; syncSourceFromModel() })
      const args = el('span', { class: 'expr' })
      s.args = s.args && s.args.length ? s.args : ['0']
      args.appendChild(operandInput(s.args[0], refs, (v) => { s.args[0] = v }))
      row.appendChild(sel); row.appendChild(el('span', { class: 'tok', text: '(' })); row.appendChild(args); row.appendChild(el('span', { class: 'tok', text: ')' }))
    } else if (s.t === 'branch') {
      row.classList.add('nested')
      row.appendChild(el('span', { class: 'tok', text: 'if' })); row.appendChild(exprEditor(s.cond, refs))
      const then = el('div', { class: 'block' }); const els = el('div', { class: 'block' })
      renderStmtList(then, s.then, method); renderStmtList(els, s.els, method)
      row.appendChild(el('div', { class: 'branch-cols' }, [el('div', {}, [el('div', { class: 'mini', text: 'then' }), then]), el('div', {}, [el('div', { class: 'mini', text: 'else' }), els])]))
    } else if (s.t === 'loop') {
      row.classList.add('nested')
      const nm = el('input', { class: 'in name', value: s.varName || 'i' })
      nm.addEventListener('input', () => { s.varName = nm.value.trim(); syncSourceFromModel() })
      const st = operandInput(s.start, refs, (v) => { s.start = v }); const en = operandInput(s.end, refs, (v) => { s.end = v })
      row.appendChild(el('span', { class: 'tok', text: 'for' })); row.appendChild(nm); row.appendChild(el('span', { class: 'tok', text: 'from' })); row.appendChild(st); row.appendChild(el('span', { class: 'tok', text: 'to' })); row.appendChild(en)
      const body = el('div', { class: 'block' }); renderStmtList(body, s.body, method); row.appendChild(body)
    }
    const del = el('button', { class: 'x', text: '×', title: 'remove' })
    del.addEventListener('click', () => { list.splice(i, 1); syncSourceFromModel(); renderVisual() })
    row.appendChild(del)
    return row
  }
  function renderStmtList (container, list, method) {
    clear(container)
    for (let i = 0; i < list.length; i++) container.appendChild(stmtRow(list, i, method))
    const add = el('button', { class: 'add sm', text: '+ statement' })
    add.addEventListener('click', () => { list.push(defaultStmt('set', method)); syncSourceFromModel(); renderVisual() })
    container.appendChild(add)
  }
  function defaultStmt (t, method) {
    if (t === 'set') return { t: 'set', field: (S.model.fields[0] && S.model.fields[0].name) || 'count', expr: { a: (S.model.fields[0] && S.model.fields[0].name) || '0', op: '+', b: '1' } }
    if (t === 'local') return { t: 'local', name: 'tmp', type: 'u256', expr: { a: '0', op: '', b: '' } }
    if (t === 'return') return { t: 'return', expr: { a: (S.model.fields[0] && S.model.fields[0].name) || '0', op: '', b: '' } }
    if (t === 'emit') return { t: 'emit', event: (S.model.events[0] && S.model.events[0].name) || '', args: ['0'] }
    if (t === 'branch') return { t: 'branch', cond: { a: (method.params[0] && method.params[0].name) || '0', op: '!<', b: (method.params[1] && method.params[1].name) || '0' }, then: [{ t: 'return', expr: { a: (method.params[0] && method.params[0].name) || '0', op: '', b: '' } }], els: [{ t: 'return', expr: { a: (method.params[1] && method.params[1].name) || '0', op: '', b: '' } }] }
    if (t === 'loop') return { t: 'loop', varName: 'i', start: '1', end: (method.params[0] && method.params[0].name) || '1', body: [] }
    return { t: 'set', field: 'count', expr: { a: '0', op: '', b: '' } }
  }
  function sectionHead (title, onAdd, addLabel) {
    const h = el('div', { class: 'vb-sec-h' }, [el('span', { text: title })])
    if (onAdd) { const b = el('button', { class: 'add', text: addLabel }); b.addEventListener('click', onAdd); h.appendChild(b) }
    return h
  }
  function renderVisual () {
    clear(visualPanel)
    // name
    const nameRow = el('div', { class: 'row name-row' }, [el('span', { class: 'tok', text: '~contract' })])
    const nameInp = el('input', { class: 'in cname', value: S.model.name || 'Contract' })
    nameInp.addEventListener('input', () => { S.model.name = nameInp.value.trim() || 'Contract'; syncSourceFromModel() })
    nameRow.appendChild(nameInp)
    visualPanel.appendChild(nameRow)

    // fields
    const fsec = el('div', { class: 'vb-sec' })
    fsec.appendChild(sectionHead('State fields', () => { S.model.fields.push({ name: 'field' + (S.model.fields.length + 1), type: 'u256', init: '0', vis: 'public' }); syncSourceFromModel(); renderVisual() }, '+ field'))
    for (let i = 0; i < S.model.fields.length; i++) {
      const f = S.model.fields[i]
      const nm = el('input', { class: 'in name', value: f.name }); nm.addEventListener('input', () => { f.name = nm.value.trim(); syncSourceFromModel() })
      const init = el('input', { class: 'in num', value: f.init == null ? '0' : f.init }); init.addEventListener('input', () => { f.init = init.value.trim(); syncSourceFromModel() })
      const vis = el('select', { class: 'sel vis' }); for (const v of ['public', 'private']) vis.appendChild(el('option', { value: v, text: v })); vis.value = f.vis || 'public'
      vis.addEventListener('change', () => { f.vis = vis.value; syncSourceFromModel(); renderVisual() })
      const del = el('button', { class: 'x', text: '×' }); del.addEventListener('click', () => { S.model.fields.splice(i, 1); syncSourceFromModel(); renderVisual() })
      fsec.appendChild(el('div', { class: 'row' }, [el('span', { class: 'tok', text: '`' }), nm, el('span', { class: 'tok dim', text: '~u256 =' }), init, vis, del]))
    }
    visualPanel.appendChild(fsec)

    // events
    const esec = el('div', { class: 'vb-sec' })
    esec.appendChild(sectionHead('Events', () => { S.model.events.push({ name: 'Event' + (S.model.events.length + 1), params: [{ name: 'x', type: 'u256' }] }); syncSourceFromModel(); renderVisual() }, '+ event'))
    for (let i = 0; i < S.model.events.length; i++) {
      const ev = S.model.events[i]
      const nm = el('input', { class: 'in name', value: ev.name }); nm.addEventListener('input', () => { ev.name = nm.value.trim(); syncSourceFromModel() })
      const pn = el('input', { class: 'in name', value: (ev.params[0] && ev.params[0].name) || 'x' }); pn.addEventListener('input', () => { ev.params = [{ name: pn.value.trim() || 'x', type: 'u256' }]; syncSourceFromModel() })
      const del = el('button', { class: 'x', text: '×' }); del.addEventListener('click', () => { S.model.events.splice(i, 1); syncSourceFromModel(); renderVisual() })
      esec.appendChild(el('div', { class: 'row' }, [el('span', { class: 'tok', text: '~event `' }), nm, el('span', { class: 'tok dim', text: '(`' }), pn, el('span', { class: 'tok dim', text: '~u256)' }), del]))
    }
    visualPanel.appendChild(esec)

    // methods
    const msec = el('div', { class: 'vb-sec' })
    msec.appendChild(sectionHead('Methods (calls)', () => { S.model.methods.push({ name: 'method' + (S.model.methods.length + 1), params: [], stmts: [{ t: 'return', expr: { a: '0', op: '', b: '' } }] }); syncSourceFromModel(); renderVisual() }, '+ method'))
    for (let mi = 0; mi < S.model.methods.length; mi++) {
      const m = S.model.methods[mi]
      const card = el('div', { class: 'method' })
      const nm = el('input', { class: 'in name', value: m.name }); nm.addEventListener('input', () => { m.name = nm.value.trim(); syncSourceFromModel() })
      const mdel = el('button', { class: 'x', text: '×', title: 'remove method' }); mdel.addEventListener('click', () => { S.model.methods.splice(mi, 1); syncSourceFromModel(); renderVisual() })
      const paramsWrap = el('span', { class: 'params' })
      for (let pi = 0; pi < m.params.length; pi++) {
        const p = m.params[pi]
        const pn = el('input', { class: 'in name sm', value: p.name }); pn.addEventListener('input', () => { p.name = pn.value.trim(); syncSourceFromModel() })
        const px = el('button', { class: 'x', text: '×' }); px.addEventListener('click', () => { m.params.splice(pi, 1); syncSourceFromModel(); renderVisual() })
        paramsWrap.appendChild(el('span', { class: 'param' }, [el('span', { class: 'tok', text: '`' }), pn, el('span', { class: 'tok dim', text: '~u256' }), px]))
      }
      const addP = el('button', { class: 'add sm', text: '+ arg' }); addP.addEventListener('click', () => { m.params.push({ name: 'a' + (m.params.length + 1), type: 'u256' }); syncSourceFromModel(); renderVisual() })
      paramsWrap.appendChild(addP)
      card.appendChild(el('div', { class: 'method-h' }, [el('span', { class: 'tok', text: '~on `' }), nm, el('span', { class: 'tok dim', text: '(' }), paramsWrap, el('span', { class: 'tok dim', text: ')' }), mdel]))
      if (m.advanced) {
        card.appendChild(el('div', { class: 'advanced' }, [el('span', { class: 'badge', text: 'advanced body' }), el('code', { text: m.raw || '' }), el('span', { class: 'mini', text: 'edit this method in Code mode' })]))
      } else {
        const body = el('div', { class: 'block' }); renderStmtList(body, m.stmts, m); card.appendChild(body)
      }
      msec.appendChild(card)
    }
    visualPanel.appendChild(msec)
    visualPanel.appendChild(el('p', { class: 'note tiny', text: DTYPE_NOTE }))
  }

  // ── COMPILE / TEST ───────────────────────────────────────────────────────────
  const refsDatalist = el('datalist', { id: 'refs' })
  root.appendChild(refsDatalist)
  function flash (tile) { tile.classList.remove('flash'); void tile.offsetWidth; tile.classList.add('flash') }
  function logLine (text, cls) { const line = el('div', { class: 'tline ' + (cls || '') , text }); trace.insertBefore(line, trace.firstChild) }

  function renderState () {
    clear(stateGrid)
    const b = S.built; if (!b) return
    const info = b.fieldInfo.length ? b.fieldInfo : b.fields.map((n) => ({ name: n, vis: 'public' }))
    if (!info.length) { stateGrid.appendChild(el('div', { class: 'muted', text: 'no state — this contract is stateless (pure calls)' })); return }
    for (const f of info) {
      const tile = el('div', { class: 'tile' + (f.vis === 'private' ? ' priv' : ''), 'data-field': f.name }, [
        el('div', { class: 'tile-k' }, [document.createTextNode(f.name), f.vis === 'private' ? el('span', { class: 'badge', text: 'private' }) : null]),
        el('div', { class: 'tile-v', text: readField(S.store, f.name).toString() })
      ])
      stateGrid.appendChild(tile)
    }
  }
  function refreshStateValues (touched) {
    const b = S.built; if (!b) return
    const info = b.fieldInfo.length ? b.fieldInfo : b.fields.map((n) => ({ name: n }))
    for (const f of info) {
      const tile = stateGrid.querySelector('.tile[data-field="' + f.name + '"]')
      if (!tile) continue
      tile.querySelector('.tile-v').textContent = readField(S.store, f.name).toString()
      if (touched && touched.has(fieldHexKey(f.name))) flash(tile)
    }
  }
  function renderCalls () {
    clear(callsBox)
    const b = S.built; if (!b) return
    const refs = []
    for (const p of b.params) for (const a of p.params) if (refs.indexOf(a.name) < 0) refs.push(a.name)
    clear(refsDatalist); for (const r of refs) refsDatalist.appendChild(el('option', { value: r }))
    for (const ep of b.params) {
      const row = el('div', { class: 'call-row' })
      const sig = el('div', { class: 'call-sig' }, [el('span', { class: 'ep', text: ep.name }), el('span', { class: 'paren', text: '(' })])
      const inputs = []
      ep.params.forEach((p, idx) => {
        if (idx) sig.appendChild(el('span', { class: 'paren', text: ', ' }))
        const inp = el('input', { class: 'arg', value: '', placeholder: p.name })
        inp._p = p; inputs.push(inp); sig.appendChild(inp)
      })
      sig.appendChild(el('span', { class: 'paren', text: ')' }))
      const run = el('button', { class: 'btn sm', text: 'Run' })
      run.addEventListener('click', async () => {
        let args
        try { args = inputs.map((i) => { const t = (i.value || '').trim(); if (!/^\d+$/.test(t)) throw new Error('arg "' + i._p.name + '" must be a non-negative integer'); return BigInt(t) }) }
        catch (e) { logLine('✗ ' + e.message, 'bad'); return }
        try {
          const out = {}
          const ret = await callEntry(b.wasm, S.store, ep.name, args, out)
          refreshStateValues(out.touched)
          if (S.deployed) persistDeployed()
          const wrote = [...(out.touched || [])].length
          const parts = ['✓ ' + ep.name + '(' + args.join(', ') + ')']
          if (ret !== undefined) parts.push('→ ' + ret.toString())
          if (wrote) parts.push('· wrote ' + wrote + ' field' + (wrote > 1 ? 's' : ''))
          if (out.events) parts.push('· emitted ' + out.events + ' event' + (out.events > 1 ? 's' : ''))
          logLine(parts.join(' '), 'ok')
        } catch (e) { logLine('✗ ' + ep.name + ' reverted: ' + (e && e.message ? e.message : String(e)), 'bad') }
      })
      row.appendChild(sig); row.appendChild(run)
      callsBox.appendChild(row)
    }
  }
  resetBtn.addEventListener('click', () => { S.store = S.deployed ? loadDeployedStore() : makeStore(); renderState(); logLine('— state reset —', 'muted') })

  async function doCompile () {
    buildMsg.className = 'parse-msg'; buildMsg.textContent = 'compiling…'
    try {
      const b = await buildContract(S.src)
      S.built = b
      if (!S.deployed) S.store = makeStore()
      buildMsg.className = 'parse-msg ok'
      buildMsg.textContent = 'compiled ✓ — ' + b.entrypoints.length + ' entrypoints, ' + b.fieldInfo.length + ' fields, ' + b.wasm.length + ' bytes'
      renderState(); renderCalls(); renderDeploy()
    } catch (e) {
      S.built = null
      buildMsg.className = 'parse-msg bad'; buildMsg.textContent = 'compile error: ' + (e && e.message ? e.message : String(e))
      clear(stateGrid); clear(callsBox)
    }
  }
  compileBtn.addEventListener('click', doCompile)

  // ── DEPLOY — a persistent, content-addressed instance committed in-page ───────
  function loadDeployedStore () {
    const d = S.deployed; const s = makeStore()
    if (d && d.kv) for (const [k, v] of d.kv) s.set(k, v)
    return s
  }
  function persistDeployed () {
    if (!S.deployed) return
    S.deployed.kv = [...S.store.entries()]   // the live instance's committed state, held for this session
  }
  function renderDeploy () {
    clear(deployBody)
    const b = S.built
    if (!b) { deployBody.appendChild(el('p', { class: 'muted', text: 'Compile a contract to derive its identity and deploy.' })); return }
    const id = contractIdOf(b.wasm)
    const coords = contractCoordinatesOf(id)
    const isLive = !!(S.deployed && S.deployed.id === id)
    deployBtn.textContent = isLive ? '✓ Deployed' : '⬢ Deploy to xmbl'
    deployBtn.disabled = isLive

    const kv = el('div', { class: 'kv' }, [
      el('div', { class: 'k', text: 'contract' }), el('div', { class: 'v mono', text: b.fieldInfo.length ? (S.model.name || 'Contract') : (S.model.name || 'Contract') }),
      el('div', { class: 'k', text: 'id' }), el('div', { class: 'v mono wrap', text: id }),
      el('div', { class: 'k', text: 'cube' }), el('div', { class: 'v mono', text: coords.cubeAddress }),
      el('div', { class: 'k', text: 'plane' }), el('div', { class: 'v mono', text: coords.coordinates.map((p) => '(' + p.x + ',' + p.y + ',' + p.z + ')').join(' ') })
    ])
    deployBody.appendChild(kv)
    if (isLive) {
      const committed = (S.deployed.kv || []).length
      deployBody.appendChild(el('div', { class: 'live-badge', text: '● live instance · ' + committed + ' committed state word' + (committed === 1 ? '' : 's') + ' · Test now runs against it' }))
      const undeploy = el('button', { class: 'btn danger sm', text: 'Undeploy (clear instance)' })
      undeploy.addEventListener('click', () => { S.deployed = null; S.store = makeStore(); renderState(); renderDeploy(); logLine('— instance undeployed —', 'muted') })
      deployBody.appendChild(undeploy)
    }
    deployBody.appendChild(el('pre', { class: 'descriptor', text: JSON.stringify({ id, cube: coords.cubeAddress, plane: coords.coordinates, wasm_sha256: id.slice(4), bytes: b.wasm.length, apply: "ContractHost.deploy(wasm, [], { byteState: true, wordAbi: true, fields: contractFields(src) })" }, null, 2) }))
    deployBody.appendChild(el('p', { class: 'note', text: 'Deploy commits a genesis instance at this content-addressed id and switches Test onto it — every call you run is committed to the live instance for this session. Deploying to the live mainnet needs an xmbl node endpoint, gated behind the external protocol audit (AUDIT_GATES_OPEN); the descriptor above is exactly what an operator applies with ContractHost.deploy on a node.' })) }
  deployBtn.addEventListener('click', () => {
    const b = S.built; if (!b) return
    const id = contractIdOf(b.wasm); const coords = contractCoordinatesOf(id)
    S.deployed = { id, name: S.model.name || 'Contract', cube: coords.cubeAddress, src: S.src, kv: [...S.store.entries()], deployedAt: new Date().toISOString() }
    persistDeployed()
    renderDeploy()
    logLine('⬢ deployed ' + id.slice(0, 16) + '… — test now runs against the live instance', 'ok')
  })

  // ── first paint ───────────────────────────────────────────────────────────
  renderVisual()
  codeArea.value = S.src
  setMode('visual')
  doCompile()
}

if (typeof document !== 'undefined') boot()
