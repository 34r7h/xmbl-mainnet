<script setup>
import { ref, computed, inject, watch, onMounted } from 'vue'

const $state = inject('$state')
const $api = inject('$api')

// Routing: URI Parsing
const getRouteData = () => {
  const urlstr = String(window.location)
  return {
    url: urlstr,
    hash: window.location.hash.slice(1),
    scheme: urlstr.split(':')[0],
    params: $api.utils({ utype: 'compact', udata: window.location.pathname.split('/') }),
    query:
      window.location.search
        ? Object.fromEntries(
          window.location.search
            .slice(1)
            .split('&')
            .map((x) => {
              const equalindex = x.indexOf('=')
              return [x.slice(0, equalindex), x.slice(equalindex + 1)]
            })
        )
        : null,
  }
}

// Reactive references
const pathhash = ref('')
const path = ref(getRouteData())
$api.init({})

// Route watcher
watch(
  path,
  async (newVal, oldVal) => {
    // console.log({ oldVal, newVal })
    pathhash.value = await $api.utils({ utype: 'hash', udata: { content: path.value.params.join('/') } })
  },
  { immediate: true }
)

// Update path on popstate to re-trigger computed watcher
window.addEventListener('popstate', () => {
  path.value = getRouteData()
})

// Intercept link clicks and prevent page reload on internal links (lite-router) TODO
onMounted(() => {
  document.addEventListener('click', (e) => {
    const anchor = e.target.closest('a')
    if (anchor && anchor.hasAttribute('href')) {
      const href = anchor.getAttribute('href')
      if (!/^https?:\/\//.test(href)) {
        e.preventDefault()
        window.history.pushState({}, '', href)
        // Manually trigger popstate for `path` update
        window.dispatchEvent(new PopStateEvent('popstate'))
      }
    }
  })
})
</script>

<template>
  {{ }}
  <component
    v-if="pathhash && $state.routes && $state.routes[pathhash] && $state.routes[pathhash].data.to[0] && $state.db.data[$state.routes[pathhash].data.to[0]]"
    :is="'layout'" v-bind="$state.db.data[$state.routes[pathhash].data.to[0]].data.props" />
  <component v-else-if="$state.app" :is="'layout'" v-bind="{ xid: 'scopes', xdisplay: $state.app }" />

  <pre style="font-size: 7px; text-wrap: pretty">{{ JSON.stringify($state, null, 4) }}</pre>

</template>

<style scoped></style>
