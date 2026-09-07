// main.js
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { useAppState } from './stores/state'
import * as api from './stores/api'
import layout from './components/layout.vue'
import ui from './components/ui.vue'
import content from './components/content.vue'
import general from './components/general.vue'

const app = createApp(App)
  .component('content', content)
  .component('ui', ui)
  .component('layout', layout)
  .component('general', general)
const pinia = createPinia()
app.use(pinia)
const appState = useAppState()
app.provide('$state', appState.state)
app.provide('$api', api)

app.mount('#app')
