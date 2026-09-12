// XMBL in-page contract runtime for the browser extension.
//
// This is a FAITHFUL PORT of the miniapp's verified in-page executor
// (apps/app-builder/miniapp/contract-lab.js) — the same @xmbl/lng compiler, the same pure-JS
// SHA-256, the same content-addressed id derivation, and the same XCL byte-pointer state ABI +
// LNG word calling convention. It exists as its own file (rather than importing contract-lab.js)
// because that module auto-boots its DOM UI when a `document` is present, which the popup has.
//
// PARITY is not asserted by inspection: __tests__/contract-runtime.parity.test.mjs compiles a
// sample with THIS module and asserts contractIdOf(wasm) is byte-identical to @xmbl/contracts'
// node-side `contractId` — the same guarantee verify-contract-lab.mjs makes for the miniapp.
//
// EXECUTION BOUNDARY (identical to the miniapp's Test mode): in-page WebAssembly.instantiate runs the
// REAL compiled bytecode over a Map that stands in for committed Verkle state, but it is NOT the
// production path — no worker isolation, CPU metering, Verkle commitment, or delegation gate. Those
// live only on a node (the headless reproductions/agentic-contract-e2e.mjs). A contract deployed
// here is stored locally in the extension; the deploy DESCRIPTOR it produces is exactly what an
// operator applies with ContractHost.deploy on a node.

import { compile, contractFields, lex, parse } from '@xmbl/lng'

// @xmbl/lng emits name bytes with `Buffer.from(name, 'utf8')`; that node global is absent in the
// extension. The compiler only needs the UTF-8 (and hex) bytes as an iterable, so a
// TextEncoder-backed shim is exact and sufficient. Installed before any compile runs.
if (typeof globalThis.Buffer === 'undefined') {
  globalThis.Buffer = {
    from (input, enc) {
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

// ── SHA-256 (pure JS, no crypto.subtle) ──────────────────────────────────────
// So the extension-derived contract id equals a node's createHash('sha256')-derived id in every
// context, synchronously (a host import must be sync; WebCrypto's digest is async).
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

function sha256Bytes (msg) {
  const rotr = (x, n) => (x >>> n) | (x << (32 - n))
  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ])
  const l = msg.length
  const bitLen = l * 8
  const withPad = (((l + 8) >> 6) + 1) << 6
  const buf = new Uint8Array(withPad)
  buf.set(msg)
  buf[l] = 0x80
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

// ── PLACEMENT — content-addressed identity (mirrors packages/contracts/src/xcl/placement.js) ──
export function contractIdOf (wasmBytes) {
  return 'xc1_' + sha256Hex(wasmBytes instanceof Uint8Array ? wasmBytes : Uint8Array.from(wasmBytes))
}
const coord = (h, i) => ((parseInt(h.slice(i * 2, i * 2 + 2), 16) % 3) - 1)
export function contractCoordinatesOf (id) {
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

// ── IN-PAGE EXECUTOR — XCL byte-pointer state ABI + LNG word calling convention ──
const WORD = 32
const fieldHexKey = (name) => hex(utf8(name))

export function makeStore () { return new Map() } // hexKey(field-name bytes) -> hexValue(64 chars, LE)

export function readField (store, name) {
  const hv = store.get(fieldHexKey(name))
  if (!hv) return 0n
  let v = 0n
  for (let i = 0; i < WORD; i++) v |= BigInt(parseInt(hv.slice(i * 2, i * 2 + 2), 16)) << BigInt(i * 8)
  return v
}

// Instantiate the compiled module and invoke one entrypoint with word-marshalled args.
// Returns the decoded return value; mutates `store` with the frame's writes. `out`, if given, is
// filled with out.touched (Set of hex keys written) and out.events (the __events() counter after).
export async function callEntry (wasm, store, fn, argVals, out) {
  const touched = out ? (out.touched || (out.touched = new Set())) : null
  let inst = null
  const mem = () => inst.exports.memory
  const imports = {
    env: {
      // xmbl_verkle_get(key_ptr, key_len, val_out_ptr) -> 0 ok / 1 key OOB / 2 val OOB
      xmbl_verkle_get (keyPtr, keyLen, valOutPtr) {
        const v = new Uint8Array(mem().buffer)
        if (keyPtr < 0 || keyLen < 0 || keyPtr + keyLen > v.length) return 1
        if (valOutPtr < 0 || valOutPtr + WORD > v.length) return 2
        const k = hex(v.subarray(keyPtr, keyPtr + keyLen))
        const stored = store.get(k)
        for (let i = 0; i < WORD; i++) v[valOutPtr + i] = stored ? parseInt(stored.slice(i * 2, i * 2 + 2), 16) : 0
        return 0
      },
      // xmbl_verkle_set(key_ptr, key_len, val_ptr, val_len) -> 0 ok / 1 key OOB / 2 val OOB / 3 len>32
      xmbl_verkle_set (keyPtr, keyLen, valPtr, valLen) {
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
  if (typeof ret !== 'number') return ret
  const d = new DataView(mem().buffer)
  let v = 0n
  for (let i = LIMBS - 1; i >= 0; i--) v = (v << 64n) | d.getBigUint64(ret + i * 8, true)
  return v
}

// ── COMPILE + INTROSPECT — one call returns wasm, public fields, entrypoints, per-entry params ──
export async function buildContract (src) {
  const wasm = compile(src, { hostState: true })
  const fields = contractFields(src)
  const mod = await WebAssembly.compile(wasm)
  const entrypoints = WebAssembly.Module.exports(mod)
    .filter((e) => e.kind === 'function' && !e.name.startsWith('__'))
    .map((e) => e.name)
  const contract = parse(lex(src)).body.find((n) => n.kind === 'contract')
  const methodParams = {}
  if (contract) for (const m of contract.methods) methodParams[m.name] = m.params.map((p) => ({ name: p.name, type: p.type || 'u256' }))
  const params = entrypoints.map((name) => ({ name, params: methodParams[name] || [] }))
  const fieldInfo = contract ? contract.fields.map((f) => ({ name: f.name, type: f.type || 'u256', vis: f.vis || 'public' })) : []
  const events = contract ? contract.events.map((e) => ({ name: e.name, params: e.params.map((p) => ({ name: p.name, type: p.type || 'u256' })) })) : []
  const name = contract ? contract.name : 'Contract'
  return { wasm, name, fields, fieldInfo, events, entrypoints, params }
}
