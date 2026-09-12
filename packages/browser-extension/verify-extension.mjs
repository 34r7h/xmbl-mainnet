// BROWSER-SURFACE VERIFY for the XMBL browser extension popup (packages/browser-extension).
//
// Drives the REAL built popup (dist/popup.js) in a real browser engine (Playwright chromium) through
// every workflow and asserts the rendered OUTCOME, exiting non-zero on any failure. Only the two
// extension HOST APIs are shimmed, in _harness.html: chrome.storage.local (an in-memory store with
// chrome's callback semantics — identical API to what Chrome provides) and chrome.runtime.sendMessage
// (emulating the node bridge the extension ships as a stub). Everything under test runs UNMODIFIED —
// the Vue popup, webextension-polyfill, the real @xmbl/lng compiler, the contract-runtime executor,
// content-addressed id derivation, the browser.storage registry, and revert handling.
//
// NOT a substitute for the node parity proof (__tests__/contract-runtime.parity.test.mjs asserts the
// in-page id/coords are byte-identical to node @xmbl/contracts); this proves the popup's workflows
// actually function in a browser. Needs a chromium binary (Playwright) + a built dist/, so it is run
// on demand, not in the protocol hard gate. Build first:  npm run build -w packages/browser-extension
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' };

let pass = 0, fail = 0;
const check = (n, cond, detail = '') => { if (cond) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}${detail ? '\n       ' + detail : ''}`); fail++; } };

// ── static server over the extension dir (serves _harness.html + dist/popup.js) ──
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
const URL = `http://localhost:${port}/_harness.html`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 480, height: 900 } });
const consoleErrors = [];
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

const text = async (sel) => (await page.locator(sel).first().textContent() || '').trim();
const tileValue = async (name) => page.evaluate((n) => {
  const tiles = [...document.querySelectorAll('.statebar .tile')];
  const t = tiles.find((x) => (x.querySelector('.tk')?.textContent || '').trim().startsWith(n));
  return t ? (t.querySelector('.tv')?.textContent || '').trim() : null;
}, name);
// the CALL result line — several .status nodes exist (Compile, Deploy); the call message is the one
// carrying a return arrow or a revert, so find it rather than taking the first .status on the page.
const callStatus = async () => page.evaluate(() => {
  const m = [...document.querySelectorAll('.status')].find((e) => /→|reverted/.test(e.textContent));
  return m ? m.textContent.trim() : '';
});
const waitCallResult = () => page.waitForFunction(() => [...document.querySelectorAll('.status')].some((e) => /→|reverted/.test(e.textContent)), { timeout: 10000 });

try {
  console.log('BROWSER-SURFACE VERIFY — XMBL extension popup (real dist/popup.js in chromium)\n');
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('#shell', { timeout: 10000 });

  // ── 1) SHELL + TABS ──
  console.log('── shell & tabs ──');
  check('popup shell renders', await page.locator('#shell').count() === 1);
  check('title is XMBL Wallet', (await text('.title')).replace(/\s+/g, ' ') === 'XMBL Wallet');
  check('two tabs present (Contracts, Wallet)', await page.locator('nav.tabs .tab').count() === 2);
  check('Contracts tab is active by default', await page.locator('nav.tabs .tab.on').textContent() === 'Contracts');

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

  // ── 3) DEPLOY (content-addressed, saved to the browser.storage registry) ──
  console.log('\n── deploy ──');
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

  // ── 4) FIND (list + search filter) ──
  console.log('\n── find ──');
  check('deployed instance appears in the list', await page.locator('.inst .inst-name').first().textContent() === 'Counter');
  await page.fill('.sec input.in[placeholder*="find"]', 'counter');
  check('search by name keeps the match', await page.locator('.inst').count() === 1);
  await page.fill('.sec input.in[placeholder*="find"]', 'zzz-nomatch');
  check('search with no match hides all', await page.locator('.inst').count() === 0);
  await page.fill('.sec input.in[placeholder*="find"]', '');

  // ── 5) CALL (entrypoint → run → committed state moves; then revert leaves state unmoved) ──
  console.log('\n── call ──');
  // Counter auto-selected on deploy. count starts 0, inc() → 1.
  check('Counter committed state starts at 0', await tileValue('count') === '0', `count=${await tileValue('count')}`);
  await page.selectOption('#c-ep', 'inc');
  await page.getByRole('button', { name: /Run/ }).click();
  await waitCallResult();
  check('inc() returns and commits count → 1', (await tileValue('count')) === '1', `msg="${await callStatus()}" count=${await tileValue('count')}`);
  // incBy(41) → 42
  await page.selectOption('#c-ep', 'incBy');
  await page.fill('#arg-0', '41');
  await page.getByRole('button', { name: /Run/ }).click();
  await page.waitForFunction(() => {
    const t = [...document.querySelectorAll('.statebar .tile')].find((x) => (x.querySelector('.tk')?.textContent || '').trim().startsWith('count'));
    return t && (t.querySelector('.tv')?.textContent || '').trim() === '42';
  }, { timeout: 10000 });
  check('incBy(41) commits count → 42', (await tileValue('count')) === '42', `count=${await tileValue('count')}`);

  // Revert path: deploy Vault, over-withdraw → reverts, balance unmoved.
  await page.selectOption('.sec select.sel', 'Vault');
  await page.getByRole('button', { name: /Compile/ }).click();
  await page.waitForSelector('.idbox .v');
  await page.getByRole('button', { name: /Deploy instance/ }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.status.ok')].some((e) => /Deployed/.test(e.textContent)), { timeout: 10000 });
  const vaultEps = await page.evaluate(() => [...document.querySelectorAll('#c-ep option')].map((o) => o.value));
  const balStart = await tileValue('bal');
  if (vaultEps.includes('withdraw')) {
    await page.selectOption('#c-ep', 'withdraw');
    await page.fill('#arg-0', '999999');
    await page.getByRole('button', { name: /Run/ }).click();
    await waitCallResult();
    const msg = await callStatus();
    check('Vault over-withdraw reverts (underflow)', /reverted/.test(msg), msg);
    check('reverted call leaves bal unmoved', (await tileValue('bal')) === balStart, `before=${balStart} after=${await tileValue('bal')}`);
  } else {
    check('Vault exposes a withdraw entrypoint', false, `entrypoints: ${vaultEps.join(', ')}`);
  }

  // ── 6) WALLET tab (against the stub node bridge) ──
  console.log('\n── wallet ──');
  await page.locator('nav.tabs .tab', { hasText: 'Wallet' }).click();
  await page.waitForFunction(() => /XMBL/.test(document.querySelector('.balance-amt .amt')?.textContent || '') || document.querySelector('.balance-amt'), { timeout: 5000 }).catch(() => {});
  check('wallet balance renders (0 from stub)', (await text('.balance-amt .amt')) === '0', `balance=${await text('.balance-amt .amt')}`);
  check('node status shows stopped', (await text('.live-dot')) === 'stopped');
  await page.getByRole('button', { name: /Start node/ }).click();
  await page.waitForFunction(() => /running/.test(document.querySelector('.live-dot')?.textContent || ''), { timeout: 5000 });
  check('Start node toggles to running (stub)', (await text('.live-dot')) === 'running');

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
