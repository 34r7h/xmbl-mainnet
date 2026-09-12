<template>
  <div>
    <!-- CREATE -->
    <div class="sec">
      <div class="sec-h"><span class="eyebrow">Create</span><span class="hint">write LNG, or start from an example</span></div>
      <div class="row wrap" style="margin-bottom:8px">
        <select class="sel" style="width:auto;flex:0 0 auto" v-model="sample" @change="pickSample">
          <option value="">example…</option>
          <option v-for="(s, k) in SAMPLES" :key="k" :value="k">{{ s.title }}</option>
        </select>
        <button class="btn primary sm" :disabled="compiling" @click="doCompile">{{ compiling ? 'Compiling…' : 'Compile →' }}</button>
      </div>
      <textarea class="code" v-model="src" spellcheck="false" @input="onEdit"></textarea>
      <div v-if="buildErr" class="status bad" role="alert">{{ buildErr }}</div>
      <div v-else-if="built" class="status ok">
        Compiled · {{ built.entrypoints.length }} entrypoint{{ built.entrypoints.length === 1 ? '' : 's' }}, {{ built.fields.length }} field{{ built.fields.length === 1 ? '' : 's' }}, {{ built.wasm.length }} bytes
      </div>
    </div>

    <!-- DEPLOY -->
    <div v-if="built" class="sec">
      <div class="sec-h"><span class="eyebrow">Deploy</span><span class="hint">content-addressed, same id a node derives</span></div>
      <div class="idbox">
        <div class="idrow"><span class="k">id</span><span class="v mono">{{ id }}</span></div>
        <div class="idrow"><span class="k">cube</span><span class="v mono">{{ coords.cubeAddress }}</span></div>
      </div>
      <button class="btn primary" style="width:100%;margin-top:9px" :disabled="isDeployed" @click="doDeploy">
        {{ isDeployed ? '✓ Deployed — find it below' : '⬢ Deploy instance' }}
      </button>
      <div v-if="deployMsg" class="status ok">{{ deployMsg }}</div>
    </div>

    <!-- FIND -->
    <div class="sec">
      <div class="sec-h"><span class="eyebrow">Deployed contracts</span><span class="hint">{{ instances.length }} on this device</span></div>
      <input class="in" v-model="search" placeholder="find by name or id…" spellcheck="false" style="margin-bottom:8px" />
      <p v-if="!filtered.length" class="hint">No contracts yet — compile one above and deploy it.</p>
      <div v-for="inst in filtered" :key="inst.id" class="inst" :class="{ on: selected && selected.id === inst.id }">
        <button class="inst-main" @click="selectInstance(inst)">
          <span class="inst-name">{{ inst.name }}</span>
          <span class="inst-id mono">{{ inst.id.slice(0, 14) }}…</span>
          <span class="inst-when">{{ ago(inst.deployedAt) }}</span>
        </button>
        <button class="btn danger sm" title="remove from this device" @click="removeInstance(inst.id)">×</button>
      </div>
    </div>

    <!-- CALL -->
    <div v-if="selected" class="sec">
      <div class="sec-h"><span class="eyebrow">Call</span><span class="hint mono">{{ selected.name }}</span></div>
      <div v-if="selErr" class="status bad">{{ selErr }}</div>
      <template v-else-if="selBuilt">
        <div class="field">
          <label for="c-ep">Entrypoint</label>
          <select id="c-ep" class="sel" v-model="callEp" @change="onEpChange">
            <option v-for="ep in selBuilt.params" :key="ep.name" :value="ep.name">{{ ep.name }}({{ ep.params.map(p => p.name).join(', ') }})</option>
          </select>
        </div>
        <div v-for="(p, i) in currentParams" :key="p.name" class="field">
          <label :for="'arg-' + i">{{ p.name }} <span class="mono" style="color:var(--faint)">~{{ p.type }}</span></label>
          <input :id="'arg-' + i" class="in mono" v-model="callArgs[i]" inputmode="numeric" placeholder="0" spellcheck="false" />
        </div>
        <button class="btn primary" style="width:100%" :disabled="calling" @click="runCall">{{ calling ? 'Running…' : 'Run ' + callEp + '()' }}</button>
        <div v-if="callMsg" class="status" :class="callMsgKind">{{ callMsg }}</div>

        <div class="statebar">
          <div class="eyebrow" style="margin-bottom:6px">Committed state</div>
          <p v-if="!selBuilt.fieldInfo.length" class="hint">Stateless — this contract holds no fields.</p>
          <div v-for="f in selBuilt.fieldInfo" :key="f.name" class="tile" :class="{ flash: flashed.has(f.name) }">
            <span class="tk mono">{{ f.name }}<span v-if="f.vis === 'private'" class="priv">private</span></span>
            <span class="tv mono">{{ stateVals[f.name] }}</span>
          </div>
        </div>
      </template>
    </div>

    <p class="note">Contracts run in-page via WebAssembly over a local key/value store standing in for the Verkle tree — the REAL compiled bytecode, but NOT the production path (no worker isolation, CPU metering, Verkle commitment, or delegation gate; those are the headless node reproductions). Deploying to live mainnet needs an xmbl node endpoint, gated behind the external protocol audit; the id above is byte-identical to the one a node derives.</p>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import browser from 'webextension-polyfill'
import { SAMPLES } from '../contract-samples.js'
import { buildContract, contractIdOf, contractCoordinatesOf, makeStore, callEntry, readField } from '../contract-runtime.js'

const STORE_KEY = 'xmbl:contracts'

const sample = ref('')
const src = ref(SAMPLES.Counter.src)
const built = ref(null)
const buildErr = ref('')
const compiling = ref(false)
const id = ref('')
const coords = ref({ cubeAddress: '' })
const deployMsg = ref('')

const instances = ref([])
const search = ref('')

const selected = ref(null)
const selBuilt = ref(null)
const selErr = ref('')
const callEp = ref('')
const callArgs = ref([])
const calling = ref(false)
const callMsg = ref('')
const callMsgKind = ref('info')
const stateVals = ref({})
const flashed = ref(new Set())

const isDeployed = computed(() => built.value && instances.value.some((x) => x.id === id.value))
const filtered = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return instances.value
  return instances.value.filter((x) => x.name.toLowerCase().includes(q) || x.id.toLowerCase().includes(q))
})
const currentParams = computed(() => {
  if (!selBuilt.value) return []
  const ep = selBuilt.value.params.find((e) => e.name === callEp.value)
  return ep ? ep.params : []
})

function onEdit () { built.value = null; buildErr.value = ''; deployMsg.value = '' }
function pickSample () { if (sample.value && SAMPLES[sample.value]) { src.value = SAMPLES[sample.value].src; onEdit() } }

async function doCompile () {
  compiling.value = true; buildErr.value = ''; deployMsg.value = ''
  try {
    const b = await buildContract(src.value)
    built.value = b
    id.value = contractIdOf(b.wasm)
    coords.value = contractCoordinatesOf(id.value)
  } catch (e) { built.value = null; buildErr.value = 'Compile error: ' + (e.message || e) }
  finally { compiling.value = false }
}

async function readRegistry () {
  const all = await browser.storage.local.get(STORE_KEY)
  return (all && all[STORE_KEY]) || {}
}
async function writeRegistry (reg) { await browser.storage.local.set({ [STORE_KEY]: reg }) }

async function loadInstances () {
  const reg = await readRegistry()
  instances.value = Object.values(reg).sort((a, b) => (b.deployedAt || '').localeCompare(a.deployedAt || ''))
}

async function doDeploy () {
  if (!built.value) return
  const reg = await readRegistry()
  reg[id.value] = { id: id.value, name: built.value.name, src: src.value, cube: coords.value.cubeAddress, coords: coords.value.coordinates, kv: [], deployedAt: new Date().toISOString() }
  await writeRegistry(reg)
  await loadInstances()
  deployMsg.value = 'Deployed ' + id.value.slice(0, 16) + '… — a genesis instance is stored on this device.'
  await selectInstance(reg[id.value])
}

async function removeInstance (rid) {
  const reg = await readRegistry()
  delete reg[rid]
  await writeRegistry(reg)
  if (selected.value && selected.value.id === rid) { selected.value = null; selBuilt.value = null }
  await loadInstances()
}

async function selectInstance (inst) {
  selected.value = inst; selErr.value = ''; selBuilt.value = null; callMsg.value = ''
  try {
    const b = await buildContract(inst.src)
    selBuilt.value = b
    callEp.value = b.params[0] ? b.params[0].name : ''
    onEpChange()
    refreshState()
  } catch (e) { selErr.value = 'This instance failed to recompile: ' + (e.message || e) }
}

function onEpChange () { callArgs.value = currentParams.value.map(() => '') }

function refreshState () {
  if (!selBuilt.value || !selected.value) return
  const store = new Map(selected.value.kv || [])
  const vals = {}
  for (const f of selBuilt.value.fieldInfo) vals[f.name] = readField(store, f.name).toString()
  stateVals.value = vals
}

async function runCall () {
  if (!selBuilt.value || !selected.value) return
  calling.value = true; callMsg.value = ''
  try {
    const b = await buildContract(selected.value.src) // recompile from source: wasm always matches
    const store = new Map(selected.value.kv || [])
    const argv = currentParams.value.map((_, i) => (callArgs.value[i] || '0').trim() || '0')
    const out = {}
    const before = {}
    for (const f of b.fieldInfo) before[f.name] = readField(store, f.name).toString()
    const ret = await callEntry(b.wasm, store, callEp.value, argv, out)
    // persist committed state back to the registry
    selected.value.kv = [...store.entries()]
    const reg = await readRegistry()
    if (reg[selected.value.id]) { reg[selected.value.id].kv = selected.value.kv; await writeRegistry(reg) }
    refreshState()
    // flash the fields whose committed value changed
    const changed = new Set()
    for (const f of b.fieldInfo) if (before[f.name] !== stateVals.value[f.name]) changed.add(f.name)
    flashed.value = changed; setTimeout(() => { flashed.value = new Set() }, 700)
    const evTxt = out.events ? ' · events ' + out.events : ''
    callMsg.value = callEp.value + '() → ' + (ret === undefined || ret === null ? '(no value)' : ret.toString()) + evTxt
    callMsgKind.value = 'ok'
  } catch (e) {
    // a trapping op (overflow / div0 / underflow) REVERTS — state is left unmoved
    callMsg.value = callEp.value + '() reverted: ' + (e.message || e)
    callMsgKind.value = 'bad'
    refreshState()
  } finally { calling.value = false }
}

function ago (iso) {
  if (!iso) return ''
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return Math.floor(s / 60) + 'm ago'
  if (s < 86400) return Math.floor(s / 3600) + 'h ago'
  return Math.floor(s / 86400) + 'd ago'
}

loadInstances()
</script>

<style scoped>
.idbox { border: 1px solid var(--rule); border-radius: var(--r-md); padding: 10px 12px; }
.idrow { display: flex; gap: 10px; align-items: baseline; }
.idrow + .idrow { margin-top: 5px; }
.idrow .k { font-family: var(--mono); font-size: .5625rem; letter-spacing: .12em; text-transform: uppercase; color: var(--faint); flex: 0 0 34px; }
.idrow .v { font-size: .6875rem; color: var(--text); word-break: break-all; }

.inst { display: flex; align-items: stretch; gap: 6px; margin-bottom: 6px; }
.inst-main {
  flex: 1; display: flex; align-items: baseline; gap: 8px; text-align: left; cursor: pointer;
  font: inherit; color: var(--text); background: var(--paper-raised); border: 1px solid var(--rule-2);
  border-radius: var(--r-sm); padding: 8px 11px; box-shadow: var(--cap-lift);
  transition: background var(--quick) var(--ease), border-color var(--quick) var(--ease);
}
.inst-main:hover { background: var(--paper); }
.inst.on .inst-main { border-color: var(--kinpaku-deep); box-shadow: var(--cap-lift), 0 0 0 3px var(--accent-soft); }
.inst-name { font-weight: 600; color: var(--ink); }
.inst-id { font-size: .6875rem; color: var(--faint); }
.inst-when { margin-left: auto; font-size: .6875rem; color: var(--faint); }

.statebar { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--rule); }
.tile { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; padding: 7px 10px; border: 1px solid var(--rule); border-radius: var(--r-sm); margin-bottom: 5px; }
.tile.flash { border-color: var(--kinpaku); box-shadow: 0 0 0 3px var(--accent-soft); }
.tk { font-size: .75rem; color: var(--muted); display: flex; align-items: center; gap: 6px; }
.priv { font-size: .5rem; letter-spacing: .1em; text-transform: uppercase; color: var(--faint); border: 1px solid var(--rule-2); border-radius: var(--r-pill); padding: 1px 6px; }
.tv { font-size: .875rem; font-weight: 600; color: var(--ink); font-variant-numeric: tabular-nums; }
</style>
