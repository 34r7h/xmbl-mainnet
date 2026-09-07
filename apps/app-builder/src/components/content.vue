<script setup>
// content types: text, html, markdown, image, video, audio, table, iframe, list, embed, canvas, svg

import { isArray } from 'lodash'
import { inject, computed } from 'vue'
import { marked } from 'marked'
import purify from 'isomorphic-dompurify'

const $state = inject('$state')
const $api = inject('$api')
const props = defineProps({
  xadmin: [Boolean, Number, String],
  xbind: Object,
  xclass: String,
  xcolumns: Array,
  xdata: [String, Number, Object, Array, Boolean, Function],
  xevents: Object,
  xid: {
    type: String,
    required: true
  },
  xif: Array,
  xstyle: String,
  xname: String,
  xorder: Array,
  xparent: String,
  xpoint: String,
  xstate: Array,
  xtype: {
    type: String,
    required: true
  },
  xvalue: [String, Number, Object, Array, Boolean, Function]
})
// console.log('Component ' + props.xname, JSON.parse(JSON.stringify(props)));

let source = computed(() => {

  let scopedvalues, point
  if (props.xpoint) {
    point = $api.get({ uri: props.xpoint, provider: '@' })
    // console.log({ point });
  }
  else if (props.xstate) {
    scopedvalues = props.xstate.map(x => {
      // console.log({ scopedvalue: x.slice(0, 2) });
      if (x.slice(0, 2) == '$_') {
        // console.log({ props }, 'scopes.' + props.xid.split('.').slice(0, -1).join('.') + '.' + x.slice(2));
        const val = $api.get({ uri: 'scopes.' + props.xid.split('.').slice(0, -1).join('.') + '.' + x.slice(2) })
        // console.log({ val });
        return val
      }
      return x
    })
  }

  // console.log({ scopedvalues, point });
  // console.log('pointer', $api.get({ uri: 'db.data.' + props.xvalue }))

  return props.xpoint ? point : scopedvalues && $api.get({ uri: scopedvalues }) !== undefined
    ? $api.get({ uri: scopedvalues })
    : typeof props.xvalue == 'function'
      ? props.xvalue(props.xdata)
      : props.xvalue
})
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
  <!-- content: text, html, markdown, images, video, audio, data (tables/charts), canvas (don't taint
  it), map (both the standard geographical kind and clickable area type), object (for pdf/other
  types of files), and other components. Scopes are determined and enabled through state, which
  keeps component data and api permissions. there are many elements that can be used when building
  content such as superscript, subscript, bold, italic, strikethrough, kbd, highlight (mark),
  ins/del, etc -->

  <!-- VIDEO -->
  <video width="100%" height="100%" controls :id="props.xid" :class="props.xclass" :style="props.xstyle"
    v-if="show && props.xtype == 'video'">
    <source :src="source" />
  </video>

  <!-- AUDIO -->
  <audio :id="props.xid" :class="props.xclass" :style="props.xstyle" v-if="show && props.xtype == 'audio'" controls>
    <source :src="source" />
  </audio>

  <!-- TEXT, NUMBER, BOOL -->
  <span :id="props.xid" :class="props.xclass" :style="props.xstyle"
    v-if="show && ['text', 'number', 'bool'].includes(props.xtype)">{{ source }}</span>

  <!-- IMAGE -->
  <img :id="props.xid" :class="props.xclass" :style="props.xstyle" v-if="show && props.xtype == 'image'" :src="source"
    :alt="props.xname" />

  <!-- TABLE -->
  <table :id="props.xid" :class="props.xclass" :style="props.xstyle" v-if="show && props.xtype == 'table'">
    <!-- Table components may provide an xcolumns array with headings/order. If the prop does not exist and xvalue is an k/v object, then the keys will be used as column names. Else, xvalue should be an array and we'll simply loop. We'll also include sorting, ordering, and filtering.. perhaps. Other things: centering data in cells, allowing cells to take html/components -->
    <thead v-if="
      (props.xcolumns && props.xcolumns.length > 0) ||
      (typeof source[0] == 'object' && !isArray(source[0]))
    ">
      <tr>
        <th v-for="col in props.xcolumns || Object.keys(source[0])" :key="col">{{ col }}</th>
      </tr>
    </thead>
    <tbody v-if="isArray(source[0]) && !props.xorder">
      <tr v-for="(row, rowkey) in source" :key="props.xid + rowkey">
        <td v-for="item in row" :key="item">{{ item }}</td>
        <!-- Kinda cool that the k/v object defaults to provide only the value when iterating -->
      </tr>
    </tbody>
    <tbody v-else-if="!isArray(source[0]) && !props.xcolumns">
      <tr v-for="(row, rowkey) in source" :key="props.xid + rowkey">
        <td v-for="item in row" :key="item">{{ item }}</td>
        <!-- Kinda cool that the k/v object defaults to provide only the value when iterating -->
      </tr>
    </tbody>
    <tbody v-else-if="isArray(source[0]) && props.xorder">
      <tr v-for="(row, rowkey) in source" :key="props.xid + rowkey">
        <td v-for="index in props.xorder" :key="props.xid + rowkey + index">{{ row[index] }}</td>
        <!-- Kinda cool that the k/v object defaults to provide only the value when iterating -->
      </tr>
    </tbody>
    <tbody v-else>
      <tr v-for="(row, rowkey) in source" :key="props.xid + rowkey">
        <td v-for="key in props.xcolumns" :key="props.xid + rowkey + key">
          {{ row[key] }}
        </td>
        <!-- Kinda cool that the k/v object defaults to provide only the value when iterating -->
      </tr>
    </tbody>
  </table>

  <!-- HTML -->
  <span :id="props.xid" :class="props.xclass" :style="props.xstyle" v-if="show && props.xtype == 'html'"
    v-html="purify.sanitize(source)"></span>

  <!-- MARKDOWN -->
  <span :id="props.xid" :class="props.xclass" :style="props.xstyle" v-if="show && props.xtype == 'markdown'"
    v-html="purify.sanitize(marked.parse(source))"></span>

  <!-- IFRAME -->
  <iframe :id="props.xid" :class="props.xclass" :style="props.xstyle" v-if="show && props.xtype == 'iframe'"
    :src="source" frameborder="0"></iframe>

  <!-- EMBED (all kinds of media, with added content protection compared to alternative) -->
  <embed v-if="show && props.xtype == 'embed'" :id="props.xid" :class="props.xclass" :style="props.xstyle"
    :src="source" />

  <!-- LISTS -->
  <span :id="props.xid" :class="props.xclass" :style="props.xstyle" v-if="show && props.xtype == 'olist'">
    <ol>
      <li v-for="item in source" :key="item" v-html="purify.sanitize(item)"></li>
    </ol>
  </span>

  <span :id="props.xid" :class="props.xclass" :style="props.xstyle" v-if="show && props.xtype == 'ulist'">
    <ul>
      <li v-for="item in source" :key="item" v-html="purify.sanitize(item)"></li>
    </ul>
  </span>

  <!-- nesting components  -->
  <component v-if="show && ['content', 'layout', 'ui', 'general'].includes(xtype)" :is="xtype"
    v-bind="{ ...props.xbind, ...props.xevents }"></component>

  <div style="position: relative">
    <button type="button" style="font-size: 5px; position: absolute; bottom: 0; right: 0" v-if="xadmin">
      SAVE CONTENT
    </button>
  </div>
</template>
