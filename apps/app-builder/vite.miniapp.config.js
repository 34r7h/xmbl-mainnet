import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { viteSingleFile } from 'vite-plugin-singlefile'

// Smallest bundle (ESM tree-shakes Vue best). We then relocate the inlined script
// from <head> into <body> (miniapp/assemble.mjs) so handoff.js renderApp executes
// it on the feed surface. The entry chunk is side-effecting with no top-level
// import/export, so it runs correctly inside renderApp's function-body wrapper.
export default defineConfig({
  root: 'miniapp',
  plugins: [vue(), viteSingleFile()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      lodash: fileURLToPath(new URL('./miniapp/shims/lodash.js', import.meta.url)),
      'isomorphic-dompurify': fileURLToPath(
        new URL('./miniapp/shims/dompurify.js', import.meta.url)
      ),
      marked: fileURLToPath(new URL('./miniapp/shims/marked.js', import.meta.url))
    }
  },
  build: {
    outDir: fileURLToPath(new URL('./dist-miniapp', import.meta.url)),
    emptyOutDir: true,
    cssCodeSplit: false,
    assetsInlineLimit: 100000000
  }
})
