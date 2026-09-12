import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

// Build the XMBL Contract Lab miniapp (miniapp/contract-lab.html + contract-lab.js) into a
// single self-contained file, then miniapp/assemble-contract-lab.mjs relocates the inlined
// <head> module script into <body> as a classic, import/export-free script so handoff.js
// renderApp executes it on the feed surface. Plain DOM — no Vue — so no framework plugin; the
// only bundled dependency is @xmbl/lng (the pure-JS LNG→WASM compiler, zero node: imports).
export default defineConfig({
  root: 'miniapp',
  plugins: [viteSingleFile()],
  build: {
    outDir: fileURLToPath(new URL('./dist-contract-lab', import.meta.url)),
    emptyOutDir: true,
    cssCodeSplit: false,
    assetsInlineLimit: 100000000,
    rollupOptions: {
      input: fileURLToPath(new URL('./miniapp/contract-lab.html', import.meta.url))
    }
  }
})
