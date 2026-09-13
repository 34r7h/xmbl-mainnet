<template>
  <div>
    <!-- CREATE — code editor and a visual builder are two editors over ONE LNG source -->
    <div class="sec">
      <div class="sec-h"><span class="eyebrow">Create</span><span class="hint">write LNG, build it visually, or start from an example</span></div>
      <div class="row wrap" style="margin-bottom:8px">
        <div class="seg" role="tablist" aria-label="editor mode">
          <button class="seg-b" :class="{ on: mode === 'code' }" @click="setMode('code')">Code</button>
          <button class="seg-b" :class="{ on: mode === 'visual' }" @click="setMode('visual')">Visual</button>
        </div>
        <select class="sel" style="width:auto;flex:0 0 auto" v-model="sample" @change="pickSample">
          <option value="">example…</option>
          <option v-for="(s, k) in SAMPLES" :key="k" :value="k">{{ s.title }}</option>
        </select>
        <button class="btn primary sm" :disabled="compiling" @click="doCompile">{{ compiling ? 'Compiling…' : 'Compile →' }}</button>
      </div>

      <!-- CODE MODE -->
      <textarea v-show="mode === 'code'" class="code" v-model="src" spellcheck="false" @input="onEdit"></textarea>

      <!-- VISUAL MODE — the full sentence-style structural builder, one editor over the LNG source -->
      <div v-if="mode === 'visual'" class="builder">
        <div class="b-err" v-if="modelErr">{{ modelErr }} — switch to Code to edit this source.</div>
        <template v-else>
          <!-- contract name -->
          <div class="vb-row name-row">
            <span class="lead">Contract</span>
            <input class="in cname" :value="model.name" :size="sz(model.name)" spellcheck="false"
                   @input="e => { model.name = e.target.value.trim() || 'Contract'; syncFromModel() }" />
          </div>

          <!-- stored state -->
          <div class="vb-sec">
            <div class="vb-sec-h">
              <span class="lbl">Stored state</span>
              <span class="hint">values the contract remembers between calls</span>
              <button class="add" @click="addField">+ field</button>
            </div>
            <div v-for="(f, i) in model.fields" :key="'f' + i" class="vb-row">
              <input class="in name" :value="f.name" :size="sz(f.name)" spellcheck="false"
                     @input="e => { f.name = e.target.value.trim(); syncFromModel() }" />
              <span class="word dim">starts at</span>
              <input class="in num" :value="f.init" :size="sz(f.init)" spellcheck="false"
                     @input="e => { f.init = e.target.value.trim(); syncFromModel() }" />
              <select class="sel vis" :value="f.vis" @change="e => { f.vis = e.target.value; syncFromModel() }">
                <option value="public">public</option><option value="private">private</option>
              </select>
              <button class="x" title="remove field" @click="del(model.fields, i)">×</button>
            </div>
            <p v-if="!model.fields.length" class="hint">No stored state — this contract is stateless.</p>
          </div>

          <!-- events -->
          <div class="vb-sec">
            <div class="vb-sec-h">
              <span class="lbl">Events</span>
              <span class="hint">signals a call can emit to observers</span>
              <button class="add" @click="addEvent">+ event</button>
            </div>
            <div v-for="(ev, i) in model.events" :key="'e' + i" class="vb-row">
              <input class="in name" :value="ev.name" :size="sz(ev.name)" spellcheck="false"
                     @input="e => { ev.name = e.target.value.trim(); syncFromModel() }" />
              <span class="word dim">carries</span>
              <input class="in name" :value="(ev.params[0] && ev.params[0].name) || 'x'" :size="sz((ev.params[0] && ev.params[0].name) || 'x')" spellcheck="false"
                     @input="e => { ev.params = [{ name: e.target.value.trim() || 'x', type: 'u256' }]; syncFromModel() }" />
              <button class="x" title="remove event" @click="del(model.events, i)">×</button>
            </div>
            <p v-if="!model.events.length" class="hint">No events.</p>
          </div>

          <!-- calls -->
          <div class="vb-sec">
            <div class="vb-sec-h">
              <span class="lbl">Calls</span>
              <span class="hint">the functions others invoke — each runs its steps in order</span>
              <button class="add" @click="addMethod">+ call</button>
            </div>
            <div v-for="(m, mi) in model.methods" :key="'m' + mi" class="method">
              <div class="method-h">
                <input class="in name fn" :value="m.name" :size="sz(m.name)" spellcheck="false"
                       @input="e => { m.name = e.target.value.trim(); syncFromModel() }" />
                <span class="word">(</span>
                <span class="params">
                  <span v-for="(p, pi) in m.params" :key="'p' + pi" class="param">
                    <input class="in name sm" :value="p.name" :size="sz(p.name)" spellcheck="false"
                           @input="e => { p.name = e.target.value.trim(); syncFromModel() }" />
                    <button class="x" title="remove input" @click="removeParam(m, pi)">×</button>
                  </span>
                  <button class="add sm" @click="addParam(m)">+ input</button>
                </span>
                <span class="word">)</span>
                <button class="x" title="remove call" @click="del(model.methods, mi)">×</button>
              </div>
              <div v-if="m.advanced" class="advanced">
                <span class="badge">advanced body</span><code>{{ m.raw }}</code><span class="mini">edit this call in Code mode</span>
              </div>
              <div v-else class="block">
                <StmtList :list="m.stmts" :fields="model.fields" :events="model.events" :params="m.params" :refs="refsFor(m)" @change="syncFromModel" />
              </div>
            </div>
            <p v-if="!model.methods.length" class="hint">No calls yet — add one.</p>
          </div>

          <p class="note">{{ DTYPE_NOTE }}</p>

          <!-- live generated-source preview — what the builder is writing, updated as you edit -->
          <div class="src-preview">
            <div class="sub-h">Generated LNG — updates as you build</div>
            <pre>{{ src }}</pre>
          </div>
        </template>
      </div>

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
      <div v-if="!instances.length" class="empty">
        <p class="hint" style="margin:0">No contracts yet — compile one above and deploy it, or load the example set.</p>
        <button class="btn ghost sm" :disabled="seeding" @click="loadExamples">{{ seeding ? 'Loading…' : '⬢ Load examples' }}</button>
      </div>
      <p v-else-if="!filtered.length" class="hint">No match for “{{ search }}”.</p>
      <div v-for="inst in filtered" :key="inst.id" class="inst" :class="{ on: selected && selected.id === inst.id }">
        <button class="inst-main" @click="selectInstance(inst)">
          <span class="inst-name">{{ inst.name }}</span>
          <span class="inst-id mono">{{ inst.id.slice(0, 14) }}…</span>
          <span class="inst-when">{{ ago(inst.deployedAt) }}</span>
        </button>
        <button class="btn danger sm" title="remove from this device" @click="removeInstance(inst.id)">×</button>
      </div>
    </div>

    <!-- CALL / TEST — inline signatures, every entrypoint at once, committed state + a run trace -->
    <div v-if="selected" class="sec">
      <div class="sec-h"><span class="eyebrow">Call &amp; test</span><span class="hint mono">{{ selected.name }}</span></div>
      <div v-if="selErr" class="status bad">{{ selErr }}</div>
      <template v-else-if="selBuilt">
        <div class="statebar">
          <div class="eyebrow" style="margin-bottom:6px">Committed state</div>
          <p v-if="!selBuilt.fieldInfo.length" class="hint">Stateless — this contract holds no fields.</p>
          <div v-else class="state-grid">
            <div v-for="f in selBuilt.fieldInfo" :key="f.name" class="tile" :class="{ flash: flashed.has(f.name), priv: f.vis === 'private' }">
              <div class="tile-k">{{ f.name }}<span v-if="f.vis === 'private'" class="badge">private</span></div>
              <div class="tile-v">{{ stateVals[f.name] }}</div>
            </div>
          </div>
        </div>

        <div class="calls">
          <div v-for="ep in selBuilt.params" :key="ep.name" class="call-row">
            <div class="call-sig">
              <span class="ep">{{ ep.name }}</span><span class="paren">(</span>
              <template v-for="(p, idx) in ep.params" :key="p.name">
                <span v-if="idx" class="paren">,&nbsp;</span>
                <input class="arg" :value="argOf(ep.name, idx)" :placeholder="p.name" inputmode="numeric" spellcheck="false"
                       @input="e => setArg(ep.name, idx, e.target.value)" />
              </template>
              <span class="paren">)</span>
            </div>
            <button class="btn sm" :disabled="calling" @click="runCall(ep)">Run</button>
          </div>
        </div>

        <div v-if="trace.length" class="trace">
          <div v-for="(l, i) in trace" :key="i" class="tline" :class="l.cls">{{ l.text }}</div>
        </div>
      </template>
    </div>

    <p class="note">Contracts run in-page via WebAssembly over a local key/value store standing in for the Verkle tree — the REAL compiled bytecode, but NOT the production path (no worker isolation, CPU metering, Verkle commitment, or delegation gate; those are the headless node reproductions). The cube/HE/zk/seal host capabilities a deployed contract can opt into are in the Crypto tab. Deploying to live mainnet needs an xmbl node endpoint, gated behind the external protocol audit; the id above is byte-identical to the one a node derives.</p>
  </div>
</template>

<script setup>
import { ref, reactive, computed } from 'vue'
import browser from 'webextension-polyfill'
import { SAMPLES } from '../contract-samples.js'
import { buildContract, contractIdOf, contractCoordinatesOf, callEntry, readField } from '../contract-runtime.js'
import { parseToModel, modelToSource } from '../contract-builder.js'
import StmtList from './StmtList.vue'

const STORE_KEY = 'xmbl:contracts'
const SEED_KEY = 'xmbl:seeded'
const DTYPE_NOTE = 'Every field and parameter is a u256 (unsigned 256-bit integer) — the type test mode runs. LNG also has boolean, address, bytes, decimal and string; reach for those in Code mode.'

const mode = ref('code')
const sample = ref('')
const src = ref(SAMPLES.Counter.src)
const model = reactive({ name: 'Counter', fields: [], events: [], methods: [] })
const modelErr = ref('')
const built = ref(null)
const buildErr = ref('')
const compiling = ref(false)
const id = ref('')
const coords = ref({ cubeAddress: '' })
const deployMsg = ref('')

const instances = ref([])
const search = ref('')
const seeding = ref(false)

const selected = ref(null)
const selBuilt = ref(null)
const selErr = ref('')
const calling = ref(false)
const argvals = reactive({})       // entrypoint name -> [arg strings]
const trace = ref([])              // run log: [{ text, cls }]
const stateVals = ref({})
const flashed = ref(new Set())

const isDeployed = computed(() => built.value && instances.value.some((x) => x.id === id.value))
const filtered = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return instances.value
  return instances.value.filter((x) => x.name.toLowerCase().includes(q) || x.id.toLowerCase().includes(q))
})

// content-sizing for the borderless prose inputs (the JS fallback where `field-sizing` is absent;
// the binding is harmless where the CSS honors it)
const sz = (v) => Math.max(2, Math.min(34, String(v == null ? '' : v).length + 1))

// every name in scope inside a method: its contract's fields, the method's params, and any locals /
// loop counters it declares — threaded into each operand box as live datalist suggestions.
function refsFor (m) {
  const r = (model.fields || []).map((f) => f.name).concat((m.params || []).map((p) => p.name))
  for (const s of (m.stmts || [])) { if (s.t === 'local') r.push(s.name); if (s.t === 'loop') r.push(s.varName) }
  return r.filter((x, i) => x && r.indexOf(x) === i)
}

function onEdit () { built.value = null; buildErr.value = ''; deployMsg.value = '' }
function pickSample () { if (sample.value && SAMPLES[sample.value]) { src.value = SAMPLES[sample.value].src; onEdit(); if (mode.value === 'visual') enterVisual() } }

// ── editor mode: code ⇄ visual, both over the one `src` ──
function setMode (m) {
  if (m === mode.value) return
  if (m === 'visual') { if (!enterVisual()) return }
  mode.value = m
}
function enterVisual () {
  try {
    const parsed = parseToModel(src.value)
    model.name = parsed.name; model.fields = parsed.fields; model.events = parsed.events; model.methods = parsed.methods
    modelErr.value = ''
    return true
  } catch (e) { modelErr.value = 'Cannot build visually: ' + (e.message || e); model.fields = []; model.events = []; model.methods = []; mode.value = 'visual'; return true }
}
function syncFromModel () { try { src.value = modelToSource(model); onEdit() } catch { /* keep last good source */ } }

function addField () { model.fields.push({ name: 'field' + (model.fields.length + 1), type: 'u256', vis: 'public', init: '0' }); syncFromModel() }
function addEvent () { model.events.push({ name: 'Event' + (model.events.length + 1), params: [{ name: 'x', type: 'u256' }] }); syncFromModel() }
function addMethod () { model.methods.push({ name: 'method' + (model.methods.length + 1), params: [], stmts: [{ t: 'return', expr: { a: '0', op: '', b: '' } }] }); syncFromModel() }
function addParam (m) { m.params.push({ name: 'a' + (m.params.length + 1), type: 'u256' }); syncFromModel() }
function removeParam (m, i) { m.params.splice(i, 1); syncFromModel() }
function del (arr, i) { arr.splice(i, 1); syncFromModel() }

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

// Compile + deploy the full sample set into the registry so the Find list is populated and search
// has something to search. Shared by the first-open auto-seed and the explicit "Load examples".
async function seedSamples () {
  const reg = await readRegistry()
  for (const key of Object.keys(SAMPLES)) {
    try {
      const b = await buildContract(SAMPLES[key].src)
      const cid = contractIdOf(b.wasm)
      const c = contractCoordinatesOf(cid)
      reg[cid] = { id: cid, name: b.name, src: SAMPLES[key].src, cube: c.cubeAddress, coords: c.coordinates, kv: [], deployedAt: new Date().toISOString() }
    } catch { /* a sample that fails to compile is simply skipped */ }
  }
  await writeRegistry(reg)
}

// First open on a fresh profile: auto-seed once. Guarded by a flag so removing the seeds is not
// silently undone — the empty-state "Load examples" button restores them on demand.
async function seedIfEmpty () {
  let seeded = false
  try { const f = await browser.storage.local.get(SEED_KEY); seeded = !!(f && f[SEED_KEY]) } catch { /* storage may be blocked */ }
  const reg = await readRegistry()
  if (seeded || Object.keys(reg).length) return
  await seedSamples()
  try { await browser.storage.local.set({ [SEED_KEY]: true }) } catch { /* ignore */ }
}

async function loadExamples () {
  seeding.value = true
  try { await seedSamples(); await loadInstances() } finally { seeding.value = false }
}

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

// ── CALL / TEST ──
function logLine (text, cls) { trace.value = [{ text, cls: cls || '' }, ...trace.value].slice(0, 40) }
const argOf = (ep, idx) => (argvals[ep] && argvals[ep][idx] != null) ? argvals[ep][idx] : ''
function setArg (ep, idx, v) { if (!argvals[ep]) argvals[ep] = []; argvals[ep][idx] = v }

async function selectInstance (inst) {
  selected.value = inst; selErr.value = ''; selBuilt.value = null; trace.value = []
  for (const k of Object.keys(argvals)) delete argvals[k]
  try {
    const b = await buildContract(inst.src)
    selBuilt.value = b
    refreshState()
  } catch (e) { selErr.value = 'This instance failed to recompile: ' + (e.message || e) }
}

function refreshState () {
  if (!selBuilt.value || !selected.value) return
  const store = new Map(selected.value.kv || [])
  const vals = {}
  for (const f of selBuilt.value.fieldInfo) vals[f.name] = readField(store, f.name).toString()
  stateVals.value = vals
}

async function runCall (ep) {
  if (!selBuilt.value || !selected.value) return
  calling.value = true
  try {
    // recompile from source so the wasm always matches the committed instance
    const b = await buildContract(selected.value.src)
    const store = new Map(selected.value.kv || [])
    const before = {}
    for (const f of b.fieldInfo) before[f.name] = readField(store, f.name).toString()
    // args are non-negative integers (the u256 the test path runs), validated like the miniapp
    const argv = []
    for (let idx = 0; idx < ep.params.length; idx++) {
      const t = (argOf(ep.name, idx) || '').trim()
      if (!/^\d+$/.test(t)) { logLine('✗ arg “' + ep.params[idx].name + '” must be a non-negative integer', 'bad'); calling.value = false; return }
      argv.push(t)
    }
    const out = {}
    const ret = await callEntry(b.wasm, store, ep.name, argv, out)
    // persist committed state back to the registry
    selected.value.kv = [...store.entries()]
    const reg = await readRegistry()
    if (reg[selected.value.id]) { reg[selected.value.id].kv = selected.value.kv; await writeRegistry(reg) }
    refreshState()
    // flash the fields whose committed value changed
    const changed = new Set()
    for (const f of b.fieldInfo) if (before[f.name] !== stateVals.value[f.name]) changed.add(f.name)
    flashed.value = changed; setTimeout(() => { flashed.value = new Set() }, 700)
    const parts = ['✓ ' + ep.name + '(' + argv.join(', ') + ')']
    if (ret !== undefined && ret !== null) parts.push('→ ' + ret.toString())
    const wrote = out.touched ? out.touched.size : 0
    if (wrote) parts.push('· wrote ' + wrote + ' field' + (wrote > 1 ? 's' : ''))
    if (out.events) parts.push('· emitted ' + out.events + ' event' + (out.events > 1 ? 's' : ''))
    logLine(parts.join(' '), 'ok')
  } catch (e) {
    // a trapping op (overflow / div0 / underflow) REVERTS — committed state is left unmoved
    logLine('✗ ' + ep.name + ' reverted: ' + (e && e.message ? e.message : String(e)), 'bad')
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

;(async () => { await seedIfEmpty(); await loadInstances() })()
</script>

<style scoped>
.idbox { border: 1px solid var(--rule); border-radius: var(--r-md); padding: 10px 12px; }
.idrow { display: flex; gap: 10px; align-items: baseline; }
.idrow + .idrow { margin-top: 5px; }
.idrow .k { font-family: var(--mono); font-size: .5625rem; letter-spacing: .12em; text-transform: uppercase; color: var(--faint); flex: 0 0 34px; }
.idrow .v { font-size: .6875rem; color: var(--text); word-break: break-all; }

/* code/visual segmented toggle */
.seg { display: inline-flex; border: 1px solid var(--rule-2); border-radius: var(--r-sm); overflow: hidden; box-shadow: var(--track-recess); }
.seg-b { appearance: none; border: 0; background: transparent; cursor: pointer; font: inherit; font-weight: 600; font-size: .75rem; color: var(--muted); padding: 6px 11px; }
.seg-b + .seg-b { border-left: 1px solid var(--rule-2); }
.seg-b.on { background: var(--kinpaku); color: var(--on-gold); }

/* ── VISUAL BUILDER — reads as sentences, not a grid of boxes ──────────────────────────────
   The anti-input-wall rule: inside .builder a value is told from a connective word purely by
   typeface/weight (mono ink = editable value, sans muted = fixed word); inputs are borderless and
   content-sized at rest, growing chrome only on hover/focus, i.e. exactly when you edit that one
   value. :deep() reaches the StmtList / ExprEditor / OperandInput child components rendered here. */
.builder { border: 1px solid var(--rule); border-radius: var(--r-md); padding: 13px; }
.b-err { font-size: .8125rem; color: var(--bad-ink); background: var(--bad-dim); border-radius: var(--r-sm); padding: 8px 10px; }

.builder :deep(.in), .builder :deep(.sel) {
  font: inherit; font-size: .8125rem; color: var(--ink);
  background: transparent; border: 1px solid transparent; border-radius: var(--r-sm);
  width: auto; box-sizing: border-box; height: 26px; padding: 0 5px; box-shadow: none;
  field-sizing: content; min-width: 2.5ch; max-width: 34ch;
  transition: border-color var(--quick) var(--ease), background var(--quick) var(--ease), box-shadow var(--quick) var(--ease);
}
.builder :deep(.in:hover), .builder :deep(.sel:hover) { border-color: var(--rule); background: var(--paper); }
.builder :deep(.in:focus), .builder :deep(.sel:focus) {
  outline: none; background: var(--paper); border-color: var(--kinpaku-deep);
  box-shadow: var(--track-recess), 0 0 0 3px var(--accent-soft);
}
.builder :deep(.in.name), .builder :deep(.in.num), .builder :deep(.in.operand) { font-family: var(--mono); }
.builder :deep(.in.sm) { height: 22px; }
.builder :deep(.in.cname) { font-weight: 600; font-size: 1.0625rem; color: var(--ink); min-width: 8ch; }
.builder :deep(.sel) {
  cursor: pointer; appearance: none; -webkit-appearance: none; max-width: 40ch; padding-right: 5px;
  background-repeat: no-repeat; background-position: right 6px center; background-size: 9px 6px;
}
.builder :deep(.sel:hover), .builder :deep(.sel:focus) {
  padding-right: 20px;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='9' height='6' viewBox='0 0 9 6'%3E%3Cpath d='M1 1l3.5 3.5L8 1' fill='none' stroke='%23999' stroke-width='1.4' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
}
.builder :deep(.sel.op) { font-family: var(--mono); }
.builder :deep(.sel.skind) { font-weight: 500; color: var(--patina-ink); }

/* plain-language connective words */
.builder :deep(.word) { font-size: .8125rem; color: var(--muted); white-space: nowrap; }
.builder :deep(.word.dim) { color: var(--faint); }

/* × remove button */
.builder :deep(.x) {
  appearance: none; border: 0; background: transparent; color: var(--faint); cursor: pointer;
  font-size: 1rem; line-height: 1; width: 22px; height: 22px; border-radius: var(--r-sm); flex: 0 0 auto;
  transition: color var(--quick) var(--ease), background var(--quick) var(--ease);
}
.builder :deep(.x:hover) { color: var(--bad); background: var(--bad-dim); }

/* add actions — patina ghosts, not gold */
.builder :deep(.add-bar) { display: flex; gap: 6px; flex-wrap: wrap; padding-top: 4px; }
.builder :deep(.add) {
  appearance: none; cursor: pointer; font: inherit; font-weight: 500; font-size: .75rem;
  color: var(--patina-ink); background: transparent; border: 1px solid var(--rule-2);
  border-radius: var(--r-sm); height: 26px; padding: 0 10px;
  transition: background var(--quick) var(--ease), border-color var(--quick) var(--ease), color var(--quick) var(--ease);
}
.builder :deep(.add:hover) { background: var(--paper-deep); border-color: var(--patina); color: var(--patina-ink); }
.builder :deep(.add.sm) { height: 22px; padding: 0 8px; font-size: .6875rem; }

.vb-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.name-row { align-items: baseline; gap: 10px; padding-bottom: 4px; }
.name-row .lead { font-size: .8125rem; color: var(--muted); }
.vb-sec { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--rule); display: flex; flex-direction: column; gap: 9px; }
.vb-sec-h { display: flex; align-items: baseline; gap: 9px; flex-wrap: wrap; }
.vb-sec-h > .lbl { font-family: var(--mono); font-size: .625rem; font-weight: 600; letter-spacing: .12em; text-transform: uppercase; color: var(--faint); }
.vb-sec-h > .hint { flex: 1; }
.vb-sec-h > .add { margin-left: auto; }

/* methods: a labeled block with a hairline rule + left indent — NOT a nested card */
.method { padding: 12px 0 2px; border-top: 1px solid var(--rule); }
.method:first-of-type { border-top: 0; padding-top: 2px; }
.method-h { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.method-h :deep(.in.fn) { font-family: var(--mono); font-weight: 600; }
.params { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.param { display: inline-flex; align-items: center; gap: 2px; background: var(--paper-deep); border: 1px solid var(--rule); border-radius: var(--r-pill); padding: 1px 3px 1px 8px; }
.param :deep(.in.name) { max-width: 72px; height: 20px; box-shadow: none; background: transparent; border: 0; padding: 0; }

/* statement body: a single left rule for depth, no boxes */
.block :deep(.stmt-list), :deep(.stmt-list) { display: flex; flex-direction: column; gap: 7px; }
.block { padding: 8px 0 2px 12px; margin-top: 6px; border-left: 2px solid var(--accent-dim); }
:deep(.stmt) { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; padding: 3px 0; }
:deep(.stmt.nested) { align-items: flex-start; }
:deep(.expr) { display: inline-flex; align-items: center; gap: 6px; }
/* the 480px popup is too narrow for two side-by-side arms — stack then/otherwise vertically */
:deep(.branch-cols) { display: flex; flex-direction: column; gap: 8px; width: 100%; }
:deep(.mini) { font-family: var(--mono); font-size: .5625rem; font-weight: 500; letter-spacing: .12em; text-transform: uppercase; color: var(--faint); margin-bottom: 2px; }

.advanced { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; padding: 8px 0 2px; }
.advanced code { font-family: var(--mono); font-size: .75rem; color: var(--muted); background: var(--paper-deep); border: 1px solid var(--rule); border-radius: var(--r-sm); padding: 5px 9px; }
:deep(.badge) { font-family: var(--mono); font-size: .5625rem; font-weight: 500; letter-spacing: .1em; text-transform: uppercase; color: var(--faint); background: var(--paper-deep); border: 1px solid var(--rule); border-radius: var(--r-pill); padding: 2px 8px; }

/* live generated-source preview — connects visual ⇄ code */
.src-preview { margin-top: 14px; border-top: 1px solid var(--rule); padding-top: 12px; }
.src-preview .sub-h { font-family: var(--mono); font-size: .625rem; font-weight: 600; letter-spacing: .12em; text-transform: uppercase; color: var(--faint); padding-bottom: 7px; }
.src-preview pre { margin: 0; font-family: var(--mono); font-size: .6875rem; line-height: 1.55; color: var(--inst-text); background: var(--inst-deep); border-radius: var(--r-md); padding: 12px 13px; overflow-x: auto; box-shadow: var(--track-recess); white-space: pre; }

.empty { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
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

/* ── CALL / TEST — the instrument: dark state tiles, inline call rows, a run trace ── */
.statebar { margin-top: 4px; margin-bottom: 12px; }
.state-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 8px; }
.tile {
  border: 1px solid var(--inst-rule); border-radius: var(--r-md); background: var(--inst-deep);
  padding: 10px 12px; box-shadow: inset 0 1px 0 oklch(100% 0 0 / .04);
  transition: box-shadow .45s var(--ease), border-color .45s var(--ease);
}
.tile.priv { border-style: dashed; }
.tile-k { display: flex; align-items: center; gap: 6px; font-family: var(--mono); font-size: .6875rem; letter-spacing: .04em; color: var(--inst-muted); }
.tile-k .badge { background: transparent; border-color: var(--inst-rule); color: var(--inst-muted); }
.tile-v { font-family: var(--mono); font-size: 1.25rem; font-weight: 600; color: var(--inst-text); margin-top: 4px; font-variant-numeric: tabular-nums; word-break: break-all; line-height: 1.1; }
.tile.flash { border-color: var(--kinpaku); box-shadow: 0 0 0 3px var(--accent-soft); }

.calls { display: flex; flex-direction: column; gap: 7px; }
.call-row {
  display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap;
  border: 1px solid var(--inst-rule); border-radius: var(--r-md); background: var(--inst-raised); padding: 7px 7px 7px 11px;
}
.call-sig { display: inline-flex; align-items: center; gap: 2px; flex-wrap: wrap; font-family: var(--mono); font-size: .8125rem; color: var(--inst-text); }
.ep { font-weight: 600; color: var(--patina); }
.paren { color: var(--inst-muted); }
/* the metering input — deliberately an INSTRUMENT field (dark, recessed), NOT prose */
.arg {
  font-family: var(--mono); font-size: .8125rem; width: 64px; height: 24px; color: var(--inst-text);
  background: var(--inst-deep); border: 1px solid var(--inst-rule); border-radius: var(--r-sm);
  padding: 0 8px; box-shadow: inset 0 1px 2px oklch(0% 0 0 / .4); box-sizing: border-box;
  transition: border-color var(--quick) var(--ease), box-shadow var(--quick) var(--ease);
}
.arg:focus { outline: none; border-color: var(--kinpaku); box-shadow: inset 0 1px 2px oklch(0% 0 0 / .4), 0 0 0 3px var(--accent-soft); }
.call-row .btn { color: var(--inst-text); background: var(--inst); border-color: var(--inst-rule); box-shadow: inset 0 1px 0 oklch(100% 0 0 / .12), 0 1px 2px oklch(0% 0 0 / .4); }
.call-row .btn:hover { background: var(--inst-raised); }

.trace {
  margin-top: 10px; font-family: var(--mono); font-size: .6875rem; line-height: 1.6; color: var(--inst-muted);
  background: var(--inst-deep); border: 1px solid var(--inst-rule); border-radius: var(--r-md); padding: 9px 11px; max-height: 168px; overflow-y: auto;
}
.tline { padding: 2px 0; }
.tline.ok { color: var(--patina); }
.tline.bad { color: oklch(72% .16 26); }
</style>
