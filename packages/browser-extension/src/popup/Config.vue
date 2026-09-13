<template>
  <div>
    <div class="sec">
      <div class="sec-h"><span class="eyebrow">Devnet endpoint</span>
        <span class="live-dot" :class="{ on: connected }">{{ tested ? (connected ? 'reachable' : 'unreachable') : 'not tested' }}</span>
      </div>
      <p class="hint">Where the wallet, node and crypto tabs reach the xmbl network. Point it at a LocalDevnet RPC (<code>npm run devnet -w packages/simulator</code>) or any compatible node endpoint.</p>
      <div class="field">
        <label for="cfg-url">RPC URL</label>
        <input id="cfg-url" class="in mono" v-model="url" placeholder="http://127.0.0.1:8646" spellcheck="false" autocomplete="off" />
      </div>
      <div class="row">
        <button class="btn primary sm" :disabled="busy" @click="save">{{ busy ? 'Saving…' : 'Save &amp; test' }}</button>
        <button class="btn ghost sm" :disabled="busy" @click="reset">Reset to default</button>
      </div>
      <div v-if="msg" class="status" :class="msgKind">{{ msg }}</div>
    </div>

    <div class="sec">
      <div class="sec-h"><span class="eyebrow">Current</span></div>
      <div class="kv"><span class="k mono">endpoint</span><span class="v mono">{{ saved || '—' }}</span></div>
      <div class="kv"><span class="k mono">status</span><span class="v mono">{{ tested ? (connected ? 'reachable · node ' + (running ? 'running' : 'stopped') : 'unreachable') : 'not tested' }}</span></div>
    </div>

    <p class="note">The endpoint persists in <code>browser.storage.local</code> under <code>xmbl:devnetUrl</code> and is used by every tab. It is stored only on this device and sent only to the endpoint you set — never anywhere else.</p>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import browser from 'webextension-polyfill'

const DEFAULT = 'http://127.0.0.1:8646'
const url = ref(DEFAULT)
const saved = ref('')
const connected = ref(false)
const running = ref(false)
const tested = ref(false)
const busy = ref(false)
const msg = ref('')
const msgKind = ref('info')

async function save () {
  busy.value = true; msg.value = ''
  try {
    const r = await browser.runtime.sendMessage({ type: 'setDevnetUrl', url: url.value })
    saved.value = r.url; url.value = r.url
    connected.value = !!r.connected; running.value = !!r.running; tested.value = true
    msg.value = r.connected ? 'Saved — devnet reachable' + (r.running ? ' and running.' : ' (node stopped).') : 'Saved, but no devnet is reachable there yet.'
    msgKind.value = r.connected ? 'ok' : 'bad'
  } catch (e) { msg.value = 'Failed: ' + (e.message || e); msgKind.value = 'bad' }
  finally { busy.value = false }
}

function reset () { url.value = DEFAULT; save() }

onMounted(async () => {
  try { const r = await browser.runtime.sendMessage({ type: 'getDevnetUrl' }); if (r && r.url) { url.value = r.url; saved.value = r.url } }
  catch { /* leave default */ }
})
</script>

<style scoped>
.live-dot { font-family: var(--mono); font-size: .625rem; letter-spacing: .1em; text-transform: uppercase; color: var(--faint); }
.live-dot.on { color: var(--good-ink); }
.kv { display: flex; gap: 10px; align-items: baseline; margin-bottom: 5px; }
.kv .k { font-size: .5625rem; letter-spacing: .12em; text-transform: uppercase; color: var(--faint); flex: 0 0 64px; }
.kv .v { font-size: .75rem; color: var(--text); word-break: break-all; }
</style>
