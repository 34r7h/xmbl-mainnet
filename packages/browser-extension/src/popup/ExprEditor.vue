<!-- An expression `{ a, op, b }`, rendered as operand · operator · operand. The operator select
     carries plain-language labels ('≥  at least', '+  plus') so the whole row reads as a sentence,
     not as LNG tokens; the second operand is hidden when the operator is "on its own". Ported from
     the miniapp Contract Lab's `exprEditor` (apps/app-builder/miniapp/contract-lab.js). -->
<template>
  <span class="expr">
    <OperandInput :model-value="expr.a" :refs="refs" @update:model-value="v => { expr.a = v }" @change="emit('change')" />
    <select class="sel op" :value="expr.op" @change="onOp">
      <option v-for="o in OPS" :key="o" :value="o">{{ OP_LABEL[o] }}</option>
    </select>
    <OperandInput v-if="expr.op" :model-value="expr.b" :refs="refs" @update:model-value="v => { expr.b = v }" @change="emit('change')" />
  </span>
</template>

<script setup>
import OperandInput from './OperandInput.vue'
const props = defineProps({ expr: { type: Object, required: true }, refs: { type: Array, default: () => [] } })
const emit = defineEmits(['change'])

const OPS = ['', '+', '-', '*', '/', '%', 'b&', 'b|', 'b^', 'b<', 'b>', '==', '!==', '!<', '!>']
const OP_LABEL = { '': 'on its own', '+': '+  plus', '-': '−  minus', '*': '×  times', '/': '÷  divided by', '%': '%  modulo', 'b&': '&  bit-and', 'b|': '|  bit-or', 'b^': '^  bit-xor', 'b<': '«  shift left', 'b>': '»  shift right', '==': '=  equals', '!==': '≠  not equal', '!<': '≥  at least', '!>': '≤  at most' }

// normalise the shape so a freshly-added expr renders (miniapp sets these defaults on render)
if (props.expr.a == null) props.expr.a = '0'
if (props.expr.op == null) props.expr.op = ''
if (props.expr.b == null) props.expr.b = ''

function onOp (e) {
  props.expr.op = e.target.value
  if (props.expr.op && (props.expr.b == null || props.expr.b === '')) props.expr.b = '0'
  emit('change')
}
</script>
