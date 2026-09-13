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

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = join(HERE, '..');                       // the unpacked extension dir
const SHOTS = join(EXT, 'tests', 'screenshots');
mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
const check = (n, cond, detail = '') => { if (cond) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}${detail ? '\n       ' + detail : ''}`); fail++; } };

// MV3 service workers do not register reliably under headless, so load the extension in a headed
// context (reliable on macOS). This is still fully automated — no human interaction.
const ctx = await chromium.launchPersistentContext('', {
  headless: false,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});

const errors = [];
ctx.on('weberror', (e) => errors.push('weberror: ' + e.error().message));

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

  // The bug signature: under a bad CSP the script dies and #shell never appears.
  const mounted = await page.waitForSelector('#shell', { timeout: 10000 }).then(() => true).catch(() => false);
  await page.screenshot({ path: join(SHOTS, '01-popup-contracts.png') });
  check('popup MOUNTS the Vue app (#shell present — not a blank popup)', mounted);
  check('no CSP / console errors on popup load', consoleErrors.length === 0, consoleErrors.slice(0, 6).join(' | '));

  if (mounted) {
    check('popup title is "XMBL Wallet"', (await page.locator('.title').first().textContent() || '').replace(/\s+/g, ' ').trim() === 'XMBL Wallet');
    check('two tabs render (Contracts, Wallet)', await page.locator('nav.tabs .tab').count() === 2);
    // Wallet tab — the node bridge reports truthful DISCONNECTED (no devnet running in this test).
    await page.locator('nav.tabs .tab', { hasText: 'Wallet' }).click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(SHOTS, '02-popup-wallet.png') });
    check('Wallet tab renders a balance amount', await page.locator('.balance-amt').count() >= 1);
    // No devnet runs in this test, so the bridge truthfully reports "no devnet" (not a fake stopped/0).
    check('node status renders the truthful disconnected state ("no devnet")', /no devnet/.test(await page.locator('.live-dot').first().textContent() || ''), await page.locator('.live-dot').first().textContent());
  }

  console.log(`\nscreenshots: ${SHOTS}`);
  console.log(`${fail === 0 ? '✅ PASS' : '❌ FAIL'} — ${pass} checks, ${fail} failed (real loaded extension, real MV3 CSP)`);
} catch (e) {
  console.error('\n❌ loaded-extension verify error —', e.message);
  fail++;
} finally {
  await ctx.close();
}
process.exit(fail === 0 ? 0 : 1);
