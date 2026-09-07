// Hardened WASM compute runtime for the XMBL storage-compute market.
//
// This runs UNTRUSTED, third-party WASM for pay. The previous implementation ran
// guest code on the host thread with a `Promise.race` "timeout" that could never
// fire — a synchronous loop in the guest wedges the event loop, so the timer never
// runs — and instantiated with no import policy or memory bound. That is unbounded
// execution on someone else's node. This version ENFORCES three properties instead
// of asserting them:
//
//   1. Wall-clock termination. The guest runs on a dedicated Worker thread that the
//      host terminates when the deadline passes. A synchronous infinite loop in the
//      guest cannot wedge the host because a *different* thread kills it.
//   2. Bounded memory. A module that imports memory is handed one created with a hard
//      `maximum`; a module that declares its own memory is rejected at compile time
//      unless it declares a bounded maximum within the cap (see readMemoryLimits).
//   3. Deny-by-default imports. A module may import nothing the host did not put on an
//      explicit allow-list. Anything else is rejected before instantiation, so the
//      guest is handed no ambient host capability.
//
// The isolation properties are covered by compute.test.mjs (infinite loop killed,
// memory rejected, denied import rejected) — outcomes, not assertions.

import { Worker } from 'node:worker_threads';

const WASM_PAGE_BYTES = 64 * 1024;

// Worker body (runs on its own thread). Kept as a string so the package stays a
// single file with no build step. It receives the guest module + policy via
// workerData, enforces the import and memory policy, runs the function, and posts
// back a structured-cloneable result. Any capability the guest gets is passed in
// explicitly here; there is no implicit host access.
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const WASM_PAGE_BYTES = ${WASM_PAGE_BYTES};

// Read the module's own memory-section limits (WASM binary section id 5), in pages.
// Returns { count, min, max, shared } or null if the module declares no memory. A guest
// that declares more than one memory, shared memory, or unbounded/oversized memory is
// rejected. Runs only AFTER WebAssembly.compile has validated the byte structure, so the
// section layout here is already known well-formed — we parse only to read the limits the
// compile step does not expose through any API.
function readMemoryLimits(bytes) {
  let p = 8; // skip magic (\\0asm) + version, 8 bytes
  const uleb = () => { let x = 0, s = 0, b; do { b = bytes[p++]; x += (b & 0x7f) * (2 ** s); s += 7; } while (b & 0x80); return x; };
  while (p < bytes.length) {
    const id = bytes[p++];
    const size = uleb();
    const end = p + size;
    if (id === 5) {
      const count = uleb();
      if (count === 0) return null;
      const flags = bytes[p++];
      const min = uleb();
      const max = (flags & 0x01) ? uleb() : null;
      // flags bit1 = shared memory (threads proposal). Shared memory is cross-thread
      // mutable state we will not hand a paid guest.
      return { count, min, max, shared: Boolean(flags & 0x02) };
    }
    p = end;
  }
  return null;
}

(async () => {
  try {
    const { wasmCode, functionName, args, maxPages, allowed, hostSource, hostData } = workerData;
    // wasmCode arrives as a Uint8Array (structured-cloned across threads) — no per-byte
    // re-materialisation. WebAssembly.compile accepts the typed array directly.

    // (0) Validate structure FIRST: a malformed module is rejected here as a compile
    // failure, so the limit parser below only ever runs on well-formed bytes.
    const module = await WebAssembly.compile(wasmCode);

    // (2) Reject a guest whose own memory is multiple / shared / unbounded / over the cap.
    const own = readMemoryLimits(wasmCode);
    if (own) {
      if (own.count > 1) { parentPort.postMessage({ ok: false, error: 'module declares multiple memories; rejected' }); return; }
      if (own.shared) { parentPort.postMessage({ ok: false, error: 'module declares shared memory; rejected' }); return; }
      if (own.max === null) { parentPort.postMessage({ ok: false, error: 'module memory is unbounded (no maximum); rejected' }); return; }
      if (own.max > maxPages) { parentPort.postMessage({ ok: false, error: 'module memory maximum ' + own.max + ' pages exceeds limit ' + maxPages }); return; }
      if (own.min > maxPages) { parentPort.postMessage({ ok: false, error: 'module memory minimum exceeds limit' }); return; }
    }

    // HOST HOOK (deny-by-default, still). When a caller supplies a host module, it runs
    // HERE in the worker — never a cross-thread call — over a staged read-set (hostData)
    // and collects a write-set (ctx.writes) posted back to the parent, which is what makes
    // synchronous WASM host imports possible without giving the guest thread any live
    // handle to parent state. The host module is the caller's own trusted code (e.g. the
    // XCL contract ABI), NOT the untrusted guest. It can ONLY provide functions for imports
    // the guest declares; anything it does not provide is still denied.
    const ctx = { data: hostData || {}, writes: [], log: [], instance: null,
                  mem: () => (ctx.instance && ctx.instance.exports.memory) || null };
    let hostImports = {};
    if (hostSource) {
      // eslint-disable-next-line no-eval
      const makeHost = (0, eval)('(' + hostSource + ')');
      hostImports = makeHost(ctx) || {};
    }

    // (3) Deny-by-default imports. Each import is satisfied by the host module if it
    // provides that exact "module.name" key, else by an allow-listed inert stub, else denied.
    const allowedSet = new Set(allowed || []);
    const importObject = {};
    for (const imp of WebAssembly.Module.imports(module)) {
      const key = imp.module + '.' + imp.name;
      const hostFn = hostImports[key];
      importObject[imp.module] = importObject[imp.module] || {};
      if (typeof hostFn === 'function') {
        importObject[imp.module][imp.name] = hostFn;   // real, in-worker host binding
        continue;
      }
      if (!allowedSet.has(key)) { parentPort.postMessage({ ok: false, error: 'denied import: ' + key }); return; }
      if (imp.kind === 'memory') {
        importObject[imp.module][imp.name] = new WebAssembly.Memory({ initial: 1, maximum: maxPages });
      } else if (imp.kind === 'global') {
        importObject[imp.module][imp.name] = new WebAssembly.Global({ value: 'i32', mutable: false }, 0);
      } else {
        // Allowed function import with no host binding: a stub that traps if the guest
        // actually calls it, so an allow-listed name still grants no real host behaviour.
        importObject[imp.module][imp.name] = () => { throw new Error('host import ' + key + ' is not callable'); };
      }
    }

    const instance = await WebAssembly.instantiate(module, importObject);
    ctx.instance = instance;   // host fns can now reach guest memory via ctx.mem()

    // (2) Cap a memory the guest exported itself (belt-and-braces with the section check).
    const mem = instance.exports.memory;
    if (mem && mem.buffer.byteLength > maxPages * WASM_PAGE_BYTES) {
      parentPort.postMessage({ ok: false, error: 'exported memory exceeds limit' }); return;
    }

    const fn = instance.exports[functionName];
    if (typeof fn !== 'function') { parentPort.postMessage({ ok: false, error: 'Function ' + functionName + ' not found' }); return; }

    const result = fn(...(args || []));
    parentPort.postMessage({ ok: true, result, writes: ctx.writes, log: ctx.log });
  } catch (err) {
    parentPort.postMessage({ ok: false, error: String((err && err.message) || err) });
  }
})();
`;

export class ComputeRuntime {
  /**
   * @param {object} [options]
   * @param {number} [options.maxMemory=67108864] hard memory cap in bytes (default 64 MiB)
   * @param {number} [options.maxTime=5000] wall-clock deadline in ms; the worker is terminated past it
   * @param {string[]} [options.allowedImports=[]] "module.name" imports the guest may declare (deny-by-default)
   */
  constructor(options = {}) {
    this.maxMemory = options.maxMemory || 64 * 1024 * 1024;
    this.maxTime = options.maxTime || 5000;
    this.allowedImports = options.allowedImports || [];
  }

  /**
   * Run an untrusted WASM export under isolation. Rejects on denied import, memory
   * violation, missing function, guest trap, or deadline.
   *
   * With no `host`, resolves to the guest's return value (the raw compute-market path).
   * With a `host`, resolves to `{ result, writes, log }` — `writes` is the write-set the
   * host module collected (e.g. staged verkle mutations), which the CALLER applies to real
   * state after the sandboxed run. The host module is trusted caller code that runs inside
   * the worker over the staged read-set; the guest stays untrusted.
   *
   * @param {Uint8Array|ArrayBuffer|number[]} wasmCode
   * @param {string} functionName exported function to call
   * @param {Array<number|bigint>} [args]
   * @param {object} [opts]
   * @param {{source:string, data?:object}} [opts.host] in-worker host module: `source` is a
   *   stringified `(ctx) => ({ "env.name": fn, ... })` factory; `ctx.data` is the staged
   *   read-set, `ctx.writes`/`ctx.log` are collectors posted back, `ctx.mem()` gives the
   *   guest Memory after instantiation. Only imports it provides become callable.
   * @returns {Promise<number|bigint|{result:any, writes:any[], log:any[]}>}
   */
  async execute(wasmCode, functionName, args = [], opts = {}) {
    const maxPages = Math.max(1, Math.ceil(this.maxMemory / WASM_PAGE_BYTES));
    // Normalise to a Uint8Array once. structuredClone (how workerData crosses threads)
    // handles typed arrays directly, so a multi-MB guest is NOT re-materialised byte by
    // byte into a plain Array on the hot path.
    const wasmBytes =
      wasmCode instanceof Uint8Array ? wasmCode :
      wasmCode instanceof ArrayBuffer ? new Uint8Array(wasmCode) :
      Uint8Array.from(wasmCode);

    const host = opts.host || null;
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: {
        wasmCode: wasmBytes, functionName, args, maxPages, allowed: this.allowedImports,
        hostSource: host ? host.source : null,
        hostData: host ? (host.data || {}) : null,
      },
      resourceLimits: {
        // Hard V8 heap cap so a JS-side allocation bomb dies with the thread. WASM
        // linear memory is bounded separately by the checks above.
        maxOldGenerationSizeMb: Math.max(16, Math.ceil(this.maxMemory / (1024 * 1024)) + 16),
      },
    });

    return await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Fire-and-forget: the thread is done or being killed either way.
        worker.terminate();
        fn(v);
      };
      // (1) The real deadline: terminate the thread. This kills a synchronous
      // infinite loop in the guest, which a same-thread timer never could.
      const timer = setTimeout(
        () => finish(reject, new Error('Execution time limit exceeded')),
        this.maxTime,
      );
      worker.once('message', (m) => {
        if (m && m.ok) finish(resolve, host ? { result: m.result, writes: m.writes || [], log: m.log || [] } : m.result);
        else finish(reject, new Error((m && m.error) || 'WASM execution failed'));
      });
      worker.once('error', (e) => finish(reject, new Error('WASM execution failed: ' + e.message)));
      worker.once('exit', (code) => {
        if (!settled) finish(reject, new Error('worker exited before result (code ' + code + ')'));
      });
    });
  }
}
