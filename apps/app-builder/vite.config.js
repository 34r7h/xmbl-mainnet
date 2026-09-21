import { fileURLToPath, URL } from 'node:url'
import { dirname } from 'path'
import path from 'path'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// https://vitejs.dev/config/
export default defineConfig({
  server: {
    port: 9625
  },
  plugins: [vue(), vueDevTools()],
  resolve: {
    alias: {
      // NO `buffer` alias here. It used to be path.resolve(__dirname, 'node_modules', 'buffer'),
      // which npm workspaces hoist to the ROOT node_modules — the app-local path does not exist,
      // so `vite build` died with ENOENT on every release and the web bundle was never produced.
      // `buffer` is a declared dependency; ordinary resolution finds it.
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  define: {
    global: 'window'
  }
})
