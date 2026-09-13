<!-- A single operand box (a number literal OR a name in scope), with its OWN datalist of the names
     available here (fields + params + locals + loop counters). The datalist is load-bearing: it is
     why the builder reads as prose a user recognises instead of a box they must recall a name into.
     Ported verbatim in behaviour from the miniapp Contract Lab's `operandInput`
     (apps/app-builder/miniapp/contract-lab.js). -->
<template>
  <span class="expr">
    <input class="in operand" :list="dlId" :value="modelValue == null ? '' : String(modelValue)"
           :size="sz" placeholder="value" spellcheck="false" @input="onInput" />
    <datalist :id="dlId"><option v-for="r in refs" :key="r" :value="r"></option></datalist>
  </span>
</template>

<script setup>
import { computed } from 'vue'
import { nextOperandId } from './builder-seq.js'
const props = defineProps({ modelValue: { type: [String, Number], default: '' }, refs: { type: Array, default: () => [] } })
const emit = defineEmits(['update:modelValue', 'change'])
const dlId = 'op-refs-' + nextOperandId()
const sz = computed(() => Math.max(2, Math.min(34, String(props.modelValue == null ? '' : props.modelValue).length + 1)))
function onInput (e) { const v = e.target.value.trim(); emit('update:modelValue', v); emit('change') }
</script>
