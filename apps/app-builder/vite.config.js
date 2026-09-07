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
      buffer: path.resolve(__dirname, 'node_modules', 'buffer'),
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  define: {
    global: 'window'
  }
})
