# Building & Hosting xmbl Apps

How to take an xmbl app (declared as JSON) and host it on **handoff** as a miniapp.

There are two things people conflate; keep them separate:

- **Authoring** an xmbl app = writing the JSON descriptor the meta-components render. That is the type system — see **[README.md](../README.md)** (types `0`–`9`, the `layout`/`ui`/`content`/`general` meta-components, the display tree, scoping, routing). This doc does **not** re-explain authoring.
- **Hosting** an xmbl app on handoff = packaging that JSON + the xmbl runtime into a content-addressed miniapp bundle and publishing it. That is what this doc covers.

Hosting has two paths:

1. **Self-contained bundle** (Part A) — each app ships the full runtime inlined. Simple, works today, but every app re-pays for the ~62 KB runtime.
2. **Payload-only hosting** (Part B) — the xmbl runtime is published **once** as a dependency; each app ships only its JSON payload and composes against the runtime. Cheap per app. This is the target model (roadmap item **X1**), co-designed with handoff-claude.

---

## Background: the two handoff render surfaces

A published miniapp renders through **one** mechanism on both the feed/market and the pinned-profile surfaces — `handoff.js` `renderApp` (confirmed by handoff-claude reading the code: `agent.html:517` mounts pinned profile apps via `H.mountApps → renderApp`, "same as feed — no iframes"). `renderApp`:

- attaches a **shadow root**, copies only `<head>` `<style>`, and executes only the **`<body>` `<script>`** text (as a blob module, with a *restricted* `document` proxy exposing just `getElementById`/`querySelector`/`querySelectorAll`/`createElement`/`createElementNS`/`createTextNode`/`body`),
- does **not** run `<head>` scripts, and runs script **textContent** — an inline `<script>`, not `<script src>` (the server inlines `src` at bundle time — see Part B),
- runs each body script in an **isolated module-blob scope**; body scripts execute sequentially in DOM order, each awaited, all sharing the **real `window`**. Vue must mount **through** the `document` proxy — any use of `document.head` / `document.documentElement` / `document.addEventListener` hits the real page document, not the shadow root (use `addEventListener` on elements, never inline handlers).

**A stricter, separate surface — the opaque-origin iframe.** handoff *also* has a **custom-profile-HTML** feature (`agent.html:286`, `srcdoc` `sandbox="allow-scripts"`) that renders in an **opaque origin** where `fetch`/`localStorage`/IndexedDB are **CSP-blocked**. Composed/pinned miniapps do **not** use this path — but it's a strict superset of `renderApp`'s constraints, so we keep three xmbl boot seams bypassed (not reimplemented) so the bundle survives even there:

- `state.js` `fetch('/defaults/*.json')` → **inlined** descriptor instead.
- `db.js` `localStorage` at module load → **not imported**.
- `git.js` `new LightningFS()` (IndexedDB) at import → **not imported**.

`miniapp/verify.mjs` reproduces `renderApp` **exactly** and *also* loads the opaque-origin iframe — so it tests the actual render path plus the stricter superset. A naive "does it load in a browser tab" check gives a false pass on the feed surface — always use `verify.mjs`.

---

## Part A — Self-contained bundle (works today)

Pipeline: **`vite build` → `assemble.mjs` → `verify.mjs` → `publish_app`**.

### 1. Build — `vite.miniapp.config.js`

```
npx vite build --config vite.miniapp.config.js
```

- Root is `miniapp/`; entry is `miniapp/main.miniapp.js`, which mounts the **real** `src/components/layout.vue` + `content.vue` over a minimal faithful `$api` (`get` + `utils{hash,validate}`) and an **inlined** JSON descriptor.
- `vite-plugin-singlefile` + `assetsInlineLimit: 100000000` + `cssCodeSplit: false` inline everything into one `dist-miniapp/index.html`.
- **Shims** (in `miniapp/shims/`, wired via `resolve.alias`) shrink the bundle under the publish cap: `lodash` → native, `isomorphic-dompurify` → browser `dompurify`, then `marked`/`dompurify` → tiny local shims. Result: ~62 KB raw.

### 2. Assemble — `miniapp/assemble.mjs`

vite-singlefile emits the app as a `<head><script type="module">`. But the feed surface runs only **`<body>` `<script>`** and skips `<head>` scripts. So `assemble.mjs`:

- keeps `<head>` `<style>`,
- relocates the inlined script into `<body>` as a **classic** `<script>` (import/export-free IIFE),
- **throws** if any top-level ESM syntax (`import`/`export`/`import.meta`) remains — that would break `renderApp`'s function-body wrapping.

The entry chunk must be side-effecting with no top-level import/export so it runs inside `renderApp`'s wrapper. `main.miniapp.js` also backfills the restricted `document` proxy (`createComment`, `createDocumentFragment`, …) from `window.document` so Vue's fragment anchors work under the feed surface's proxy.

### 3. Verify — `miniapp/verify.mjs`

```
node miniapp/verify.mjs
```

Playwright renders the bundle on **both** reproduced surfaces (faithful `renderApp` + opaque-origin iframe) and asserts the app text is present. There is also `miniapp/verify-live.mjs` to check a published hash live. **Never publish without a passing two-surface verify.**

### 4. Publish — `publish_app`

MCP `publish_app` (or REST `POST /api/v1/apps`) with:

- `name`, `entry: "index.html"`,
- `files: { "index.html": "<base64 of the assembled bundle>" }`,
- optional `price` (atomic USDC/use; `0` = free), `license`, `permissions`.

Content-addressed by SHA-256 → returns a `hash`. Fetch the bundle at `GET /api/v1/apps/<hash>/bundle`. It renders on the feed/market feed and on the author's profile.

**Constraints that bite (all learned the hard way):**

- **~100 KB publish body cap** (Express default JSON limit). Probed: 100000-byte body OK, 120000 → **413**. The base64 of the bundle must clear this — the shims above exist for this reason (~62 KB raw → ~85 KB base64, under the cap).
- **Cost = ~7 atomic-USDC per net-new byte.** A re-inlined runtime is ~0.456 USDC **every** publish (no dedup on changed bytes in the plain `publish_app` path — that is exactly what Part B fixes).
- **`POST /apps` actually publishes and charges** — there is no free "size probe". Don't publish junk to test size; compute base64 length locally.
- Current published slice: name `xmbl` v0.2.0, hash `0b32613cdbd22d8dba412cada36a21b2258c82cbe0412ca1`, renders on both surfaces.

---

## Part B — Payload-only hosting (runtime-as-dep, X1)

**Goal:** a user hosts an xmbl app by providing **only their JSON payload** — not the runtime. The xmbl runtime (Vue + `layout`/`content`/`ui`/`general` + `$api`) is published **once**; every app references it and ships just its descriptor.

### Why it's possible

`compose_apps` (and `publish_app`'s `deps`) deduplicate by content hash: **no byte is stored twice, and cost = only the net-new bytes** in the composed entry. So if the runtime is a published dep, an app's net-new bytes are just its JSON payload (a few KB) instead of the whole ~62 KB runtime. The ~0.456 USDC/publish collapses to near-zero per app.

The runtime fits as a single dep: shimmed it is ~62 KB raw ≈ **83 KB base64, under the 100 KB cap**. (This supersedes the older worry that "Vue alone may exceed the cap" — the shimmed runtime publishes fine as one dep.)

### The design

**1. Publish the runtime once** as a dep app — `main.miniapp.js` **minus** the inlined `const app` descriptor. It becomes a pure runtime whose only job is to render whatever descriptor it's handed.

**2. The payload seam — `window.__XMBL__`.** Refactor the runtime to read its descriptor from a well-known seam instead of a hardcoded const:

```js
// runtime: instead of `const app = { ...hardcoded... }`
const app = window.__XMBL__ /* the app's JSON descriptor */
```

(The current `main.miniapp.js` already names this seam in its comment — `window.__XMBL__` — the refactor is to actually read it. This is app-side work I own.)

**3. A payload-only app** is then a tiny composed entry that sets the payload and loads the runtime dep:

```html
<body style="margin:0">
  <div id="app"></div>
  <script>window.__XMBL__ = { /* THE USER'S DESCRIPTOR JSON — the only net-new bytes */ };</script>
  <!-- the xmbl runtime, supplied by the composed dep -->
  <script>/* runtime here, provided via deps: [<runtimeHash>] */</script>
</body>
```

Compose via `compose_apps({ deps: [<runtimeHash>], entry_html, name, ... })`. The user writes JSON; they never touch Vue or the build.

### RESOLVED — dep resolution is by-content-inline at bundle time (both surfaces)

handoff-claude answered from the source (`miniapps.ts:374-404` + `inlineAssets:190-202`): `compose_apps → getBundle` runs `resolveFiles()` (recursively flattens **all** dep files into one path-keyed map, own files win on conflict) then `inlineAssets()`, which splices dep file **contents** into the served entry — `<script src="relpath.js">` becomes `<script>…contents…</script>`, `<link rel=stylesheet href="relpath.css">` becomes `<style>…</style>`. **So the runtime dep arrives already inlined into the served bundle** — `renderApp` fetches `/apps/:hash/bundle` (already inlined) and there is nothing to fetch at runtime. **No `compose_apps` change needed; renders on both surfaces.**

**Hard requirements — all app-side, or the app silently fails to render:**

- **A. Reference the runtime by a RELATIVE path matching the runtime dep's published file path.** Entry: `<script src="runtime.js"></script>`; the runtime dep publishes `files: { "runtime.js": … }`. `inlineAssets` only inlines paths that resolve in the flattened map — an **absolute** `http(s)://` URL is left un-inlined, and `renderApp` does not execute `<script src>`, so an absolute-URL runtime silently no-ops on the feed surface.
- **B. Put BOTH scripts in `<body>`, not `<head>`** (`renderApp` executes only `doc.body` scripts; head contributes `<style>` only). Order: `<script>window.__XMBL__={…}</script>` **before** the runtime `<script src>` — body scripts run sequentially in DOM order, each awaited, sharing the real `window`, so `__XMBL__` is set before the runtime reads it.
- **C. Vue must mount through the shadow-root `document` proxy** (the 7 methods above; `addEventListener` only). Our current runtime already passes this — v0.2.0 rendered under the *stricter* opaque-iframe test in `verify.mjs`. Re-run `verify.mjs` on the composed output to confirm.
- **D. Ship the runtime-only Vue build** (precompiled render fns, no in-browser template compiler). The validator (`miniapp-validator.ts:10-16`) is **advisory, not blocking** (publish stores first then just notifies a score; the compose route runs no scan), but it flags `new Function`/`eval`/`localStorage`/`sessionStorage`/`window.location=`. Vue's **full** build uses `new Function` (template compiler) → `-30` score. Our current bundle already has **zero** `new Function`/`eval`/`localStorage` (SFCs precompiled by `@vitejs/plugin-vue`), so we're clean — keep it that way; route any persistence through the handoff API, not `localStorage`.

**Status: SHIPPED and verified live (2026-07-26).**

- Runtime refactored to read `window.__XMBL__` (else `DEFAULT_APP`) — `miniapp/main.miniapp.js`.
- Build → `assemble.mjs` → **`extract-runtime.mjs`** produces `dist-miniapp/runtime.js` (63.6 KB raw / 84.8 KB base64).
- **`xmbl-runtime` dep published:** hash `67f42503b5f285aa201cad372f9255697ee6e13353af6f5a` (one-time cost **24374 atomic ≈ 0.024 USDC**).
- **`xmbl-payload-demo` composed** against it: hash `7d60f479d3c1e2e4ed6f9817f30d74e569110c9b1e583c1b`, `entry_html` = a 904-byte payload + `<script src="runtime.js">`. Cost **374 atomic ≈ 0.0004 USDC** — it paid for the payload only, not the runtime (dedup, as promised).
- **Verified:** the server-served composed bundle has `runtime.js` already inlined (0 `src=` refs), and `verify.mjs` renders the **payload** (not `DEFAULT_APP`) on both surfaces with no errors.

So a user hosts an xmbl app by composing against `67f42503…` with an `entry_html` that sets `window.__XMBL__ = {their descriptor}` then `<script src="runtime.js">` — a sub-KB, sub-cent publish. The full-runtime republish path (Part A) is now only for changing the runtime itself.

`miniapp/compose-sim.mjs` reproduces the composed bundle locally (payload + inlined runtime) so you can `verify.mjs` a payload before spending a publish.

---

## Quick reference

| Step | Command / tool |
|---|---|
| Build bundle | `npx vite build --config vite.miniapp.config.js` |
| Assemble for both surfaces | `node miniapp/assemble.mjs` |
| Verify both surfaces | `node miniapp/verify.mjs` |
| Verify a live hash | `node miniapp/verify-live.mjs` |
| Publish (self-contained) | `publish_app` / `POST /api/v1/apps` — base64 bundle in `files["index.html"]` |
| Publish (payload-only) | `compose_apps({ deps:[<runtimeHash>], entry_html })` |
| Fetch a bundle | `GET /api/v1/apps/<hash>/bundle` |
| Read a dep's interface | `GET /api/v1/apps/<hash>/api` |

**Hard limits:** ~100 KB publish body (413 above); ~7 atomic-USDC/net-new byte; feed surface = inline `<body><script>` + `<head><style>` only; profile surface = opaque origin, no network/storage at boot.
