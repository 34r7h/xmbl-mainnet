<template>
  <div>
    <div class="sec">
      <div class="sec-h"><span class="eyebrow">Host capabilities</span>
        <span class="live-dot" :class="{ on: connected }">{{ connected ? 'devnet' : 'no devnet' }}</span>
      </div>
      <p class="hint">The opt-in crypto host calls a deployed contract can declare. They run on a node (they need node:crypto; an in-page MV3 popup cannot), so each runs for REAL in the devnet and returns a verdict here — the honest result and its negative control, never a fabricated pass.</p>
    </div>

    <!-- SIGNATURE VERIFY (cryptoHost) -->
    <div class="cap">
      <div class="cap-h"><span class="cap-name">Signature verify</span><span class="cap-flag mono">deploy: cryptoHost</span></div>
      <div class="cap-sig mono">env.xmbl_cubic_sig_verify · env.xmbl_mayo_verify</div>
      <div class="field"><label for="sig-m">message</label><input id="sig-m" class="in mono" v-model="sigMsg" spellcheck="false" /></div>
      <button class="btn primary sm" :disabled="busy.sig || !connected" @click="run('sig')">{{ busy.sig ? 'Running…' : 'Sign &amp; verify' }}</button>
      <div v-if="out.sig" class="verdict" :class="{ ok: out.sig.ok, bad: out.sig.ok === false }">{{ verdictText('sig', out.sig) }}</div>
      <p class="cap-proof">Cubic-SIG / MAYO over material the contract supplies. Proven by <code>node reproductions/agentic-contract-e2e.mjs</code>.</p>
    </div>

    <!-- COORDINATE / CURVE PROOF (zkHost) -->
    <div class="cap">
      <div class="cap-h"><span class="cap-name">Coordinate / curve proof</span><span class="cap-flag mono">deploy: zkHost</span></div>
      <div class="cap-sig mono">env.xmbl_zk_verify(x_ptr, y_ptr) → i32</div>
      <div class="field"><label for="zk-x">derivedX (public coordinate)</label><input id="zk-x" class="in mono" v-model="zkX" inputmode="numeric" spellcheck="false" /></div>
      <button class="btn primary sm" :disabled="busy.zk || !connected" @click="run('zk')">{{ busy.zk ? 'Proving…' : 'Prove &amp; verify' }}</button>
      <div v-if="out.zk" class="verdict" :class="{ ok: out.zk.ok, bad: out.zk.ok === false }">{{ verdictText('zk', out.zk) }}</div>
      <p class="cap-proof">⛔ UNAUDITED FRI proof (@xmbl/zero-knowledge). The verdict gates a Verkle write — proven by <code>node reproductions/contract-zk.mjs</code>.</p>
    </div>

    <!-- ENCRYPTED ADD (heHost) -->
    <div class="cap">
      <div class="cap-h"><span class="cap-name">Encrypted add (homomorphic)</span><span class="cap-flag mono">deploy: heHost</span></div>
      <div class="cap-sig mono">env.xmbl_he_add(a_ptr, b_ptr, out_ptr) → i32</div>
      <div class="row" style="gap:14px;margin:4px 0 8px">
        <label class="bit">a <input type="checkbox" v-model="heA" /> <span class="mono">{{ heA ? 1 : 0 }}</span></label>
        <label class="bit">b <input type="checkbox" v-model="heB" /> <span class="mono">{{ heB ? 1 : 0 }}</span></label>
      </div>
      <button class="btn primary sm" :disabled="busy.he || !connected" @click="run('he')">{{ busy.he ? 'Adding…' : 'Add under encryption' }}</button>
      <div v-if="out.he" class="verdict" :class="{ ok: out.he.ok, bad: out.he.ok === false }">{{ verdictText('he', out.he) }}</div>
      <p class="cap-proof">Post-quantum cubic-LWE; the add sees no secret key. Proven by <code>node reproductions/contract-he.mjs</code>.</p>
    </div>

    <!-- SEAL (zkHost + heHost + seal, USDC settlement) -->
    <div class="cap">
      <div class="cap-h"><span class="cap-name">Seal (USDC settlement)</span><span class="cap-flag mono">zkHost + heHost + seal</span></div>
      <div class="cap-sig mono">release = zk_verify(H(record)) · net = he_add · auth = sealSecret→openSecret</div>
      <div class="field"><label for="seal-s">secret (authorizing key)</label><input id="seal-s" class="in mono" v-model="sealSecret" spellcheck="false" /></div>
      <button class="btn primary sm" :disabled="busy.seal || !connected" @click="run('seal')">{{ busy.seal ? 'Sealing…' : 'Seal &amp; open' }}</button>
      <div v-if="out.seal" class="verdict" :class="{ ok: out.seal.ok, bad: out.seal.ok === false }">{{ verdictText('seal', out.seal) }}</div>
      <p class="cap-proof">The rail's authorizing key is sealed (PQ, MAINNET_N) to the receiver, never custodied. Proven by <code>node reproductions/contract-usdc-settlement.mjs</code>.</p>
    </div>

    <p class="note" v-if="!connected">These run on a node, not in this popup. Start a devnet to run them: <code>npm run devnet -w packages/simulator</code> (default <code>http://127.0.0.1:8646</code>, set it in the Config tab). A contract opts into each with the deploy flag shown; decryption is on no host ABI.</p>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import browser from 'webextension-polyfill'

const connected = ref(false)
const busy = reactive({ sig: false, zk: false, he: false, seal: false })
const out = reactive({ sig: null, zk: null, he: null, seal: null })

const sigMsg = ref('xmbl-extension')
const zkX = ref('99')
const heA = ref(true)
const heB = ref(true)
const sealSecret = ref('authorizing-key')

const MSG = {
  sig: () => ({ type: 'sigVerify', message: sigMsg.value }),
  zk: () => ({ type: 'zkProof', derivedX: Number(zkX.value) || 0 }),
  he: () => ({ type: 'heAdd', a: heA.value ? 1 : 0, b: heB.value ? 1 : 0 }),
  seal: () => ({ type: 'seal', secret: sealSecret.value }),
}

async function run (k) {
  busy[k] = true; out[k] = null
  try {
    const r = await browser.runtime.sendMessage(MSG[k]())
    connected.value = !!(r && r.connected)
    out[k] = r && r.connected ? r : { ok: false, error: (r && r.error) || 'devnet unreachable' }
  } catch (e) { out[k] = { ok: false, error: e.message || String(e) } }
  finally { busy[k] = false }
}

function verdictText (k, r) {
  if (r.error) return '✗ ' + r.error
  if (k === 'sig') return (r.ok ? '✓ ' : '✗ ') + 'signed+verified, tampered rejected — ' + r.scheme
  if (k === 'zk') return (r.ok ? '✓ ' : '✗ ') + 'derivedY=' + r.derivedY + ' verifies; tampered coordinate rejected'
  if (k === 'he') return (r.ok ? '✓ ' : '✗ ') + 'ENC(' + r.a + ') ⊞ ENC(' + r.b + ') → ' + r.sum + ' (mod-2), added blind'
  if (k === 'seal') return (r.ok ? '✓ ' : '✗ ') + 'secret sealed to receiver and reopened — ' + r.scheme
  return r.ok ? '✓ ok' : '✗ failed'
}

onMounted(async () => {
  // Cheap reachability probe so the buttons reflect devnet presence without forcing a run.
  try { const r = await browser.runtime.sendMessage({ type: 'getNodeStatus' }); connected.value = !!(r && r.connected) }
  catch { connected.value = false }
})
</script>

<style scoped>
.live-dot { font-family: var(--mono); font-size: .625rem; letter-spacing: .1em; text-transform: uppercase; color: var(--faint); }
.live-dot.on { color: var(--good-ink); }
.cap { border: 1px solid var(--rule-2); border-radius: var(--r-md); padding: 11px 12px; margin-top: 12px; box-shadow: var(--cap-lift); }
.cap-h { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.cap-name { font-weight: 700; color: var(--ink); font-size: .9375rem; }
.cap-flag { font-size: .625rem; color: var(--patina-ink); }
.cap-sig { font-size: .6875rem; color: var(--muted); margin: 3px 0 9px; word-break: break-all; }
.cap .field { margin-bottom: 8px; }
.bit { display: inline-flex; align-items: center; gap: 5px; font-size: .8125rem; color: var(--muted); }
.verdict { margin-top: 9px; font-size: .75rem; border-radius: var(--r-sm); padding: 7px 10px; border: 1px solid var(--rule-2); background: var(--paper-deep); color: var(--muted); word-break: break-word; }
.verdict.ok { color: var(--good-ink); border-color: oklch(70% .12 188 / .3); background: oklch(70% .12 188 / .1); }
.verdict.bad { color: var(--bad-ink); border-color: var(--bad-dim); background: var(--bad-dim); }
.cap-proof { font-size: .6875rem; line-height: 1.5; color: var(--faint); margin: 9px 0 0; }
.cap-proof code { font-family: var(--mono); color: var(--muted); }
</style>
