// BROWSER-SURFACE VERIFY for the XMBL browser extension popup (packages/browser-extension).
//
// Drives the REAL built popup (dist/popup.js) in a real browser engine (Playwright chromium) through
// every workflow and asserts the rendered OUTCOME, exiting non-zero on any failure. Only the two
// extension HOST APIs are shimmed, in harness.html: chrome.storage.local (an in-memory store with
// chrome's callback semantics — identical API to what Chrome provides) and chrome.runtime.sendMessage
// (emulating the node bridge the extension ships as a stub). Everything under test runs UNMODIFIED —
// the Vue popup, webextension-polyfill, the real @xmbl/lng compiler, the contract-runtime executor,
// content-addressed id derivation, the browser.storage registry, and revert handling.
//
// NOT a substitute for the node parity proof (tests/contract-runtime.parity.test.mjs asserts the
// in-page id/coords are byte-identical to node @xmbl/contracts); this proves the popup's workflows
// actually function in a browser. Needs a chromium binary (Playwright) + a built dist/, so it is run
// on demand, not in the protocol hard gate. Build first:  npm run build -w packages/browser-extension
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' };
const SHOTS = join(HERE, 'tests', 'screenshots');
mkdirSync(SHOTS, { recursive: true });
const shot = (page, name) => page.screenshot({ path: join(SHOTS, name) });

let pass = 0, fail = 0;
const check = (n, cond, detail = '') => { if (cond) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}${detail ? '\n       ' + detail : ''}`); fail++; } };

// ── static server over the extension dir (serves harness.html + dist/popup.js) ──
const server = createServer(async (req, res) => {
  try {
    const p = join(HERE, decodeURIComponent(req.url.split('?')[0]));
    const body = await readFile(p);
    res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const URL = `http://localhost:${port}/harness.html`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 480, height: 900 } });
const consoleErrors = [];
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

const text = async (sel) => (await page.locator(sel).first().textContent() || '').trim();
const tileValue = async (name) => page.evaluate((n) => {
  const tiles = [...document.querySelectorAll('.statebar .tile')];
  const t = tiles.find((x) => (x.querySelector('.tile-k')?.textContent || '').trim().startsWith(n));
  return t ? (t.querySelector('.tile-v')?.textContent || '').trim() : null;
}, name);
// The CALL result is the newest line of the run trace (prepended, so it is the first .tline).
const lastTrace = async () => (await page.locator('.trace .tline').first().textContent() || '').trim();
const waitCallResult = () => page.waitForFunction(() => !!document.querySelector('.trace .tline'), { timeout: 10000 });
// Inline tester: one .call-row per entrypoint. Locate a row by its `.ep` name, fill its args, Run.
const callRow = (ep) => page.locator('.call-row').filter({ has: page.locator('.ep', { hasText: new RegExp('^' + ep + '$') }) });
async function runEp (ep, args = []) {
  const row = callRow(ep);
  const inputs = row.locator('.arg');
  for (let i = 0; i < args.length; i++) await inputs.nth(i).fill(String(args[i]));
  await row.getByRole('button', { name: /Run/ }).click();
}
const epNames = async () => (await page.locator('.call-row .ep').allTextContents()).map((s) => s.trim());

try {
  console.log('BROWSER-SURFACE VERIFY — XMBL extension popup (real dist/popup.js in chromium)\n');
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('#shell', { timeout: 10000 });

  // ── 1) SHELL + TABS ──
  console.log('── shell & tabs ──');
  check('popup shell renders', await page.locator('#shell').count() === 1);
  check('title is XMBL Console', (await text('.title')).replace(/\s+/g, ' ') === 'XMBL Console');
  check('five tabs present (Contracts, Crypto, Wallet, Node, Config)', (await page.locator('nav.tabs .tab').allTextContents()).join(',') === 'Contracts,Crypto,Wallet,Node,Config');
  check('Contracts tab is active by default', await page.locator('nav.tabs .tab.on').textContent() === 'Contracts');

  // Let the one-time sample seed (compile + deploy the full set) settle before the deploy workflow,
  // so its registry write cannot race the test's own deploy.
  await page.waitForFunction(() => { const r = window.__store['xmbl:contracts']; return r && Object.keys(r).length >= 5; }, { timeout: 20000 });
  check('Contracts tab seeds the full sample set on first open', Object.keys(await page.evaluate(() => window.__store['xmbl:contracts'])).length >= 5);

  // ── 2) CREATE + COMPILE every shipped sample (real @xmbl/lng) ──
  console.log('\n── create & compile (real @xmbl/lng) ──');
  const sampleKeys = await page.evaluate(() => [...document.querySelectorAll('.sec select.sel option')].map((o) => o.value).filter(Boolean));
  check('sample picker lists the shipped contracts', sampleKeys.length >= 3, `found: ${sampleKeys.join(', ')}`);
  for (const key of sampleKeys) {
    await page.selectOption('.sec select.sel', key);
    await page.getByRole('button', { name: /Compile/ }).click();
    await page.waitForFunction(() => {
      const ok = document.querySelector('.status.ok'), bad = document.querySelector('.status.bad');
      return (ok && /Compiled/.test(ok.textContent)) || bad;
    }, { timeout: 10000 });
    const bad = await page.locator('.status.bad').count();
    const okTxt = bad ? await text('.status.bad') : await text('.status.ok');
    check(`${key}: compiles (real bytecode)`, bad === 0 && /Compiled/.test(okTxt), okTxt);
  }
  await shot(page, 'harness-01-compiled.png');

  // ── 2b) VISUAL BUILDER — the sentence-style structural editor (the "maker"), NOT a read-only
  // body preview. Every shipped sample must render FULLY visual: editable statement rows + the
  // labeled add-bar + the live generated-LNG preview, and NONE may fall back to an "advanced body".
  console.log('\n── visual builder (maker) ──');
  for (const key of sampleKeys) {
    await page.selectOption('.sec select.sel', key);
    await page.locator('.seg-b', { hasText: 'Visual' }).click();
    await page.waitForSelector('.builder .src-preview pre', { timeout: 8000 });
    const advanced = await page.locator('.builder .advanced').count();
    const stmts = await page.locator('.builder .stmt-list .stmt').count();
    const pre = await text('.builder .src-preview pre');
    check(`${key}: renders fully visual (editable statements, no read-only fallback)`, advanced === 0 && stmts >= 1 && /~contract/.test(pre), `advanced=${advanced} stmts=${stmts}`);
    // Nested control flow (If…else arms, Repeat bodies) is the load-bearing half of the port: it
    // renders through the RECURSIVE self-import in StmtList.vue. A silently-unresolved recursive
    // component leaves the nested `.block` EMPTY (no inner stmt-list / add-bar) while the outer
    // branch/loop row still counts as a `.stmt` — so assert every nested block rendered its own
    // add-bar, which only happens if the child StmtList actually mounted.
    const nestedBlocks = await page.locator('.builder .stmt.nested .block').count();
    if (nestedBlocks > 0) {
      const nestedAddBars = await page.locator('.builder .stmt.nested .block > .stmt-list > .add-bar').count();
      const nestedInnerStmts = await page.locator('.builder .stmt.nested .block .stmt-list .stmt').count();
      check(`${key}: nested control-flow blocks render via recursive StmtList (not silently empty)`, nestedAddBars >= nestedBlocks && nestedInnerStmts >= 1, `blocks=${nestedBlocks} addBars=${nestedAddBars} innerStmts=${nestedInnerStmts}`);
      // Element screenshot of the nested statement itself (Ledger's repeat / Logic's if…else) — the
      // popup scrolls an inner container, so a viewport/fullPage shot leaves the nested block below the
      // fold; targeting the element captures its whole box, the visual match to the assertion above.
      if (key === 'Ledger' || key === 'Logic') {
        const nested = page.locator('.builder .stmt.nested').last();
        await nested.scrollIntoViewIfNeeded().catch(() => {});
        await nested.screenshot({ path: join(SHOTS, key === 'Ledger' ? 'harness-01c-ledger-loop.png' : 'harness-01d-logic-branch.png') }).catch(() => {});
      }
    }
    await page.locator('.seg-b', { hasText: 'Code' }).click();
  }
  // The add-bar offers all six statement kinds, and authoring one updates the generated LNG live.
  await page.selectOption('.sec select.sel', 'Counter');
  await page.locator('.seg-b', { hasText: 'Visual' }).click();
  await page.waitForSelector('.builder .src-preview pre', { timeout: 8000 });
  const addLabels = (await page.locator('.builder .method').first().locator('.add-bar .add').allTextContents()).map((s) => s.trim());
  check('add-bar offers all six statement kinds', ['+ Set', '+ Local', '+ Return', '+ Emit', '+ If/else', '+ Repeat'].every((l) => addLabels.includes(l)), addLabels.join(' '));
  const preBefore = await text('.builder .src-preview pre');
  await page.locator('.builder .method').first().locator('.add-bar .add', { hasText: '+ Set' }).click();
  await page.waitForFunction((prev) => { const p = document.querySelector('.builder .src-preview pre'); return p && p.textContent !== prev; }, preBefore, { timeout: 8000 });
  check('authoring a statement updates the generated LNG live', (await text('.builder .src-preview pre')) !== preBefore);
  await shot(page, 'harness-01b-builder.png');
  await page.locator('.seg-b', { hasText: 'Code' }).click();

  // ── 3) DEPLOY (content-addressed, saved to the browser.storage registry) ──
  console.log('\n── deploy ──');
  // The full sample set was seeded on first open (proven above); clear it via the per-instance ×
  // (also proving removal) so the deploy workflow starts from an empty list and the Deploy button
  // is offered rather than showing the already-deployed state.
  let guard = 0;
  while ((await page.locator('.inst').count()) > 0 && guard++ < 20) {
    await page.locator('.inst .btn.danger').first().click();
    await page.waitForTimeout(60);
  }
  check('removing every seeded instance empties the Find list', (await page.locator('.inst').count()) === 0);
  // The empty Find list must offer a way BACK — removing every seed must not permanently kill the
  // tab (the operator's original "search does nothing" failure). Prove the restore button works.
  check('empty Find list offers a "Load examples" restore button', await page.getByRole('button', { name: /Load examples/ }).count() === 1);
  await page.getByRole('button', { name: /Load examples/ }).click();
  await page.waitForFunction(() => document.querySelectorAll('.inst').length >= 5, { timeout: 20000 });
  check('"Load examples" restores the full sample set', (await page.locator('.inst').count()) >= 5, `instances=${await page.locator('.inst').count()}`);
  // Re-empty so the deploy workflow below starts from a clean list.
  guard = 0;
  while ((await page.locator('.inst').count()) > 0 && guard++ < 20) {
    await page.locator('.inst .btn.danger').first().click();
    await page.waitForTimeout(60);
  }
  check('Find list empty again before the deploy workflow', (await page.locator('.inst').count()) === 0);
  await page.selectOption('.sec select.sel', 'Counter');
  await page.getByRole('button', { name: /Compile/ }).click();
  await page.waitForSelector('.idbox .v');
  const deployedId = (await text('.idbox .idrow:has(.k:text-is("id")) .v')) || (await text('.idbox .v'));
  check('Counter derives a content-addressed id (xc1_)', /^xc1_[0-9a-f]{64}$/.test(deployedId), deployedId);
  await page.getByRole('button', { name: /Deploy instance/ }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.status.ok')].some((e) => /Deployed/.test(e.textContent)), { timeout: 10000 });
  const stored = await page.evaluate(() => window.__store['xmbl:contracts']);
  check('deploy writes the instance to browser.storage', !!stored && !!stored[deployedId], `store keys: ${stored ? Object.keys(stored).length : 0}`);
  check('stored instance records the node-identical id', !!stored && stored[deployedId] && stored[deployedId].id === deployedId);
  await shot(page, 'harness-02-deployed.png');

  // ── 4) FIND (list + search filter) ──
  console.log('\n── find ──');
  check('deployed instance appears in the list', await page.locator('.inst .inst-name').first().textContent() === 'Counter');
  await page.fill('.sec input.in[placeholder*="find"]', 'counter');
  check('search by name keeps the match', await page.locator('.inst').count() === 1);
  await page.fill('.sec input.in[placeholder*="find"]', 'zzz-nomatch');
  check('search with no match hides all', await page.locator('.inst').count() === 0);
  await page.fill('.sec input.in[placeholder*="find"]', '');

  // ── 5) CALL (inline per-entrypoint rows → run → committed state moves; then revert leaves it) ──
  console.log('\n── call (inline tester) ──');
  // Counter auto-selected on deploy. Every entrypoint gets its own Run row (not one dropdown).
  check('the tester lists a row per entrypoint', (await epNames()).length === (await page.locator('.call-row').count()) && (await epNames()).includes('inc') && (await epNames()).includes('incBy'), (await epNames()).join(', '));
  check('Counter committed state starts at 0', await tileValue('count') === '0', `count=${await tileValue('count')}`);
  await runEp('inc');
  await page.waitForFunction(() => { const t = [...document.querySelectorAll('.statebar .tile')].find((x) => (x.querySelector('.tile-k')?.textContent || '').trim().startsWith('count')); return t && (t.querySelector('.tile-v')?.textContent || '').trim() === '1'; }, { timeout: 10000 });
  check('inc() returns and commits count → 1', (await tileValue('count')) === '1', `trace="${await lastTrace()}" count=${await tileValue('count')}`);
  check('the run trace records the successful call', /✓\s*inc/.test(await lastTrace()), await lastTrace());
  // incBy(41) → 42
  await runEp('incBy', [41]);
  await page.waitForFunction(() => {
    const t = [...document.querySelectorAll('.statebar .tile')].find((x) => (x.querySelector('.tile-k')?.textContent || '').trim().startsWith('count'));
    return t && (t.querySelector('.tile-v')?.textContent || '').trim() === '42';
  }, { timeout: 10000 });
  check('incBy(41) commits count → 42', (await tileValue('count')) === '42', `count=${await tileValue('count')}`);
  await shot(page, 'harness-03-call-count-42.png');

  // Revert path: deploy Vault, over-withdraw → reverts, balance unmoved.
  await page.selectOption('.sec select.sel', 'Vault');
  await page.getByRole('button', { name: /Compile/ }).click();
  await page.waitForSelector('.idbox .v');
  await page.getByRole('button', { name: /Deploy instance/ }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.status.ok')].some((e) => /Deployed/.test(e.textContent)), { timeout: 10000 });
  await page.waitForSelector('.call-row', { timeout: 10000 });
  const vaultEps = await epNames();
  const balStart = await tileValue('bal');
  if (vaultEps.includes('withdraw')) {
    await runEp('withdraw', [999999]);
    await page.waitForFunction(() => { const t = document.querySelector('.trace .tline'); return t && /reverted/.test(t.textContent || ''); }, { timeout: 10000 });
    const msg = await lastTrace();
    check('Vault over-withdraw reverts (underflow)', /reverted/.test(msg), msg);
    check('reverted call leaves bal unmoved', (await tileValue('bal')) === balStart, `before=${balStart} after=${await tileValue('bal')}`);
    await shot(page, 'harness-04-vault-revert.png');
  } else {
    check('Vault exposes a withdraw entrypoint', false, `entrypoints: ${vaultEps.join(', ')}`);
  }

  // ── 6) WALLET tab (against the stub node bridge) ──
  console.log('\n── wallet ──');
  await page.locator('nav.tabs .tab', { hasText: 'Wallet' }).click();
  await page.waitForFunction(() => /XMBL/.test(document.querySelector('.balance-amt .amt')?.textContent || '') || document.querySelector('.balance-amt'), { timeout: 5000 }).catch(() => {});
  check('wallet balance renders (0 from stub)', (await text('.balance-amt .amt')) === '0', `balance=${await text('.balance-amt .amt')}`);
  // Every tab's component is in the DOM (v-show), so scope the live-dot to the visible Wallet tab.
  check('node status shows stopped', (await text('.live-dot:visible')) === 'stopped', await text('.live-dot:visible'));
  await page.getByRole('button', { name: /Start node/ }).click();
  await page.waitForFunction(() => { const d = [...document.querySelectorAll('.live-dot')].find((e) => e.offsetParent !== null); return d && /running/.test(d.textContent || ''); }, { timeout: 5000 });
  check('Start node toggles to running', (await text('.live-dot:visible')) === 'running');
  await shot(page, 'harness-05-wallet.png');

  // ── 7) no page errors anywhere in the run ──
  console.log('\n── errors ──');
  const harnessErrors = await page.evaluate(() => window.__errors || []);
  check('no uncaught page errors (window)', harnessErrors.length === 0, harnessErrors.join(' | '));
  check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' | '));

  console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — ${pass} checks passed, ${fail} failed across shell/create/compile/deploy/find/call/revert/wallet`);
} catch (e) {
  console.error('\n❌ harness error —', e.message);
  fail++;
} finally {
  await browser.close();
  server.close();
}
process.exit(fail === 0 ? 0 : 1);
