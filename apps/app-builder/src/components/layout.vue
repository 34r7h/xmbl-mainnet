<script async setup>
import { ref, inject, resolveComponent, computed } from 'vue'
// import content from './content.vue'
// import ui from './ui.vue'
const $state = inject('$state')
const $api = inject('$api')

// console.log('<layout>', { $state, $api })
const props = defineProps({
  lovemy: String,
  xadmin: [Boolean, Number, String],
  xparent: {
    type: String,
    required: false
  },
  xclass: String,
  xevents: Object,
  xid: String,
  xif: Array,
  xstyle: String,
  xtype: String, // form, div
  xname: String,
  xdisplay: { type: Object, required: true }
})

const scope = ref(String(props.xparent ? props.xparent + '.' + props.xid : props.xid))
// const fetchComponent = (type) => import(`./components/${type}.vue`)
const micro = ref($api.utils({ utype: 'hash', udata: { content: props.xdisplay, type: '2' } }))
let token = ref('')
const getMicroValue = async () =>
  await micro.value.then((data) => {
    token.value = data[1]
  })
getMicroValue()
// console.log({
//   scope,
//   token
// })
let show = computed(() => {
  if (typeof props.xif == 'undefined' || props.xif.length == 0) return true
  return $api.utils({
    utype: 'validate',
    udata: {
      val: [...props.xif]
    }
  })
})
</script>

<template>
  <article v-if="token && show" :id="token" :style="xdisplay.style" style="
      position: relative;
      width: 100%;
      height: 100%;
      overflow: scroll;
      overflow-wrap: anywhere;
      word-break: break-word;
    ">
    <component v-for="(area, areakey) in props.xdisplay.display" :is="area.type || 'div'" :id="`${token}.${areakey}`"
      :key="areakey" :style="area.style" :class="area.class" v-bind="{
        xid: `${token}.${areakey}`,
        name: `${token}.${areakey}.${area.type}`
      }">
      <slot>
        <component v-for="(com, comkey) in area.components" :key="comkey" :is="resolveComponent(com.type)" v-bind="{
          ...com.props,
          xid: `${token}.${areakey}.${com.props.xid}`,
          xparent: scope
        }" />
      </slot>
    </component>
  </article>
  <div style="position: relative">
    <button type="button" style="font-size: 5px; position: absolute; bottom: 0; right: 0" v-if="xadmin">
      SAVE LAYOUT
    </button>
  </div>
</template>
