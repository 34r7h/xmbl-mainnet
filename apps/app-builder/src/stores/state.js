// stores/state.js
import { ref } from 'vue'
import { defineStore } from 'pinia'
import db from '../utils/db.js'

export const useAppState = defineStore('state', () => {
  const state = ref({})
  if (db.data.$state) {
    state.value = db.data.$state
  } else {
    // TODO: import appdata from '/defaults/app.json'
    const defaultfiles = {
      app: '/defaults/app.json',
      config: '/defaults/config.json',
      db: '/defaults/db.json'
    }
    Object.entries(defaultfiles).map(async (json) => {
      let response = await fetch(json[1])
      let responsetext = await response.text()
      // console.log(json[0], responsetext)
      state.value[json[0]] = JSON.parse(responsetext)
      // console.log(state.value)
    })

    state.value.show = {}

    state.value.scopes = { test: {} } // data will be scoped and nested for where they are rendered from.. i.e. scopes.layout1.component1

    state.value.actions = []

    state.value.accounts = {}
    state.value.$outputs = {}
  }

  return { state }
})
