<script setup>
import { inject, ref, watch, computed } from 'vue'
const $state = inject('$state')
const $api = inject('$api')

let propsmodel = {
  // props will come in the form of pointers to data
  // props need to have:

  // style, class
  // data - direct values, options
  // value - the ui's value
  // model - a model to create forms
  // events - clicks and stuff
  // admin - admin controls
  // actions - functions available to events
  // id - property key
  // name - label and other human readables
  // type - regular inputs, textareas, buttons, state, pointer, action
  // scope - indirect values (see data prop)
  // parent - nesting <ui>

  style: String,
  xaction: String, // specifies $api method ( get, set, remove, api, utils) used with xdata for arguments
  xactions: [Array, String], // same as above but made for multiple actions. ex. [{set: {uri: xid, value: 3}},{remove: {uri:'temp' + xid}}]
  xadmin: [String, Number, Boolean],
  xclass: String, // targets classes for <label> wrapper or <button>
  xcount: Number,
  xdata: [String, Number, Object, Array, Boolean, Function], // any state data that a <ui> may use, i.e. "scopes" will send $state.scopes as the action argument
  xevents: Object,
  xid: {
    type: String,
    required: true
  },
  xif: Array,
  xlabel: [String, Number], // value for <label> or <button> text
  xmode: String,
  xmodel: [String, Object],
  xname: String,
  xoptions: Array, // [{name: 'option name', value: 'option value'}]
  xparent: String,
  xrequired: String,
  xscope: [Array, String], // used for nested state selection
  xstate: [String, Object],
  xstruct: [String, Boolean], // if true, specify input value format
  xstyle: [String, Object],
  xtype: {
    type: String
  },
  xvalue: String // used to get a value from scope, select by property 
}
const props = defineProps({
  style: String,
  xaction: String, // specifies $api method ( get, set, remove, api, utils) used with xdata for arguments
  xactions: [Array, String], // same as above but made for multiple actions. ex. [{set: {uri: xid, value: 3}},{remove: {uri:'temp' + xid}}]
  xadmin: [String, Number, Boolean],
  xclass: String, // targets classes for <label> wrapper or <button>
  xcount: Number,
  xdata: [String, Number, Object, Array, Boolean, Function], // any state data that a <ui> may use, i.e. "scopes" will send $state.scopes as the action argument
  xevents: Object,
  xid: {
    type: String,
    required: true
  },
  xif: Array,
  xlabel: [String, Number], // value for <label> or <button> text
  xmode: String,
  xmodel: [String, Object],
  xname: String,
  xoptions: Array, // [{name: 'option name', value: 'option value'}]
  xparent: String,
  xrequired: String,
  xscope: [Array, String], // used for nested state selection
  xstate: [String, Object],
  xstruct: [String, Boolean], // if true, specify input value format
  xstyle: [String, Object],
  xtype: {
    type: String
  },
  xvalue: String // used to get a value from scope, select by property 
})

let stateselect = ref()
let mode = ref(props.xmode || '')
// let prop = ref({})
let errors = ref({})
let addvalue = ref(false)
let raw = ref(false)
let hide = ref({})
let show = computed(() => {
  if (typeof props.xif == 'undefined' || props.xif.length == 0) return true
  return $api.utils({
    utype: 'validate',
    udata: {
      val: [...props.xif]
    }
  })
})

let arrkey = ref(Date.now()) // to deal with nested array reactivities when removing values

const get = (uri) => $api.get({ uri })

const remove = (uri) => {
  if (Array.isArray(uri)) {
    uri.map((x) => remove(x))
  }
  return $api.remove({ uri })
}

const typemodel = props.xmodel ? get(props.xmodel) : null

const scope = computed(() => {
  const scopestr = props.xparent ? props.xparent + '.' + props.xid : props.xid
  return scopestr.split('.').map((x) => x)
})

let value = computed(() => props.xvalue || props.xdata || get(scope.value))
if (JSON.stringify(value.value) == "$api.set({uri: '$state', provider: 'db', value: $state})") {

  console.log(value.value, props.xdata);
}
let model = ref(props.xdata || value.value || $api.get({ uri: props.xid }))

props.xdata && $api.set({ uri: scope.value, value: props.xdata })

let valuetype = computed(() => $api.utils({ utype: 'type', udata: { val: value.value } }))

const typestruct = ref(value.value ? valuetype.value : null)

function handleXStructChange(val) {
  console.log('handleXStructChange', { val, typestruct: typestruct.value })

  const coercedValue = $api.utils({
    utype: 'type',
    udata: { val, coerce: typestruct.value }
  })

  model.value && typestruct.value && $api.set({ uri: scope.value, value: coercedValue })
}

if (props.xtype == 'array') {
  watch(value, (nv, ov) => {
    arrkey.value = Date.now()
  })
}
</script>
<template>

  <label :class="props.xclass" :style="props.xstyle" :for="`${props.xid}`"
    v-if="props.xlabel && props.xtype !== 'button' && show">
    <span>{{ props.xlabel }}
      <span style="font-size: 10px; color: #999">
        <span v-if="['object', 'array'].includes(xtype)">
          [<i @click="
            (raw = !raw), $api.set({ uri: `temp.${xid}.raw`, value: JSON.stringify(value) })
            ">{{ raw ? 'structured' : 'raw' }}</i>] [<i @click="hide['meta'] = !hide['meta']">meta</i>] [<i
            @click.prevent="addvalue = !addvalue">add</i>]
        </span>

        <pre style="overflow-x: scroll" v-if="hide['meta']">
        {{
          JSON.stringify(
            {
              scope,
              xid,
              ...props,
              model,
              typestruct,
              type: valuetype
            },
            null,
            2
          )
        }}
    </pre>
      </span>
    </span>
    <span v-if="!props.xtype">
      <select v-model="mode">
        <option disabled selected>Source:</option>
        <option value="i">Input</option>
        <option value="f">F(x)</option>
        <option value="s">State</option>
        <option value="p">Pointer</option>
      </select>
    </span>
    <span v-if="mode == 's' || xmode == 's' || xtype == 'state'">
      <!-- {{ xid }} -->
      <select v-model="stateselect">
        <option v-for="(val, prop) in xstate || $state" :key="String(prop)">
          {{ prop }}
        </option>
      </select>
      <button @click="
        $api.set({
          uri: 'scopes.' + xid,
          value: '$_' + (xscope ? xscope + '.' : '') + stateselect
        })
        " v-if="stateselect" type="button">«
      </button>
      <span v-if="
        stateselect &&
        ['object', 'array'].includes(
          $api.utils({
            utype: 'type',
            udata: { val: !xstate ? $state[stateselect] : xstate[stateselect] }
          })
        )
      ">
        <ui :xscope="!xscope ? stateselect : xscope + '.' + stateselect" xtype="state"
          :xstate="!xstate ? $state[stateselect] : xstate[stateselect]" :xid="@xmbl/identity" xlabel=" ." />
      </span>

      <b v-else>
        {{ !xstate ? $state[stateselect] : xstate[stateselect] }}
      </b>

    </span>
    <span v-else-if="mode == 'c'">yap</span>
    <span v-else-if="mode == 'p'">Pointer</span>
    <span v-else-if="mode == 'f'">f(x)</span>
    <span v-else-if="mode == 'x'">UX</span>
    <span v-else-if="mode == 'm'">
      <div
        v-if="xmodel && value && get('scopes.' + xid.split('.').slice(0, -1).join('.')) && get('scopes.' + xid.split('.').slice(0, -1).join('.'))[value]">
        <div v-for="(x, xkey) in get(xmodel + '.' + get('scopes.' + xid.split('.').slice(0, -1).join('.'))[value])"
          :key="xkey">

          <ui :xtype="x" :xid="'scopes.' + xid + '.' + xkey" :xlabel="xkey" />
        </div>
      </div>
    </span>
    <span v-else>

      <div v-if="raw" style="
          display: flex;
          flex-direction: column;
          align-content: center;
          margin-left: 4px;
          padding: 4px;
          background: rgba(0, 0, 0, 0.05);
        ">

        <ui xstyle="flex: 5;" xlabel="raw input" xmode="i" xtype="textarea" :xid="`temp.${xid}.raw`" />

        <button style="flex: 1" type="button" @click="
          $api.set({ uri: scope, value: JSON.parse(get(`temp.${xid}.raw`)) }),
          remove(`temp.${xid}.raw`),
          (model = value),
          (raw = false)
          ">
          Set
        </button>
      </div>
      <span v-else>
        <input v-if="xtype == 'text' || xtype == 'string' || !xtype" :id="props.xid" type="text" v-bind="props.xevents"
          @input="$api.set({ uri: scope, value: model })" v-model="model" />
        <input :id="props.xid" :type="props.xtype" v-else-if="
          [
            'checkbox',
            'color',
            'date',
            'datetime-local',
            'email',
            'file',
            'month',
            'number',
            'password',
            'radio',
            'range',
            'search',
            'tel',
            'time',
            'url',
            'week'
          ].includes(props.xtype)
        " v-bind="props.xevents" @input="$api.set({ uri: scope, value: model })" v-model="model" />
        <select v-else-if="props.xtype === 'select'" :name="props.xname" :id="props.xid"
          @change="$api.set({ uri: scope, value: model })" v-model="model" v-bind="props.xevents">
          <option v-if="props.xlabel" disabled="true" selected="true">{{ props.xlabel }}</option>
          <option :selected="option.selected" v-for="(option, optionkey) in props.xoptions" :value="option.value"
            :key="optionkey">
            {{ option.name }}
          </option>
        </select>

        <textarea style="min-width: 98%; min-height: 100px" :style="xstyle"
          @input="$api.set({ uri: scope, value: model })" :id="props.xid"
          v-else-if="(mode == 'i' && props.xtype == 'textarea') || props.xtype === 'textarea'" v-model="model"
          v-bind="props.xevents"></textarea>
      </span>
    </span>

    <select v-model="typestruct" v-if="props.xstruct" id="" @change="handleXStructChange(model)">
      <option style="font-family: monospace" v-for="struct in props.xstruct && [
        { sym: ` ' ' `, val: 'string' },
        { sym: ' # ', val: 'number' },
        { sym: 't/f', val: 'boolean' },
        { sym: '[...]', val: 'array' },
        { sym: `{k:v}`, val: 'object' },
        { sym: `f(x)`, val: 'function' }
        // { sym: `'{}' JSON`, val: 'json' }
        // { sym: 'State', val: 'state' },
        // { sym: 'f(x) Function', val: 'Function' }
      ]" :selected="valuetype == struct.val" :value="struct.val" :key="struct.val">
        {{ struct.sym }}
      </option>
    </select>

    <span>
      <ui v-if="xparent !== 'scopes' && scope[0] !== 'temp' && xtype !== 'state'" xstyle="font-size: 8px;"
        :xid="`${xid}_removekey`" xtype="button" xlabel="remove" :xactions="[
          {
            remove: {
              uri: xid,
              type: xtype
            }
          }
        ]" />
    </span>
  </label>
  <div v-if="xtype == 'object' && !raw">
    <div v-if="addvalue" style="background: #ccc; padding: 2px; display: flex; margin-left: 4px; flex-wrap: wrap">
      <ui xtype="text" xlabel="property" xmode="i" :xid="`temp.${xid}.property`" />
      <ui :xtype="get(`temp.${xid}.newval`) && get(`temp.${xid}.newval`).length > 20 ? 'textarea' : 'text'
        " xstruct="true" xlabel="value" xmode="i" :xid="`temp.${xid}.newval`" />
      <button type="button" @click="
        $api.set({
          uri: [...scope, get(`temp.${xid}.property`)],
          value: get(`temp.${xid}.newval`)
        }),
        (model = value),
        remove([`temp.${xid}.property`, `temp.${xid}.newval`]),
        handleXStructChange(model),
        (addvalue = false)
        ">
        Set
        <!-- {{ $api.get({ uri: [...scope, 'temp', 'newval'] }) }} -->
      </button>
    </div>
    <div v-for="(val, k) in value" :key="k" style="
        margin-left: 4px;
        background: rgba(0, 0, 0, 0.05);
        padding: 2px;
        border: 1px solid rgba(0, 0, 0, 0.01);
      ">
      <ui :xtype="$api.utils({
        utype: 'type',
        udata: { val }
      })
        " :xid="xparent ? `${xparent}.${xid}.${k}` : `${xid}.${k}`" :xlabel="k" xstruct="true" />
    </div>
  </div>
  <div v-else-if="xtype == 'array' && !raw">
    <div v-if="addvalue" style="background: #ccc; padding: 2px; display: flex; flex-wrap: wrap; margin-left: 4px">
      <ui :xtype="get(`temp.${xid}`) && get(`temp.${xid}`).length > 20 ? 'textarea' : 'text'" xstruct="true"
        xlabel="Add value" xmode="i" :xid="`temp.${xid}`" />
      <button type="button" @click="
        $api.set({
          uri: [...scope, value ? value.length : model ? model.length : 0],
          value: get(`temp.${xid}`)
        }),
        (model = value),
        $api.remove({ uri: `temp.${xid}` }),
        handleXStructChange(model),
        (addvalue = false)
        ">
        Set
        <!-- {{ $api.get({ uri: [...scope, 'temp', 'newval'] }) }} -->
      </button>
    </div>

    <div v-for="(val, i) in value" :key="i + arrkey" style="
        margin-left: 4px;
        background: rgba(0, 0, 0, 0.05);
        padding: 2px;
        border: 1px solid rgba(0, 0, 0, 0.01);
      ">
      <ui :key="i" v-if="get(xparent ? `${xparent}.${xid}.${i}` : `${xid}.${i}`) == val" :xtype="$api.utils({
        utype: 'type',
        udata: { val }
      })
        " :xid="xparent ? `${xparent}.${xid}.${i}` : `${xid}.${i}`" :xlabel="String(i)" xstruct="true" />
    </div>
  </div>
  <!-- BUTTON AREA
  - we're going to 5d the button with motion and pressure in x,y,z, t (time), v (vector) planes. shits gunna popoff
  - xactions[{},{}] is untested on db but g2g for dev 
  - xaction may be used with xdata for arguments, else it will expect the parent scope to provide required args -->
  <!-- {{ xactions }} -->
  <button draggable="true" v-bind="xevents" :class="xclass" :style="xstyle" @click.prevent=" 
    xactions
      ?
      $api.api({ actions: typeof xactions == 'object' ? xactions : $state.db.data[xactions].data.commands, scope: scope.slice(0, -1), xid })
      : $api[xaction](xdata || { scope: scope.slice(0, -1), xid, $value: JSON.parse(JSON.stringify(get(scope.slice(0, -1)))) })
    " v-if="xtype === 'button' && show">

    {{ xlabel }}
  </button>
  <span style="position: relative">
    <button type="button" style="font-size: 5px; position: absolute; bottom: 0; right: 0; width: max-content"
      v-if="xadmin">
      SAVE UI
    </button>
  </span>
  <div v-if="Object.entries(errors).length > 0 && show">list errors</div>
</template>
