// FULL-FEATURE CAPTIONED + VOICED SCREENCAST of the XMBL Console extension, driving the REAL unpacked
// extension (the exact popup the toolbar icon opens, under the real MV3 CSP) against a REAL LocalDevnet
// on :8646 — so every surface is live, not stubbed. A fixed caption bar at the bottom states, for each
// step: what we're DOING, what to EXPECT, and what we SAW — and the SAW line is read from the actual
// DOM after the step resolves (never pre-written), so a silent failure captions itself truthfully.
//
// A synced VOICEOVER narrates each step as a contract explainer: one clip per DOING caption (macOS
// `say`), generated up front and measured, so each step holds at least as long as its narration and
// nothing overruns. Each caption's video-relative offset is logged at RUNTIME (Date.now()−t0) — so the
// audio stays aligned even though compile/deploy/zk waits vary in length — then the clips are delayed
// to those offsets, mixed, and muxed over the silent capture into the final mp4.
//
// Covers each feature the operator asked for:
//   MAKER    — the sentence-style visual builder: rename, add stored state, author/remove a statement,
//              with the generated LNG updating live as you build (NOT a wall of inputs).
//   DEPLOYER — compile (real @xmbl/lng → WASM) then deploy a content-addressed instance.
//   FINDER   — search the on-device registry down to the contract and open it.
//   TESTER   — inline per-entrypoint Run rows: committed state tiles move; a trapping call REVERTS
//              and leaves state unmoved.
//   CRYPTO / WALLET / NODE — live against the devnet: real green zk + HE verdicts, a connected wallet
//              balance, the live ledger state root.
//
//   npm run build -w packages/browser-extension        # dist/ must exist
//   node record-demo.mjs                                # writes tests/screenshots/contract-demo.webm (+ voiced .mp4)
import { chromium } from '@playwright/test';
import { mkdirSync, readdirSync, renameSync, existsSync, rmSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalDevnet } from '../simulator/src/devnet.js';
import { DevnetRpc } from '../simulator/src/devnet-rpc.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = HERE;
const OUT = join(EXT, 'tests', 'screenshots');
mkdirSync(OUT, { recursive: true });
const VID = join(OUT, 'contract-demo.webm');
const MP4 = join(OUT, 'contract-demo.mp4');
const SILENT = join(OUT, '.contract-demo.silent.mp4');
if (existsSync(VID)) rmSync(VID);
if (existsSync(MP4)) rmSync(MP4);

const FFMPEG = '/opt/homebrew/bin/ffmpeg';
const FFPROBE = '/opt/homebrew/bin/ffprobe';
const VODIR = join(OUT, 'vo');
mkdirSync(VODIR, { recursive: true });
const VOICE = 'Samantha';
const RATE = 178; // words/min — clear, unrushed

const wait = (p, ms) => p.waitForTimeout(ms);
const durMs = (file) => Math.round(parseFloat(execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nk=1:nw=1', file], { encoding: 'utf8' }).trim()) * 1000);

// ── narration, one clip per DOING caption, in a full-explainer arc. Written in prose (code
// identifiers spelled the way `say` reads them cleanly) so it teaches contracts as the demo runs. ──
const VO = {
  open: 'Welcome to the XMBL console. A smart contract is a small program a blockchain stores and runs the same way for everyone. Let us build one, deploy it, find it, and call it — live against a real node.',
  visual: 'First, the maker. Visual mode turns the contract into plain-language sentences — not a wall of inputs. Each line is one step the contract will run.',
  rename: 'Every contract has a name. We will call ours Ticker, and the generated code updates live as we type.',
  field: 'Contracts remember values between calls in what is called stored state. We add a number field, called hits.',
  addstep: 'Inside a call we author steps. The add bar adds a Set step, assigning a value to a field, and the generated code grows by a line.',
  remove: 'It is fully editable both ways. Removing that step with its cross deletes the line, and the code shrinks back.',
  review: 'The builder has written real, valid source in XMBL contract language — the same text you could type by hand.',
  compile: 'Now the deployer. Compiling runs the real toolchain, producing WebAssembly bytecode that a node executes.',
  deploy: 'A contract identity is its content: the same source derives the same id and address on every node. We deploy that instance now.',
  search: 'The finder. Every deployed contract is saved in an on-device registry. We search it for ticker, and the list filters to our instance.',
  openc: 'Opening it reveals the call and test panel — a Run button for each entry point, and tiles showing committed state.',
  inc: 'The tester. Calling increment adds one to the counter. This is a real state change, committing from zero to one.',
  incby: 'Arguments work too. Incrementing by forty-one moves the counter to forty-two, recompiled and executed from source on every call.',
  revert: 'Contracts must fail safely. We open the Vault and withdraw far more than its balance — an underflow. The call reverts, and the committed balance stays exactly where it was.',
  crypto: 'Beyond contracts, the node exposes cryptography. The Crypto tab runs real primitives on the live devnet.',
  zk: 'A zero-knowledge proof: the node verifies an honest coordinate and rejects a tampered one — a real, green verdict.',
  he: 'Homomorphic encryption: two encrypted numbers are added while they stay encrypted, under a post-quantum scheme.',
  wallet: 'The Wallet tab shows a real balance served by the node bridge — connected, not a fabricated value.',
  node: 'And the Node tab reads the live ledger state root, and maps every module the node runs.',
  close: 'That is the full loop: make a contract, compile and deploy it, find it, and call it — with crypto, wallet, and node all live on a real network.',
};

// pre-generate + measure every clip so each step can be held at least as long as its narration.
const clip = {};
let voTotal = 0;
for (const [id, text] of Object.entries(VO)) {
  const aiff = join(VODIR, id + '.aiff');
  execFileSync('say', ['-v', VOICE, '-r', String(RATE), '-o', aiff, text]);
  clip[id] = { aiff, ms: durMs(aiff) };
  voTotal += clip[id].ms;
}
console.log(`[demo] generated ${Object.keys(clip).length} voiceover clips, ${(voTotal / 1000).toFixed(1)}s of narration`);

// ── ensure a REAL devnet is live on the extension's default port (8646), so the popup connects on
// open with no reconfiguration shown on screen. If the operator already has one running there
// (`npm run devnet -w packages/simulator`), REUSE it; otherwise stand up our own. Either way the
// recording shows the extension talking to a live devnet on its documented default. ──
const reachable8646 = await fetch('http://127.0.0.1:8646', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'getNodeStatus' }),
}).then((r) => r.ok).catch(() => false);
let net = null, rpc = null;
if (reachable8646) {
  console.log('[demo] reusing the devnet already running on :8646');
} else {
  net = await new LocalDevnet({ identities: 3 }).start();
  rpc = new DevnetRpc(net, { walletIndex: 0 });
  await rpc.listen(8646);
  console.log('[demo] started a devnet on :8646 for the recording');
}

const ctx = await chromium.launchPersistentContext('', {
  headless: false,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  viewport: { width: 480, height: 980 },
  recordVideo: { dir: OUT, size: { width: 480, height: 980 } },
});

let videoPath = null;
let t0 = 0;
const timeline = []; // { id, at } — at = ms from video start when this clip's caption appeared
try {
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 10000 }).catch(() => null);
  const extId = sw ? new URL(sw.url()).host : null;
  if (!extId) throw new Error('no extension service worker — build dist/ first');

  const page = await ctx.newPage();
  videoPath = await page.video().path();
  t0 = Date.now(); // video recording begins at page creation; measure caption offsets from here
  page.on('pageerror', (e) => console.error('  pageerror —', e.message));
  await page.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#shell', { timeout: 10000 });

  // ── caption bar: DOING / EXPECT / SAW, fixed at the viewport bottom; reserves its own space ──
  const setCap = (doing, expect, saw, sawKind) => page.evaluate(({ doing, expect, saw, sawKind }) => {
    let bar = document.getElementById('demo-cap');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'demo-cap';
      bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:99999;background:oklch(16% 0 0);color:oklch(93% 0 0);font:13px/1.55 -apple-system,system-ui,sans-serif;padding:11px 15px;border-top:2px solid oklch(84% .19 80);box-shadow:0 -6px 20px rgba(0,0,0,.45);min-height:74px;box-sizing:border-box';
      bar.innerHTML = '<div style="margin-bottom:2px"><b style="color:oklch(84% .19 80);font:600 10px/1 ui-monospace,monospace;letter-spacing:.14em">DOING </b><span id="cap-do"></span></div>'
        + '<div style="margin-bottom:2px"><b style="color:oklch(70% .12 188);font:600 10px/1 ui-monospace,monospace;letter-spacing:.14em">EXPECT </b><span id="cap-exp"></span></div>'
        + '<div><b style="color:oklch(58% 0 0);font:600 10px/1 ui-monospace,monospace;letter-spacing:.14em">SAW </b><span id="cap-saw"></span></div>';
      document.body.appendChild(bar);
      document.body.style.paddingBottom = '120px';
    }
    document.getElementById('cap-do').textContent = doing || '';
    document.getElementById('cap-exp').textContent = expect || '';
    const s = document.getElementById('cap-saw');
    s.textContent = saw == null ? '…' : saw;
    s.style.color = sawKind === 'ok' ? 'oklch(78% .16 150)' : sawKind === 'bad' ? 'oklch(74% .17 26)' : 'oklch(72% 0 0)';
  }, { doing, expect, saw, sawKind });

  const PAD = 550; // ms of quiet after a clip finishes before the step's action proceeds
  // mark: log this caption's video-relative start and return the narration length to hold for
  const mark = (id) => { timeline.push({ id, at: Math.max(0, Date.now() - t0) }); return clip[id] ? clip[id].ms : 0; };
  // a narrated step: show DOING/EXPECT, start the voiceover, hold until it finishes (min floor for readability)
  const step = async (id, doing, expect, floor = 3200) => { await setCap(doing, expect, null); const ms = mark(id); await wait(page, Math.max(floor, ms + PAD)); };
  const saw = async (doing, expect, sawText, kind = 'ok', hold = 2800) => { await setCap(doing, expect, sawText, kind); await wait(page, hold); };
  const show = async (sel) => { await page.locator(sel).first().scrollIntoViewIfNeeded().catch(() => {}); await wait(page, 350); };
  const tileVal = (name) => page.evaluate((n) => { const t = [...document.querySelectorAll('.statebar .tile')].find((x) => (x.querySelector('.tile-k')?.textContent || '').trim().startsWith(n)); return t ? (t.querySelector('.tile-v')?.textContent || '').trim() : null; }, name);
  const lngText = () => page.evaluate(() => (document.querySelector('.builder .src-preview pre')?.textContent || '').trim());
  const lastTrace = () => page.evaluate(() => (document.querySelector('.trace .tline')?.textContent || '').trim());
  const liveDot = () => page.evaluate(() => { const d = [...document.querySelectorAll('.live-dot')].find((e) => e.offsetParent !== null); return d ? (d.textContent || '').trim() : ''; });
  const callRow = (ep) => page.locator('.call-row').filter({ has: page.locator('.ep', { hasText: new RegExp('^' + ep + '$') }) });
  const runEp = async (ep, args = []) => { const r = callRow(ep); const ins = r.locator('.arg'); for (let i = 0; i < args.length; i++) await ins.nth(i).fill(String(args[i])); await r.getByRole('button', { name: /Run/ }).click(); };

  // opening — narrated
  await setCap('Opening the XMBL Console extension popup', 'The five-tab console mounts, Contracts active, devnet reachable', null);
  { const ms = mark('open'); await wait(page, Math.max(4800, ms + 700)); }

  // ════ MAKER — the sentence-style visual builder ════
  await step('visual', 'Switching the builder to Visual mode', 'A sentence-style editor — NOT a wall of inputs: each step reads as a phrase');
  await page.locator('.seg-b', { hasText: 'Visual' }).click();
  await page.waitForSelector('.builder .src-preview pre', { timeout: 8000 });
  await show('.builder .name-row');
  {
    const stmts = await page.locator('.builder .stmt-list .stmt').count();
    await saw('Switched the builder to Visual mode', 'A sentence-style editor — NOT a wall of inputs', `${stmts} editable statement rows render as phrases, with a live LNG preview below`);
  }

  await step('rename', 'Renaming the contract to “Ticker” in the builder', 'The generated LNG header updates live');
  { const nm = page.locator('.builder .in.cname'); await nm.scrollIntoViewIfNeeded(); await nm.click(); await wait(page, 300); await nm.fill('Ticker'); }
  await wait(page, 900);
  { const lng = await lngText(); await saw('Renamed the contract to “Ticker”', 'The generated LNG header updates live', (lng.split('\n')[0] || '').trim()); }

  await step('field', 'Adding a stored-state field and naming it “hits”', 'A new “starts at” row appears and the LNG gains the field');
  await page.locator('.builder .vb-sec', { hasText: 'Stored state' }).getByRole('button', { name: /\+ field/ }).click();
  await wait(page, 700);
  { const row = page.locator('.builder .vb-sec', { hasText: 'Stored state' }).locator('.vb-row').last(); const nm = row.locator('.in.name'); await nm.scrollIntoViewIfNeeded(); await nm.click(); await wait(page, 300); await nm.fill('hits'); }
  await wait(page, 900);
  { const lng = await lngText(); await saw('Added a stored-state field “hits”', 'The LNG gains the field', /hits/.test(lng) ? '`hits is now part of the contract’s stored state' : 'field added', /hits/.test(lng) ? 'ok' : 'bad'); }

  await step('addstep', 'Authoring a new step in a call via the labeled add-bar', 'Click “+ Set” and a new editable statement row appears; the LNG grows');
  await show('.builder .method');
  { const before = (await lngText()).split('\n').length; await page.locator('.builder .method').first().locator('.add-bar .add', { hasText: '+ Set' }).click(); await page.waitForFunction((b) => ((document.querySelector('.builder .src-preview pre')?.textContent || '').split('\n').length) > b, before, { timeout: 6000 }); const after = (await lngText()).split('\n').length; await saw('Authored a new “Set” step', 'A new editable row appears; the LNG grows', `generated LNG grew from ${before} to ${after} lines as the step was added`); }

  await step('remove', 'Removing that step again with its × control', 'The builder deletes the row and the LNG shrinks back — fully editable, both ways');
  { const before = (await lngText()).split('\n').length; await page.locator('.builder .method').first().locator('.stmt-list > .stmt').last().locator('.x').click(); await page.waitForFunction((b) => ((document.querySelector('.builder .src-preview pre')?.textContent || '').split('\n').length) < b, before, { timeout: 6000 }); const after = (await lngText()).split('\n').length; await saw('Removed the step', 'The LNG shrinks back — editable both ways', `generated LNG shrank from ${before} back to ${after} lines`); }

  await step('review', 'Reviewing the live “Generated LNG” preview', 'The builder has written valid LNG source for the Ticker contract');
  await show('.builder .src-preview');
  { const lng = await lngText(); await saw('Reviewed the generated LNG', 'The builder wrote valid LNG source', `${lng.split('\n').length} lines of LNG, headed “${(lng.split('\n')[0] || '').trim()}”`); }

  // ════ DEPLOYER — compile then deploy a content-addressed instance ════
  await step('compile', 'Compiling the authored contract with the real @xmbl/lng toolchain', 'A “Compiled · N entrypoints …” status, proving real bytecode');
  await page.getByRole('button', { name: /Compile/ }).click();
  await page.waitForFunction(() => /Compiled/.test(document.querySelector('.status.ok')?.textContent || ''), { timeout: 10000 });
  await show('.status.ok');
  { const st = await page.locator('.status.ok').first().textContent(); await saw('Compiled the contract (real @xmbl/lng → WASM)', 'A “Compiled …” status proving real bytecode', (st || '').trim()); }

  await step('deploy', 'Deploying a content-addressed instance', 'An id (xc1_…) and cube address a node derives identically, saved on this device');
  await show('.idbox');
  { const id = (await page.locator('.idbox .idrow').first().locator('.v').textContent() || '').trim(); await saw('Read the content-addressed identity', 'A node-identical xc1_ id + cube', `id ${id.slice(0, 24)}…`); }
  await page.getByRole('button', { name: /Deploy instance/ }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.status.ok')].some((e) => /Deployed/.test(e.textContent)), { timeout: 10000 });
  { const st = await page.evaluate(() => [...document.querySelectorAll('.status.ok')].map((e) => e.textContent.trim()).find((t) => /Deployed/.test(t))); await saw('Deployed the instance', 'A genesis instance is committed on this device', (st || '').trim()); }

  // ════ FINDER — search the registry and open the contract ════
  await step('search', 'Finding the contract: typing “ticker” into the registry search', 'The on-device registry filters down to the Ticker instance');
  const find = page.locator('.sec input.in[placeholder*="find"]');
  await find.scrollIntoViewIfNeeded();
  await find.fill('');
  await find.type('ticker', { delay: 110 });
  await page.waitForTimeout(700);
  { const names = await page.locator('.inst .inst-name').allTextContents(); await saw('Searched the registry for “ticker”', 'The list filters to the match', `${names.length} match: ${names.join(', ')}`, names.length ? 'ok' : 'bad'); }
  await step('openc', 'Opening the found contract to interact with it', 'Its Call & Test panel opens with committed state tiles');
  await page.locator('.inst', { hasText: 'Ticker' }).first().locator('.inst-main').click();
  await page.waitForSelector('.call-row', { timeout: 8000 });
  { const eps = await page.locator('.call-row .ep').allTextContents(); await saw('Opened the contract', 'A Run row per entrypoint + committed-state tiles', `${eps.length} entrypoints to call: ${eps.map((s) => s.trim()).join(', ')}`); }

  // ════ TESTER — inline Run rows; committed state moves; a trapping call reverts ════
  await step('inc', 'Testing: running inc() with its inline Run button', 'count commits from 0 → 1 and the state tile flashes');
  await show('.statebar');
  await runEp('inc');
  await page.waitForFunction(() => { const t = [...document.querySelectorAll('.statebar .tile')].find((x) => (x.querySelector('.tile-k')?.textContent || '').trim().startsWith('count')); return t && (t.querySelector('.tile-v')?.textContent || '').trim() === '1'; }, { timeout: 10000 });
  { const c = await tileVal('count'); const tr = await lastTrace(); await saw('Ran inc()', 'count commits 0 → 1', `committed count = ${c} · trace: ${tr}`, c === '1' ? 'ok' : 'bad'); }

  await step('incby', 'Running incBy(41)', 'count commits 1 → 42 — real committed state, recompiled from source each call');
  await runEp('incBy', [41]);
  await page.waitForFunction(() => { const t = [...document.querySelectorAll('.statebar .tile')].find((x) => (x.querySelector('.tile-k')?.textContent || '').trim().startsWith('count')); return t && (t.querySelector('.tile-v')?.textContent || '').trim() === '42'; }, { timeout: 10000 });
  { const c = await tileVal('count'); await saw('Ran incBy(41)', 'count commits 1 → 42', `committed count = ${c}`, c === '42' ? 'ok' : 'bad'); }

  await step('revert', 'Demonstrating a REVERT: finding Vault and over-withdrawing', 'A trapping underflow reverts; committed balance must stay unmoved');
  await find.fill('');
  await find.type('vault', { delay: 100 });
  await page.waitForTimeout(500);
  await page.locator('.inst', { hasText: 'Vault' }).first().locator('.inst-main').click();
  await page.waitForSelector('.call-row', { timeout: 8000 });
  await show('.statebar');
  const balStart = await tileVal('bal');
  await saw('Opened Vault (balance before the trapping call)', 'Note the committed balance — it must not move on a revert', `bal = ${balStart}`, 'ok', 1600);
  await runEp('withdraw', [999999]);
  await page.waitForFunction(() => /reverted/.test(document.querySelector('.trace .tline')?.textContent || ''), { timeout: 10000 });
  { const tr = await lastTrace(); const balEnd = await tileVal('bal'); await saw('Ran withdraw(999999) — an over-withdraw', 'It reverts and leaves committed bal unmoved', `${tr} · bal still ${balEnd} (was ${balStart})`, balEnd === balStart ? 'ok' : 'bad', 2600); }

  // ════ CRYPTO — live host-capability verdicts against the real devnet ════
  await step('crypto', 'Opening the Crypto tab (host capabilities, run on the live devnet)', 'Connected to the devnet; the zk / HE cards are enabled, not “no devnet”');
  await page.locator('nav.tabs .tab', { hasText: 'Crypto' }).click();
  await page.waitForTimeout(700);
  { const d = await liveDot(); await saw('Opened the Crypto tab', 'Connected to the live devnet', d, /no devnet/.test(d) ? 'bad' : 'ok'); }

  await step('zk', 'Running the coordinate/curve zero-knowledge proof on the node', 'A REAL green verdict: the honest coordinate verifies, a tampered one is rejected');
  await page.locator('.cap', { hasText: 'Coordinate' }).getByRole('button', { name: /Prove/ }).click();
  await page.locator('.cap', { hasText: 'Coordinate' }).locator('.verdict.ok').waitFor({ timeout: 15000 });
  { const v = (await page.locator('.cap', { hasText: 'Coordinate' }).locator('.verdict').first().textContent() || '').trim(); await saw('Ran the zk coordinate proof on the devnet', 'A REAL green verdict (honest verifies, tampered rejected)', v.slice(0, 120)); }

  await step('he', 'Running the homomorphic encrypted add on the node', 'A REAL green verdict: ciphertexts summed blind, under the post-quantum scheme');
  await page.locator('.cap', { hasText: 'Encrypted add' }).getByRole('button', { name: /Add under/ }).click();
  await page.locator('.cap', { hasText: 'Encrypted add' }).locator('.verdict.ok').waitFor({ timeout: 15000 });
  { const v = (await page.locator('.cap', { hasText: 'Encrypted add' }).locator('.verdict').first().textContent() || '').trim(); await saw('Ran the homomorphic encrypted add on the devnet', 'A REAL green verdict (blind ciphertext add)', v.slice(0, 120)); }

  // ════ WALLET — live balance / status against the devnet ════
  await step('wallet', 'Opening the Wallet tab (served by the real node bridge)', 'A real balance from the devnet and a connected status — not a fabricated value');
  await page.locator('nav.tabs .tab', { hasText: 'Wallet' }).click();
  await page.waitForTimeout(800);
  { const d = await liveDot(); const bal = await page.evaluate(() => (document.querySelector('.balance-amt .amt')?.textContent || '').trim()); await saw('Opened the Wallet tab', 'Connected, real balance from the devnet', `balance ${bal} · status ${d}`, /no devnet/.test(d) ? 'bad' : 'ok'); }

  // ════ NODE — live ledger state root + module map ════
  await step('node', 'Opening the Node tab', 'The live ledger state root reads a real value and the module map lists every xmbl part');
  await page.locator('nav.tabs .tab', { hasText: 'Node' }).click();
  await page.waitForTimeout(800);
  await show('.rootbox');
  { const root = await page.evaluate(() => (document.querySelector('.rootbox')?.textContent || '').replace(/\s+/g, ' ').trim()); const mods = await page.locator('.mod').count(); await saw('Opened the Node tab', 'A live state root + the full module map', `${mods} modules mapped · ${root.slice(0, 90)}`, /connect a devnet/.test(root) ? 'bad' : 'ok', 2600); }

  // closing — narrated
  await setCap('Walkthrough complete', 'Maker · Deployer · Finder · Tester · Crypto · Wallet · Node — all live on a real devnet', 'Every surface exercised against real bytecode and a real node', 'ok');
  { const ms = mark('close'); await wait(page, Math.max(4800, ms + 700)); }

  console.log('recorded the full maker → deployer → finder → tester → crypto → wallet → node walkthrough');
} catch (e) {
  console.error('record error —', e.message);
} finally {
  await ctx.close(); // finalizes the video file
  // Only tear down a devnet WE started — never the operator's reused :8646 devnet.
  try { if (rpc) await rpc.close(); } catch { /* ignore */ }
  try { if (net) await net.dispose(); } catch { /* ignore */ }
}

// Playwright names the file with a random id; rename to a meaningful one, then convert to mp4.
if (videoPath && existsSync(videoPath)) renameSync(videoPath, VID);
else { const webm = readdirSync(OUT).filter((f) => f.endsWith('.webm') && f !== 'contract-demo.webm'); if (webm.length) renameSync(join(OUT, webm[0]), VID); }

if (!existsSync(VID)) { console.log('\n❌ no video produced'); process.exit(1); }

// 1) silent mp4 (scaled) as an intermediate
if (existsSync(SILENT)) rmSync(SILENT);
const conv = spawnSync(FFMPEG, ['-y', '-i', VID, '-vf', 'scale=480:-2', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', SILENT], { encoding: 'utf8' });
if (conv.status !== 0) { console.log(`\n✅ recording: ${VID}\n(ffmpeg mp4 conversion failed: ${(conv.stderr || '').split('\n').slice(-2).join(' ')})`); process.exit(0); }

// 2) build + mux the voiceover: delay each clip to its logged offset, mix, lay over the silent video.
const videoMs = durMs(SILENT);
if (timeline.length) {
  const inputs = [];
  const parts = [];
  const labels = [];
  timeline.forEach((e, i) => {
    inputs.push('-i', clip[e.id].aiff);
    parts.push(`[${i + 1}:a]adelay=${e.at}|${e.at}[a${i}]`); // input 0 is the video; clips are 1..N
    labels.push(`[a${i}]`);
  });
  const filter = `${parts.join(';')};${labels.join('')}amix=inputs=${timeline.length}:normalize=0:dropout_transition=0,apad,atrim=0:${(videoMs / 1000).toFixed(2)}[vo]`;
  const mux = spawnSync(FFMPEG, ['-y', '-i', SILENT, ...inputs, '-filter_complex', filter, '-map', '0:v', '-map', '[vo]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-shortest', MP4], { encoding: 'utf8' });
  if (mux.status === 0 && existsSync(MP4)) {
    rmSync(SILENT);
    const finalMs = durMs(MP4);
    const overCap = finalMs > 300000;
    console.log(`\n✅ recording: ${VID}\n✅ voiced mp4: ${MP4}  (${(finalMs / 1000).toFixed(1)}s${overCap ? ' — OVER 5:00 CAP' : ', under 5:00'}, ${timeline.length} narration cues)`);
    process.exit(overCap ? 2 : 0);
  }
  console.log(`\n(voiceover mux failed: ${(mux.stderr || '').split('\n').slice(-3).join(' ')})`);
}
// fallback: keep the silent mp4 as the deliverable
renameSync(SILENT, MP4);
console.log(`\n✅ recording: ${VID}\n✅ mp4 (silent — voiceover step failed): ${MP4}`);
process.exit(0);
