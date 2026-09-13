<template>
  <div>
    <div class="sec">
      <div class="sec-h"><span class="eyebrow">Node</span>
        <span class="live-dot" :class="{ on: connected && status.running }">{{ !connected ? 'no devnet' : (status.running ? 'running' : 'stopped') }}</span>
      </div>
      <div class="stat-grid">
        <div class="stat"><div class="k">peers</div><div class="v mono">{{ status.peers }}</div></div>
        <div class="stat"><div class="k">height</div><div class="v mono">{{ status.height }}</div></div>
        <div class="stat"><div class="k">pooled</div><div class="v mono">{{ root.pooled }}</div></div>
        <div class="stat"><div class="k">landed</div><div class="v mono">{{ root.landed }}</div></div>
      </div>
      <div class="field" style="margin-top:9px">
        <label>state root</label>
        <div class="rootbox mono">{{ connected ? (root.root || '—') : 'connect a devnet to read the live state root' }}</div>
      </div>
      <div class="row" style="margin-top:9px">
        <button class="btn ghost sm" :disabled="!connected" @click="toggleNode">{{ status.running ? 'Stop node' : 'Start node' }}</button>
        <button class="btn ghost sm" @click="refresh">Refresh</button>
      </div>
    </div>

    <div class="sec">
      <div class="sec-h"><span class="eyebrow">Modules</span><span class="hint">every xmbl-mainnet part &amp; where it runs</span></div>
      <div v-for="m in MODULES" :key="m.name" class="mod">
        <div class="mod-top">
          <span class="mod-name mono">{{ m.name }}</span>
          <span class="mod-where" :class="m.where">{{ m.whereLabel }}</span>
        </div>
        <div class="mod-desc">{{ m.desc }}</div>
      </div>
    </div>

    <p class="note">In-page parts (contracts, the builder) run for real in this popup. Node-backed parts (ledger, consensus, networking, storage, state, crypto) run in a devnet reached over loopback — start one with <code>npm run devnet -w packages/simulator</code> and point the extension at it in the Config tab. A P2P node or storage market cannot run inside a popup; those are used and configured through the node, not faked here.</p>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted, onUnmounted } from 'vue'
import browser from 'webextension-polyfill'

const connected = ref(false)
const status = reactive({ running: false, peers: 0, height: 0 })
const root = reactive({ root: null, pooled: 0, landed: 0 })
let poll = null

// The whole xmbl-mainnet module set and the honest surface each has in the extension.
const MODULES = [
  { name: '@xmbl/lng', desc: 'The LNG contract language → WASM compiler.', where: 'inpage', whereLabel: 'in-page' },
  { name: '@xmbl/contracts', desc: 'XCL contract runtime — compile, deploy, call, test.', where: 'inpage', whereLabel: 'in-page' },
  { name: '@xmbl/identity', desc: 'MAYO keys, Cubic-SIG, cubic-LWE, seal.', where: 'devnet', whereLabel: 'devnet' },
  { name: '@xmbl/zero-knowledge', desc: 'XZK coordinate/curve proofs (⛔ unaudited).', where: 'devnet', whereLabel: 'devnet' },
  { name: '@xmbl/cubic-ledger', desc: 'Cube/face ledger — balances, state root.', where: 'devnet', whereLabel: 'devnet' },
  { name: '@xmbl/consensus', desc: 'Face sealing & lead workflow.', where: 'devnet', whereLabel: 'devnet' },
  { name: '@xmbl/state-machine', desc: 'Verkle state tree & diffs.', where: 'devnet', whereLabel: 'devnet' },
  { name: '@xmbl/storage-compute', desc: 'Storage shards, compute runtime, market.', where: 'devnet', whereLabel: 'devnet' },
  { name: '@xmbl/networking', desc: 'XN P2P node, discovery, gossip, pubsub.', where: 'devnet', whereLabel: 'devnet' },
  { name: '@xmbl/core', desc: 'Node composition & mainnet gates.', where: 'devnet', whereLabel: 'devnet' },
  { name: '@xmbl/simulator', desc: 'LocalDevnet + RPC — the bridge this talks to.', where: 'config', whereLabel: 'config' },
  { name: '@xmbl/cli', desc: 'Command-line node control.', where: 'cli', whereLabel: 'cli' },
]

async function refresh () {
  try {
    const s = await browser.runtime.sendMessage({ type: 'getNodeStatus' })
    if (s) { status.running = !!s.running; status.peers = s.peers || 0; status.height = s.height || 0; connected.value = !!s.connected }
    if (s && s.connected) {
      const r = await browser.runtime.sendMessage({ type: 'getStateRoot' })
      if (r && r.connected) { root.root = r.root; root.pooled = r.pooled || 0; root.landed = r.landed || 0 }
    }
  } catch (e) { console.error('node refresh:', e) }
}

async function toggleNode () {
  try { await browser.runtime.sendMessage({ type: status.running ? 'stopNode' : 'startNode' }); await refresh() }
  catch (e) { console.error('node toggle:', e) }
}

onMounted(async () => { await refresh(); poll = setInterval(refresh, 5000) })
onUnmounted(() => { if (poll) clearInterval(poll) })
</script>

<style scoped>
.live-dot { font-family: var(--mono); font-size: .625rem; letter-spacing: .1em; text-transform: uppercase; color: var(--faint); }
.live-dot.on { color: var(--good-ink); }
.stat-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.stat { border: 1px solid var(--rule); border-radius: var(--r-md); padding: 9px 11px; }
.stat .k { font-family: var(--mono); font-size: .5625rem; letter-spacing: .12em; text-transform: uppercase; color: var(--faint); }
.stat .v { font-size: 1.125rem; font-weight: 600; color: var(--ink); margin-top: 2px; }
.rootbox { font-size: .6875rem; color: var(--text); background: var(--paper-deep); border: 1px solid var(--rule); border-radius: var(--r-sm); padding: 8px 10px; word-break: break-all; }

.mod { border: 1px solid var(--rule); border-radius: var(--r-sm); padding: 8px 10px; margin-bottom: 6px; }
.mod-top { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.mod-name { font-size: .75rem; font-weight: 600; color: var(--ink); }
.mod-where { font-size: .5rem; letter-spacing: .1em; text-transform: uppercase; border-radius: var(--r-pill); padding: 1px 7px; border: 1px solid var(--rule-2); color: var(--faint); }
.mod-where.inpage { color: var(--good-ink); border-color: oklch(70% .12 188 / .4); }
.mod-where.devnet { color: var(--patina-ink); border-color: oklch(70% .12 188 / .3); }
.mod-where.config { color: var(--on-gold); background: var(--kinpaku); border-color: var(--kinpaku-deep); }
.mod-desc { font-size: .6875rem; color: var(--muted); margin-top: 3px; }
</style>
