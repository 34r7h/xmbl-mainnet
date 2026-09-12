<template>
  <div>
    <div class="sec">
      <div class="sec-h"><span class="eyebrow">Balance</span></div>
      <div class="balance-amt"><span class="amt mono">{{ balance }}</span> <span class="unit">XMBL</span></div>
    </div>

    <div class="sec">
      <div class="sec-h"><span class="eyebrow">Send</span></div>
      <div class="field">
        <label for="w-to">Recipient address</label>
        <input id="w-to" class="in mono" v-model="recipient" placeholder="xmbl address" autocomplete="off" spellcheck="false" />
      </div>
      <div class="field">
        <label for="w-amt">Amount</label>
        <input id="w-amt" class="in mono" v-model="amount" type="number" step="0.000001" min="0" placeholder="0.0" />
      </div>
      <button class="btn primary" style="width:100%" :disabled="sending" @click="sendTransaction">{{ sending ? 'Sending…' : 'Send' }}</button>
      <div v-if="sendMsg" class="status" :class="sendMsgKind" role="status">{{ sendMsg }}</div>
    </div>

    <div class="sec">
      <div class="sec-h"><span class="eyebrow">Node</span>
        <span class="live-dot" :class="{ on: nodeStatus.running }">{{ nodeStatus.running ? 'running' : 'stopped' }}</span>
      </div>
      <div class="stat-grid">
        <div class="stat"><div class="k">peers</div><div class="v mono">{{ nodeStatus.peers }}</div></div>
        <div class="stat"><div class="k">height</div><div class="v mono">{{ nodeStatus.height }}</div></div>
      </div>
      <button class="btn ghost sm" style="margin-top:9px" @click="toggleNode">{{ nodeStatus.running ? 'Stop node' : 'Start node' }}</button>
    </div>

    <p class="note">The node bridge is a stub until a local xmbl node endpoint is wired — balances and transactions are placeholders. Contract creation, deployment and calls (the Contracts tab) run for real, in-page.</p>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import browser from 'webextension-polyfill'

const balance = ref(0)
const recipient = ref('')
const amount = ref('')
const nodeStatus = ref({ running: false, peers: 0, height: 0 })
const sending = ref(false)
const sendMsg = ref('')
const sendMsgKind = ref('info')
let poll = null

function say (text, kind) { sendMsg.value = text; sendMsgKind.value = kind || 'info' }

async function loadBalance () {
  try { const r = await browser.runtime.sendMessage({ type: 'getBalance', address: 'current' }); balance.value = (r && r.balance) || 0 }
  catch (e) { console.error('balance:', e) }
}

async function sendTransaction () {
  if (!recipient.value || !amount.value) { say('Enter a recipient and an amount.', 'bad'); return }
  sending.value = true; say('', 'info')
  try {
    const r = await browser.runtime.sendMessage({ type: 'sendTransaction', tx: { to: recipient.value, amount: parseFloat(amount.value) } })
    say('Transaction submitted: ' + (r && r.txId ? r.txId : 'ok'), 'ok')
    recipient.value = ''; amount.value = ''
    await loadBalance()
  } catch (e) { say('Send failed: ' + (e.message || e), 'bad') }
  finally { sending.value = false }
}

async function loadNodeStatus () {
  try { const s = await browser.runtime.sendMessage({ type: 'getNodeStatus' }); if (s) nodeStatus.value = s }
  catch (e) { console.error('node status:', e) }
}

async function toggleNode () {
  try { await browser.runtime.sendMessage({ type: nodeStatus.value.running ? 'stopNode' : 'startNode' }); await loadNodeStatus() }
  catch (e) { say('Node toggle failed: ' + (e.message || e), 'bad') }
}

onMounted(async () => { await loadBalance(); await loadNodeStatus(); poll = setInterval(loadNodeStatus, 5000) })
onUnmounted(() => { if (poll) clearInterval(poll) })
</script>

<style scoped>
.balance-amt { display: flex; align-items: baseline; gap: 6px; }
.amt { font-size: 2rem; font-weight: 700; color: var(--ink); letter-spacing: -.01em; }
.unit { font-size: .875rem; font-weight: 600; color: var(--faint); }
.live-dot { font-family: var(--mono); font-size: .625rem; letter-spacing: .1em; text-transform: uppercase; color: var(--faint); }
.live-dot.on { color: var(--good-ink); }
.stat-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.stat { border: 1px solid var(--rule); border-radius: var(--r-md); padding: 9px 11px; }
.stat .k { font-family: var(--mono); font-size: .5625rem; letter-spacing: .12em; text-transform: uppercase; color: var(--faint); }
.stat .v { font-size: 1.125rem; font-weight: 600; color: var(--ink); margin-top: 2px; }
</style>
