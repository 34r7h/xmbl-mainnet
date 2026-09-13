<!-- A list of statements, each written as a plain-language sentence row, plus a labeled add-bar that
     picks the next statement by what it DOES (no create-then-reclassify step). Renders itself
     recursively for the `then`/`otherwise` arms of an If…else and the body of a Repeat, so arbitrarily
     nested control flow is fully editable — this is what replaces the extension's old read-only body
     preview. Ported in behaviour from the miniapp Contract Lab's stmtRow / renderStmtList /
     defaultStmt (apps/app-builder/miniapp/contract-lab.js). -->
<template>
  <div class="stmt-list">
    <div v-for="(s, i) in list" :key="i" class="stmt" :class="{ nested: s.t === 'branch' || s.t === 'loop' }">
      <select class="sel skind" :value="s.t" title="statement kind" @change="e => reclass(i, e.target.value)">
        <option v-for="t in KIND_ORDER" :key="t" :value="t">{{ KIND_LABEL[t] }}</option>
      </select>

      <!-- Set field = expr -->
      <template v-if="s.t === 'set'">
        <select class="sel" :value="s.field" @change="e => { s.field = e.target.value; emit('change') }">
          <option v-for="f in fields" :key="f.name" :value="f.name">{{ f.name }}</option>
        </select>
        <span class="word">to</span>
        <ExprEditor :expr="s.expr" :refs="refs" @change="emit('change')" />
      </template>

      <!-- Local name = expr -->
      <template v-else-if="s.t === 'local'">
        <span class="word">name</span>
        <input class="in name" :value="s.name" :size="sz(s.name)" spellcheck="false" @input="e => { s.name = e.target.value.trim(); emit('change') }" />
        <span class="word">=</span>
        <ExprEditor :expr="s.expr" :refs="refs" @change="emit('change')" />
      </template>

      <!-- Return expr -->
      <template v-else-if="s.t === 'return'">
        <span class="word">the value</span>
        <ExprEditor :expr="s.expr" :refs="refs" @change="emit('change')" />
      </template>

      <!-- Emit event with operand -->
      <template v-else-if="s.t === 'emit'">
        <select class="sel" :value="s.event" @change="e => { s.event = e.target.value; emit('change') }">
          <option v-if="!events.length" value="">(add an event first)</option>
          <option v-for="ev in events" :key="ev.name" :value="ev.name">{{ ev.name }}</option>
        </select>
        <span class="word dim">with</span>
        <OperandInput :model-value="s.args[0]" :refs="refs" @update:model-value="v => { s.args[0] = v }" @change="emit('change')" />
      </template>

      <!-- If condition … then do / otherwise -->
      <template v-else-if="s.t === 'branch'">
        <span class="word">the condition</span>
        <ExprEditor :expr="s.cond" :refs="refs" @change="emit('change')" />
        <div class="branch-cols">
          <div>
            <div class="mini">then do</div>
            <div class="block"><StmtList :list="s.then" :fields="fields" :events="events" :params="params" :refs="refs" @change="emit('change')" /></div>
          </div>
          <div>
            <div class="mini">otherwise</div>
            <div class="block"><StmtList :list="s.els" :fields="fields" :events="events" :params="params" :refs="refs" @change="emit('change')" /></div>
          </div>
        </div>
      </template>

      <!-- Repeat counter from … to … -->
      <template v-else-if="s.t === 'loop'">
        <span class="word">counter</span>
        <input class="in name" :value="s.varName" :size="sz(s.varName)" spellcheck="false" @input="e => { s.varName = e.target.value.trim(); emit('change') }" />
        <span class="word">from</span>
        <OperandInput :model-value="s.start" :refs="refs" @update:model-value="v => { s.start = v }" @change="emit('change')" />
        <span class="word">to</span>
        <OperandInput :model-value="s.end" :refs="refs" @update:model-value="v => { s.end = v }" @change="emit('change')" />
        <div class="block"><StmtList :list="s.body" :fields="fields" :events="events" :params="params" :refs="refs" @change="emit('change')" /></div>
      </template>

      <button class="x" title="remove statement" @click="remove(i)">×</button>
    </div>

    <div class="add-bar">
      <button v-for="t in KIND_ORDER" :key="t" class="add sm" @click="add(t)">{{ KIND_ADD[t] }}</button>
    </div>
  </div>
</template>

<script setup>
import OperandInput from './OperandInput.vue'
import ExprEditor from './ExprEditor.vue'
import StmtList from './StmtList.vue' // self-reference for nested branch/loop bodies

const props = defineProps({
  list: { type: Array, required: true },
  fields: { type: Array, default: () => [] },
  events: { type: Array, default: () => [] },
  params: { type: Array, default: () => [] },
  refs: { type: Array, default: () => [] }
})
const emit = defineEmits(['change'])

const KIND_LABEL = { set: 'Set field', local: 'Local value', return: 'Return', emit: 'Emit event', branch: 'If … else', loop: 'Repeat' }
const KIND_ADD = { set: '+ Set', local: '+ Local', return: '+ Return', emit: '+ Emit', branch: '+ If/else', loop: '+ Repeat' }
const KIND_ORDER = ['set', 'local', 'return', 'emit', 'branch', 'loop']

const sz = (v) => Math.max(2, Math.min(34, String(v == null ? '' : v).length + 1))

// A sensible default statement of each kind: its operands point at names already in scope (the
// first field, the method's params) so a freshly-added statement compiles rather than erroring.
function defaultStmt (t) {
  const f0 = (props.fields[0] && props.fields[0].name)
  const e0 = (props.events[0] && props.events[0].name) || ''
  const p0 = (props.params[0] && props.params[0].name)
  const p1 = (props.params[1] && props.params[1].name)
  if (t === 'set') return { t: 'set', field: f0 || 'count', expr: { a: f0 || '0', op: '+', b: '1' } }
  if (t === 'local') return { t: 'local', name: 'tmp', type: 'u256', expr: { a: '0', op: '', b: '' } }
  if (t === 'return') return { t: 'return', expr: { a: f0 || '0', op: '', b: '' } }
  if (t === 'emit') return { t: 'emit', event: e0, args: ['0'] }
  if (t === 'branch') return { t: 'branch', cond: { a: p0 || '0', op: '!<', b: p1 || '0' }, then: [{ t: 'return', expr: { a: p0 || '0', op: '', b: '' } }], els: [{ t: 'return', expr: { a: p1 || '0', op: '', b: '' } }] }
  if (t === 'loop') return { t: 'loop', varName: 'i', start: '1', end: p0 || '1', body: [] }
  return { t: 'set', field: 'count', expr: { a: '0', op: '', b: '' } }
}

function add (t) { props.list.push(defaultStmt(t)); emit('change') }
function remove (i) { props.list.splice(i, 1); emit('change') }
function reclass (i, t) { props.list.splice(i, 1, defaultStmt(t)); emit('change') }
</script>
