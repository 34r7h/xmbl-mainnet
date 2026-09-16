// @xmbl/contracts — the XMBL Contract LAYER (XCL).
//
// Binds compiled contracts to the running chain: deterministic cubic placement, the
// storage-slot ↔ Verkle-key mapping, and read-set/write-set staging. It DELEGATES the
// contract LANGUAGE to @xmbl/lng (a standalone package), sandboxed execution to
// @xmbl/storage-compute, and state to @xmbl/state-machine — it re-implements none of them.
//
// The language is NOT re-exported from here: to compile a contract, depend on @xmbl/lng
// directly. This package is the binding layer, and keeping the surfaces separate is what
// lets each be used on its own.
export * from './src/xcl/index.js';

// THE VERSION OF THE CODE THIS PROCESS LOADED. Read once at import time from this package's own manifest, so a
// running node can report what it is actually executing — an install that lands on disk after this module was
// loaded changes the file, not this constant. Consumed by @xmbl/core's control socket (`status`.versions).
import { readFileSync as __readPkg } from 'node:fs';
export const VERSION = JSON.parse(__readPkg(new URL('./package.json', import.meta.url), 'utf8')).version;
