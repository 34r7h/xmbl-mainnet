// FAITHFUL "click the icon" verification: loads the REAL unpacked extension into chromium (so the
// real MV3 extension-page CSP applies — the exact environment the Playwright popup-harness does NOT
// reproduce), opens popup.html as the extension serves it, captures any console/page error
// (a CSP eval/WASM violation shows up here), screenshots both tabs, and asserts the Vue app mounted.
// This is what catches "nothing happens when I click the icon": a blank popup leaves #shell absent.
//
//   node tests/verify-extension-loaded.mjs   (run by `npm run verify:extension` after the build)
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { LocalDevnet } from '../../simulator/src/devnet.js';
import { DevnetRpc } from '../../simulator/src/devnet-rpc.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = join(HERE, '..');                       // the unpacked extension dir
const SHOTS = join(EXT, 'tests', 'screenshots');
mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
const check = (n, cond, detail = '') => { if (cond) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}${detail ? '\n       ' + detail : ''}`); fail++; } };

// An OS-assigned free loopback port (bind → read → release). Used so this verify never collides with
// whatever a developer is already running on the extension's default 8646 (e.g. `npm run devnet`):
// the OFFLINE phase points the extension at a port nothing serves, and the CONNECTED phase binds its
// own devnet on a second OS-assigned port and repoints the extension there. Fully independent of 8646.
const freePort = () => new Promise((res, rej) => {
  const s = createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});
// Repoint the loaded extension's bridge at `url` through the REAL persistence path (the background's
// setDevnetUrl message updates its live in-memory devnetUrl AND storage) so a reload re-probes there.
const repoint = async (page, url) => page.evaluate((u) => chrome.runtime.sendMessage({ type: 'setDevnetUrl', url: u }), url);

// MV3 service workers do not register reliably under headless, so load the extension in a headed
// context (reliable on macOS). This is still fully automated — no human interaction.
const ctx = await chromium.launchPersistentContext('', {
  headless: false,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});

const errors = [];
ctx.on('weberror', (e) => errors.push('weberror: ' + e.error().message));
let net = null, rpc = null; // a real devnet stood up for the connected phase

try {
  // Find the extension id from its MV3 service worker (dist/background.js).
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 10000 }).catch(() => null);
  const extId = sw ? new URL(sw.url()).host : null;
  check('extension service worker registered (background.js loaded)', !!extId, `workers: ${ctx.serviceWorkers().map((w) => w.url()).join(', ')}`);
  if (!extId) throw new Error('no extension service worker — manifest/background failed to load');

  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

  // Open the popup exactly as the toolbar icon does.
  const popupUrl = `chrome-extension://${extId}/popup.html`;
  await page.goto(popupUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#shell', { timeout: 10000 }).catch(() => {});

  // The extension's DOCUMENTED default endpoint must be :8646 — storage is empty on this fresh temp
  // profile, so the bridge's resolved URL here IS the runtime default (Config.vue DEFAULT +
  // background.js DEFAULT_DEVNET_URL). This pins it to match packages/simulator/src/devnet-run.mjs's
  // default port: if either side drifts, `npm run devnet` silently stops serving the loaded
  // extension (the operator's original "devnet not reachable by the extension" failure). Read BEFORE
  // the repoint below overwrites it.
  const resolvedDefault = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'getDevnetUrl' }));
  check('extension resolves its documented default endpoint :8646 (matches `npm run devnet`)', /127\.0\.0\.1:8646/.test((resolvedDefault && resolvedDefault.url) || ''), resolvedDefault && resolvedDefault.url);

  // OFFLINE PHASE SETUP — point the bridge at a port nothing serves, so the "no devnet" assertions
  // below are truthful regardless of whether a devnet (e.g. `npm run devnet` on 8646) is already up
  // on this machine. Reload so every tab re-probes the dead endpoint on mount.
  const deadPort = await freePort();
  await repoint(page, `http://127.0.0.1:${deadPort}`);
  await page.reload({ waitUntil: 'domcontentloaded' });

  // The bug signature: under a bad CSP the script dies and #shell never appears.
  const mounted = await page.waitForSelector('#shell', { timeout: 10000 }).then(() => true).catch(() => false);
  await page.screenshot({ path: join(SHOTS, '01-popup-contracts.png') });
  check('popup MOUNTS the Vue app (#shell present — not a blank popup)', mounted);
  check('no CSP / console errors on popup load', consoleErrors.length === 0, consoleErrors.slice(0, 6).join(' | '));

  if (mounted) {
    check('popup title is "XMBL Console"', (await page.locator('.title').first().textContent() || '').replace(/\s+/g, ' ').trim() === 'XMBL Console');
    const tabNames = await page.locator('nav.tabs .tab').allTextContents();
    check('five tabs render (Contracts, Crypto, Wallet, Node, Config)', tabNames.join(',') === 'Contracts,Crypto,Wallet,Node,Config', tabNames.join(','));

    // Contracts — seeded on first open so the Find list is POPULATED and search has hits (the
    // operator's named failure: an empty list made search look broken).
    await page.waitForSelector('.inst', { timeout: 15000 }).catch(() => {}); // one-time sample seed compiles + deploys in-page
    const deployed = await page.locator('.inst').count();
    check('Contracts tab is seeded with the sample set (Find list populated)', deployed >= 5, `instances=${deployed}`);
    await page.locator('.sec input.in[placeholder^="find"]').fill('vault');
    await page.waitForTimeout(200);
    check('search filters the deployed contracts (a query returns a hit)', await page.locator('.inst').count() === 1, `matches=${await page.locator('.inst').count()}`);
    await page.locator('.sec input.in[placeholder^="find"]').fill('');
    // Visual builder — the sentence-style statement editor (not a read-only body preview).
    await page.locator('.seg-b', { hasText: 'Visual' }).click();
    await page.waitForSelector('.builder .src-preview pre', { timeout: 8000 });
    check('visual builder renders editable statement rows (the prose maker)', await page.locator('.builder .stmt-list .stmt').count() >= 1, `stmts=${await page.locator('.builder .stmt-list .stmt').count()}`);
    check('visual builder shows no read-only "advanced body" fallback for the sample', await page.locator('.builder .advanced').count() === 0);
    check('visual builder shows the live generated-LNG preview', /~contract/.test((await page.locator('.builder .src-preview pre').first().textContent() || '')));
    await page.locator('.seg-b', { hasText: 'Code' }).click();
    await page.screenshot({ path: join(SHOTS, '01-popup-contracts.png') });

    // TESTER (the operator named it by hand) under the real MV3 CSP — the inline call/test surface
    // runs in-page over the real @xmbl/lng WASM (no devnet), so this pins that WASM execute path in
    // the loaded extension, not just the harness: select Counter, run inc(), assert the committed
    // state tile moves 0 → 1 and the run trace records the call.
    await page.locator('.inst .inst-main', { hasText: 'Counter' }).first().click();
    await page.waitForSelector('.call-row', { timeout: 8000 });
    const beforeCount = (await page.locator('.state-grid .tile-v').first().textContent() || '').trim();
    await page.locator('.call-row', { has: page.locator('.ep', { hasText: /^inc$/ }) }).first().locator('.btn.sm', { hasText: 'Run' }).click();
    await page.waitForSelector('.trace .tline', { timeout: 8000 });
    const afterCount = (await page.locator('.state-grid .tile-v').first().textContent() || '').trim();
    check('inline tester executes a call under real CSP (inc commits count 0 → 1)', beforeCount === '0' && afterCount === '1', `before=${beforeCount} after=${afterCount}`);
    check('inline tester records the call in the run trace', await page.locator('.trace .tline').count() >= 1);
    await page.screenshot({ path: join(SHOTS, '01b-popup-tester.png') });

    // Crypto — no devnet runs here, so the host-cap surface truthfully shows "no devnet" and
    // disables Run (it never fabricates a green verdict).
    await page.locator('nav.tabs .tab', { hasText: 'Crypto' }).click();
    await page.waitForTimeout(300);
    check('Crypto tab renders the four host-capability cards', await page.locator('.cap').count() === 4, `caps=${await page.locator('.cap').count()}`);
    check('Crypto shows truthful "no devnet" (no fabricated verdict)', /no devnet/.test(await page.locator('.live-dot:visible').first().textContent() || ''));
    check('Crypto Run buttons are disabled with no devnet', await page.locator('.cap .btn.primary[disabled]').count() === 4);
    await page.screenshot({ path: join(SHOTS, '02-popup-crypto.png') });

    // Wallet — truthful DISCONNECTED (no devnet running in this test).
    await page.locator('nav.tabs .tab', { hasText: 'Wallet' }).click();
    await page.waitForTimeout(400);
    check('Wallet tab renders a balance amount', await page.locator('.balance-amt').count() >= 1);
    check('Wallet node status renders the truthful disconnected state ("no devnet")', /no devnet/.test(await page.locator('.live-dot:visible').first().textContent() || ''), await page.locator('.live-dot:visible').first().textContent());
    await page.screenshot({ path: join(SHOTS, '03-popup-wallet.png') });

    // Node — the module map lists every xmbl part; status is truthful disconnected.
    await page.locator('nav.tabs .tab', { hasText: 'Node' }).click();
    await page.waitForTimeout(300);
    check('Node tab lists the xmbl module map', await page.locator('.mod').count() >= 10, `modules=${await page.locator('.mod').count()}`);
    check('Node status is truthful "no devnet"', /no devnet/.test(await page.locator('.live-dot:visible').first().textContent() || ''));
    await page.screenshot({ path: join(SHOTS, '04-popup-node.png') });

    // Config — the devnet endpoint field defaults to loopback.
    await page.locator('nav.tabs .tab', { hasText: 'Config' }).click();
    await page.waitForTimeout(300);
    check('Config tab documents the loopback default (8646 placeholder)', /127\.0\.0\.1:8646/.test(await page.locator('#cfg-url').getAttribute('placeholder') || ''));
    check('Config tab round-trips the saved endpoint from storage', (await page.locator('#cfg-url').inputValue() || '').includes(`127.0.0.1:${deadPort}`), await page.locator('#cfg-url').inputValue());
    await page.screenshot({ path: join(SHOTS, '05-popup-config.png') });

    // ── CONNECTED PHASE — stand up a REAL devnet on an OS-assigned loopback port (never hardcoded
    // 8646, so this coexists with a developer's own `npm run devnet`), repoint the extension at it
    // through the real Config persistence path, and prove the crypto host-cap surface and wallet
    // produce REAL results in the loaded extension, with a green verdict screenshot. This is the
    // "use zk / HE" proof, not just the offline surface. ──
    net = await new LocalDevnet({ identities: 3 }).start();
    rpc = new DevnetRpc(net, { walletIndex: 0 });
    const devPort = await rpc.listen(0);
    await repoint(page, `http://127.0.0.1:${devPort}`);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#shell', { timeout: 10000 });

    await page.locator('nav.tabs .tab', { hasText: 'Crypto' }).click();
    await page.waitForTimeout(600); // onMounted reachability probe → connected
    check('Crypto connects to the live devnet', /devnet/.test(await page.locator('.live-dot:visible').first().textContent() || '') && !/no devnet/.test(await page.locator('.live-dot:visible').first().textContent() || ''));
    // Run the coordinate/curve zk proof against the real devnet and assert a REAL green verdict.
    await page.locator('.cap', { hasText: 'Coordinate' }).getByRole('button', { name: /Prove/ }).click();
    const zkOk = await page.locator('.cap', { hasText: 'Coordinate' }).locator('.verdict.ok').waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
    check('zk host-cap produces a REAL green verdict against the devnet', zkOk);
    // Run the homomorphic add too.
    await page.locator('.cap', { hasText: 'Encrypted add' }).getByRole('button', { name: /Add under/ }).click();
    const heOk = await page.locator('.cap', { hasText: 'Encrypted add' }).locator('.verdict.ok').waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
    check('HE host-cap produces a REAL green verdict against the devnet', heOk);
    await page.screenshot({ path: join(SHOTS, '06-popup-crypto-connected.png') });

    // Wallet against the live devnet — balance is real (0), status connected.
    await page.locator('nav.tabs .tab', { hasText: 'Wallet' }).click();
    await page.waitForTimeout(600);
    check('Wallet connects to the live devnet (not "no devnet")', !/no devnet/.test(await page.locator('.live-dot:visible').first().textContent() || ''), await page.locator('.live-dot:visible').first().textContent());
    await page.screenshot({ path: join(SHOTS, '07-popup-wallet-connected.png') });

    // Node against the live devnet — the state root reads a real value.
    await page.locator('nav.tabs .tab', { hasText: 'Node' }).click();
    await page.waitForTimeout(600);
    check('Node reads the live state root (not the connect prompt)', !/connect a devnet/.test(await page.locator('.rootbox').first().textContent() || ''), await page.locator('.rootbox').first().textContent());
    await page.screenshot({ path: join(SHOTS, '08-popup-node-connected.png') });
  }

  console.log(`\nscreenshots: ${SHOTS}`);
  console.log(`${fail === 0 ? '✅ PASS' : '❌ FAIL'} — ${pass} checks, ${fail} failed (real loaded extension, real MV3 CSP)`);
} catch (e) {
  console.error('\n❌ loaded-extension verify error —', e.message);
  fail++;
} finally {
  await ctx.close();
  try { if (rpc) await rpc.close(); } catch { /* ignore */ }
  try { if (net) await net.dispose(); } catch { /* ignore */ }
}
process.exit(fail === 0 ? 0 : 1);
