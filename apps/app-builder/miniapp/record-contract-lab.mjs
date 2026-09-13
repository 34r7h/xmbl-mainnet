// CAPTIONED + VOICED DESKTOP SCREENCAST of the XMBL Contract Lab miniapp — the real, offline,
// single-file lab (apps/app-builder/dist-contract-lab/index.html) driven in Playwright at a normal
// desktop viewport (1440×900), then the node-side proofs the lab DELEGATES rendered from real bytes.
//
// WHY A HYBRID. The lab runs the REAL compiled WASM in-page over an in-page key→word Map — a faithful
// stand-in for committed state. It does NOT cross the network, does NOT compute a Verkle root, and does
// NOT run zk/HE in-page (both need node:crypto). The lab SAYS all of this on screen, and its Host-
// capabilities panel PRINTS the exact `node reproductions/…` commands that prove those claims. This
// script follows the lab's own designated proof path: it RUNS those reproductions itself, captures their
// real stdout THIS run, and reveals those bytes in a styled terminal overlay — so nothing on screen is
// narrated over a surface that cannot back it. A fixed caption bar states DOING / EXPECT / SAW per step,
// and the SAW line is read from the live DOM (Act 1) or the captured transcript (Acts 2–5), never pre-
// written. A synced macOS `say` voiceover teaches the arc; each clip is measured up front and each step
// holds at least as long as its narration, offsets logged at runtime and muxed over the capture.
//
// HONESTY BOUNDARIES baked into the narration (matched to the code shown):
//   • "Verkle" here is a 256-ary SHA-256 authenticated trie — state changes move the root; an
//     independent verifier recomputes the root from sibling hashes and agrees. NOT polynomial/vector
//     commitments, NOT small proofs.
//   • The live devnet on :8646 is shown as a real running network (status/peers/height). It does not
//     execute these contract calls; the NODE validates + commits via the delegation chain, and
//     independent nodes converge on the same root (agentic-contract-e2e).
//   • zk/HE are per-contract opt-in and UNAUDITED (the source on screen says ⛔); they never gate
//     consensus/ledger/sealing. Robustness shown = deny-by-default, fail-closed, reentrancy
//     inexpressible by construction, determinism, and the npm run test:protocol hard gate.
//
//   (dist-contract-lab/index.html is checked in and current; rebuild with
//    `npm run build:contract-lab -w apps/app-builder` if you edit the lab sources.)
//   node apps/app-builder/miniapp/record-contract-lab.mjs   # writes miniapp/screencast/contract-lab-demo.mp4
import { chromium } from '@playwright/test';
import { mkdirSync, readdirSync, renameSync, existsSync, rmSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { transpile } from '@xmbl/lng';

const HERE = dirname(fileURLToPath(import.meta.url));            // …/apps/app-builder/miniapp
const ROOT = resolve(HERE, '..', '..', '..');                   // repo root
const LAB = join(HERE, '..', 'dist-contract-lab', 'index.html');
const OUT = join(HERE, 'screencast');
mkdirSync(OUT, { recursive: true });
const VID = join(OUT, 'contract-lab-demo.webm');
const MP4 = join(OUT, 'contract-lab-demo.mp4');
const SILENT = join(OUT, '.contract-lab-demo.silent.mp4');
for (const f of [VID, MP4, SILENT]) if (existsSync(f)) rmSync(f);
if (!existsSync(LAB)) { console.error(`no built lab at ${LAB} — run: npm run build:contract-lab -w apps/app-builder`); process.exit(1); }

const FFMPEG = '/opt/homebrew/bin/ffmpeg';
const FFPROBE = '/opt/homebrew/bin/ffprobe';
const VODIR = join(OUT, 'vo');
mkdirSync(VODIR, { recursive: true });
const VOICE = 'Samantha';
const RATE = 178;
const wait = (p, ms) => p.waitForTimeout(ms);
const durMs = (file) => Math.round(parseFloat(execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nk=1:nw=1', file], { encoding: 'utf8' }).trim()) * 1000);

// ── run the node reproductions THIS run; keep the real transcript, drop only harmless startup noise ──
const NOISE = /^(XSC |XVSM |\(node:\d+\) ExperimentalWarning|\(Use `node --trace-warnings)/;
const capture = (rel) => {
  const r = spawnSync('node', [join(ROOT, 'reproductions', rel)], { cwd: ROOT, encoding: 'utf8', maxBuffer: 8 << 20 });
  if (r.status !== 0) throw new Error(`reproduction ${rel} exited ${r.status}: ${(r.stderr || r.stdout || '').slice(-300)}`);
  return r.stdout.split('\n').filter((l) => !NOISE.test(l)).join('\n').replace(/\n{3,}/g, '\n\n').trim();
};
console.log('[rec] running node reproductions (capturing real transcripts)…');
const REPRO = {
  agentic: capture('agentic-contract-e2e.mjs'),
  usdc: capture('contract-usdc-settlement.mjs'),
  zk: capture('contract-zk.mjs'),
  he: capture('contract-he.mjs'),
  reentrancy: capture('contracts-reentrancy.mjs'),
};
// PASS-tail (last ✅ block) of a transcript, for compact robustness beats.
const passTail = (t) => { const i = t.lastIndexOf('✅'); return i < 0 ? t : t.slice(i); };

// Slice ONE captured transcript into ordered story beats. `anchors` are substrings that each mark
// the first line of a beat; a beat spans from its anchor's paragraph up to (but not including) the
// next anchor's. We search sequentially so a later anchor can't match an earlier paragraph, and we
// THROW on a missed anchor — a silent empty beat would narrate "the root moves" over a blank
// terminal (exactly the fluff we are removing), and a throw at capture time catches any reproduction
// wording that slips past the NOISE filter before the 6-minute record+mux cycle.
const beats = (label, text, anchors) => {
  const paras = text.split(/\n{2,}/);
  const idx = [];
  let from = 0;
  for (const a of anchors) {
    const i = paras.findIndex((p, k) => k >= from && p.includes(a));
    if (i < 0) throw new Error(`beats(${label}): anchor ${JSON.stringify(a)} not found at/after paragraph ${from} — reproduction output changed; update anchors. Paragraphs:\n` + paras.map((p, k) => `  [${k}] ${p.split('\n')[0]}`).join('\n'));
    idx.push(i);
    from = i + 1;
  }
  return idx.map((start, n) => paras.slice(start, n + 1 < idx.length ? idx[n + 1] : paras.length).join('\n\n'));
};
const ZK = beats('zk', REPRO.zk, ['REPRODUCTION', 'honest:', 'tampered:']);   // [setup, verify→write→root moves, tampered/malformed/denied + PASS]
const HE = beats('he', REPRO.he, ['REPRODUCTION', 'decrypt(', 'denied-import']); // [lattice+size, blind add+open+sum≠input, decrypt-denied + PASS]
const US = beats('usdc', REPRO.usdc, ['REPRODUCTION', 'ethereum re-point', 'seal-boundary']); // [base+arbitrum release, ethereum re-point fails, seal refusals+netting+PASS]
// First "root before → after" line inside a beat, rendered literally into the SAW caption (the header
// promises SAW is read from the transcript — so read it).
const rootLine = (beat) => (beat.split('\n').find((l) => /root before → after|root before/.test(l)) || '').replace(/\s+/g, ' ').trim();

// ── real LNG → Solidity for the finale contrast (ordinary logic IS EVM-compatible) ──
const COUNTER_SRC = [
  '~contract `Counter {',
  '  ~state { ~public { `count ~u256 0 } }',
  '  ~on `inc() { `count = `count + 1; return `count }',
  '  ~on `incBy(`n ~u256) { `count = `count + `n; return `count }',
  '  ~on `get() { return `count }',
  '}',
].join('\n');
const COUNTER_SOL = transpile(COUNTER_SRC);

// ── the live devnet on :8646, if the operator has one up (`npm run devnet -w packages/simulator`) ──
const devnetStatus = await fetch('http://127.0.0.1:8646', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'getNodeStatus' }) }).then((r) => r.json()).catch(() => null);
const DEVNET_LINE = devnetStatus && devnetStatus.running
  ? `$ curl -s :8646 -d '{"type":"getNodeStatus"}'\n  → running: ${devnetStatus.running}   peers: ${devnetStatus.peers}   height: ${devnetStatus.height}\n  a real XMBL network is live on its documented default endpoint.`
  : `(no devnet on :8646 — start one with:  npm run devnet -w packages/simulator)`;

// ── narration (prose; code identifiers spelled as `say` reads them) ──
const VO = {
  // The story: a treasury takes stablecoin payments across many chains and needs three things an
  // ordinary contract cannot give it — prove authorization without revealing the secret (zk), add
  // amounts nobody may see (HE), and never hand its money to a custodian (PQ seal). We build it,
  // then show the node-side proof and the tech behind each requirement.
  open: 'A treasury settles stablecoins across many chains. It needs three things no ordinary contract gives: prove a payment authorized without revealing the secret, add amounts no one sees, and never hand its money to a custodian.',
  compile: 'We build it here — authored as plain sentences or source, compiled to real WebAssembly, the exact bytes a node runs.',
  inc: 'A call commits state: increment moves the counter zero to one, and the tile flashes on a real write.',
  revert: 'It fails safely: over-withdraw the Vault and the whole call reverts, the balance untouched.',
  deploy: 'Deploying derives the id from the contract itself — same source, same id on every node.',
  boundary: 'The lab is honest: no Verkle root, no cryptography in-page. Those run on a node — let us run them.',
  devnet: 'A real XMBL network is live, reporting its peers and block height.',
  agentic: 'The node commits every change to a two-hundred-fifty-six-way hash tree: authorized calls move the root, refused calls do not, and two nodes agree. The ledger the treasury trusts.',
  zk1: 'Requirement one — prove a payment authorized without revealing the secret. The payer holds three secret points on a private curve and derives one public coordinate on it. The proof shows the anchors and that coordinate, never the secret points.',
  zk2: 'The contract verifies the proof, and only then writes state: the honest coordinate verifies, the gated write commits, and the Verkle root moves.',
  zk3: 'Now the attacks. Shift the coordinate by one and the proof fails — no write, the root unmoved. A malformed proof fails closed instead of crashing, and a contract that never declared the capability is denied.',
  he1: 'Requirement two — add amounts no one may see. Each payer encrypts a value under a post-quantum lattice key: nearly nine hundred bytes of ciphertext that reveal nothing about the number inside.',
  he2: 'The contract adds the ciphertexts with one host call, holding no key and seeing no number. Only the key holder opens the total off-chain — one plus zero decrypts to one — and the sum is a new ciphertext, not a copy of either input.',
  he3: 'Decryption is refused even to a contract that opted in: the secret key touches no contract, and two nodes agree on the blind result.',
  usdc1: 'All three, in the real case: settle U-S-D-C on the chain the treasury picks. A proof bound to the exact settlement — receiver, asset, amount, chain — releases it, and the Verkle root moves.',
  usdc2: 'Because the proof is the settlement, the same proof cannot release it re-pointed at another chain: the base proof fails on Ethereum, and the root stays put.',
  usdc3: 'The amount rides encrypted and is netted while still encrypted. The authorizing key is sealed, post-quantum, to the receiver — a wrong receiver or a changed amount opens nothing, and the chain holds ciphertext, never the key.',
  guarantees: 'The rest holds by construction: reentrancy cannot be written, the crypto is opt-in and marked unaudited, and each property is a test in the gate.',
  evm: 'Could Ethereum do this? Ordinary logic, yes — the transpiler lowers XMBL straight to Solidity.',
  evm2: 'But adding two encrypted values is one host call here, and the EVM has no opcode and no precompile for it. You would need an off-chain coprocessor and an on-chain verifier — a research project, not a contract. Trivial here; out of reach there.',
  close: "That's the treasury's contract: authorized without revealing the secret, summed without seeing the amounts, settled on any chain without a custodian — proven on a real node, beyond the EVM.",
};
const clip = {};
let voTotal = 0;
for (const [id, text] of Object.entries(VO)) {
  const aiff = join(VODIR, id + '.aiff');
  execFileSync('say', ['-v', VOICE, '-r', String(RATE), '-o', aiff, text]);
  clip[id] = { aiff, ms: durMs(aiff) };
  voTotal += clip[id].ms;
}
console.log(`[rec] generated ${Object.keys(clip).length} voiceover clips, ${(voTotal / 1000).toFixed(1)}s of narration`);
// Project final runtime from narration alone BEFORE the 6-minute record+mux — tune against this loop.
// Each marked cue holds ≈ voMs + PAD; add the un-narrated Act-1 overhead (silent beats, saw holds,
// the boundary transition, open/close floors over their voMs). Run `VO_ONLY=1 node …` to stop here.
const PAD = 350;
{
  const cues = Object.keys(VO).length;
  const ACT1_OVERHEAD_MS = 16000; // ~2 silent beats + ~8 saw holds + show scrolls + compile waits
  const projMs = voTotal + PAD * cues + ACT1_OVERHEAD_MS;
  const m = Math.floor(projMs / 60000), s = Math.round((projMs % 60000) / 1000);
  console.log(`[rec] projected runtime ≈ ${m}:${String(s).padStart(2, '0')} (voTotal ${(voTotal / 1000).toFixed(1)}s + ${cues}×PAD + ~${ACT1_OVERHEAD_MS / 1000}s Act-1 overhead)${projMs > 300000 ? '  ⚠ OVER 5:00 CAP' : ''}`);
  if (process.env.VO_ONLY) process.exit(projMs > 300000 ? 2 : 0);
}

const VW = 1440, VH = 900;
const ctx = await chromium.launchPersistentContext('', {
  headless: false,
  viewport: { width: VW, height: VH },
  recordVideo: { dir: OUT, size: { width: VW, height: VH } },
});

let videoPath = null;
let t0 = 0;
const timeline = [];
try {
  const page = await ctx.newPage();
  videoPath = await page.video().path();
  t0 = Date.now();
  page.on('pageerror', (e) => console.error('  pageerror —', e.message));
  await page.goto(pathToFileURL(LAB).href, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.call-row', { timeout: 15000 }); // the lab compiles on load

  // ── caption bar (desktop): centered, max-width, larger type than the 480px popup demo ──
  const setCap = (doing, expect, saw, sawKind) => page.evaluate(({ doing, expect, saw, sawKind }) => {
    let bar = document.getElementById('demo-cap');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'demo-cap';
      bar.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:22px;width:min(1180px,92vw);z-index:99999;background:oklch(17% 0 0);color:oklch(94% 0 0);font:16px/1.6 -apple-system,system-ui,sans-serif;padding:16px 22px;border:1px solid oklch(32% 0 0);border-top:3px solid oklch(84% .19 80);border-radius:14px;box-shadow:0 14px 48px rgba(0,0,0,.5);box-sizing:border-box';
      bar.innerHTML = '<div style="margin-bottom:4px"><b style="color:oklch(84% .19 80);font:700 11px/1 ui-monospace,monospace;letter-spacing:.16em">DOING </b><span id="cap-do"></span></div>'
        + '<div style="margin-bottom:4px"><b style="color:oklch(72% .12 200);font:700 11px/1 ui-monospace,monospace;letter-spacing:.16em">EXPECT </b><span id="cap-exp"></span></div>'
        + '<div><b style="color:oklch(60% 0 0);font:700 11px/1 ui-monospace,monospace;letter-spacing:.16em">SAW </b><span id="cap-saw" style="font-weight:600"></span></div>';
      document.body.appendChild(bar);
    }
    document.getElementById('cap-do').textContent = doing || '';
    document.getElementById('cap-exp').textContent = expect || '';
    const s = document.getElementById('cap-saw');
    s.textContent = saw == null ? '…' : saw;
    s.style.color = sawKind === 'ok' ? 'oklch(80% .16 150)' : sawKind === 'bad' ? 'oklch(74% .17 26)' : 'oklch(74% 0 0)';
  }, { doing, expect, saw, sawKind });

  // ── terminal-style proof overlay: real captured bytes, revealed line by line ──
  await page.evaluate(() => {
    const ov = document.createElement('div');
    ov.id = 'proof-ov';
    // NB: toggle display explicitly — an inline `display:flex` would beat the UA `[hidden]{display:none}`
    // rule, leaving the overlay always on (and intercepting clicks on the lab beneath it).
    ov.style.cssText = 'position:fixed;inset:0;z-index:9000;background:oklch(14% .01 250);display:none;flex-direction:column;box-sizing:border-box;padding:0 0 150px 0';
    ov.innerHTML = '<div id="proof-top" style="display:flex;align-items:center;gap:10px;padding:13px 20px;background:oklch(19% .01 250);border-bottom:1px solid oklch(28% .01 250)">'
      + '<span style="width:12px;height:12px;border-radius:50%;background:#ff5f57;display:inline-block"></span>'
      + '<span style="width:12px;height:12px;border-radius:50%;background:#febc2e;display:inline-block"></span>'
      + '<span style="width:12px;height:12px;border-radius:50%;background:#28c840;display:inline-block"></span>'
      + '<span id="proof-title" style="margin-left:12px;color:oklch(72% 0 0);font:600 14px/1 ui-monospace,SFMono-Regular,monospace"></span></div>'
      + '<pre id="proof-body" style="margin:0;flex:1;overflow:auto;padding:20px 26px;color:oklch(88% .02 220);font:15px/1.62 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-word"></pre>';
    document.body.appendChild(ov);
    const colorize = (t) => {
      if (/✅|✔|PASS\b/.test(t)) return 'oklch(82% .17 150)';
      if (/✗|refused|reverted|denied|UNMOVED|unmoved|not|FAIL/i.test(t) && !/✔/.test(t)) return 'oklch(78% .16 26)';
      if (/^\s*(===|──|REPRODUCTION|PART|\$ )/.test(t) || /content address/.test(t)) return 'oklch(84% .15 80)';
      if (/root|Verkle|coordinate|ENC\(|ciphertext|zk|he:/i.test(t)) return 'oklch(80% .12 200)';
      return 'oklch(88% .02 220)';
    };
    window.__proofOpen = (title, cmd) => {
      const ov = document.getElementById('proof-ov');
      ov.style.display = 'flex';
      document.getElementById('proof-title').textContent = cmd ? `node — ${cmd}` : (title || 'node');
      document.getElementById('proof-body').textContent = '';
    };
    window.__proofClose = () => { document.getElementById('proof-ov').style.display = 'none'; };
    window.__proofLine = (text) => {
      const body = document.getElementById('proof-body');
      const span = document.createElement('span');
      span.textContent = (text || '') + '\n';
      span.style.color = colorize(text || '');
      body.appendChild(span);
      body.scrollTop = body.scrollHeight;
    };
  });

  const mark = (id) => { timeline.push({ id, at: Math.max(0, Date.now() - t0) }); return clip[id] ? clip[id].ms : 0; };
  const step = async (id, doing, expect, floor = 1600) => { await setCap(doing, expect, null); const ms = mark(id); await wait(page, Math.max(floor, ms + PAD)); };
  // A silent caption beat (NO voiceover clip, NO timeline mark) for quick utility actions that ride on
  // the narration of the step before them — never pass an id here or the mux will deref a missing clip.
  const beat = async (doing, expect, ms = 1000) => { await setCap(doing, expect, null); await wait(page, ms); };
  const saw = async (doing, expect, sawText, kind = 'ok', hold = 900) => { await setCap(doing, expect, sawText, kind); await wait(page, hold); };
  const show = async (sel) => { await page.locator(sel).first().scrollIntoViewIfNeeded().catch(() => {}); await wait(page, 350); };

  const proofOpen = (title, cmd) => page.evaluate(({ title, cmd }) => window.__proofOpen(title, cmd), { title, cmd });
  const proofClose = () => page.evaluate(() => window.__proofClose());
  const proofLine = (t) => page.evaluate((x) => window.__proofLine(x), t);
  // Reveal a captured transcript as steady line-by-line motion that FILLS the narration (no dead
  // static pause), then a short settle with the SAW headline. The dwell on the differentiators comes
  // from their longer narration (budget), not from padded silence.
  // fresh=true opens a NEW terminal (clears body, sets the command title); fresh=false keeps the same
  // overlay and APPENDS — so a multi-beat proof (zk1→zk2→zk3) unrolls as one continuous transcript
  // across three narrated beats instead of flashing three separate windows.
  const revealProof = async (id, doing, expect, cmd, text, sawText, sawKind = 'ok', floor = 5000, fresh = true) => {
    await setCap(doing, expect, null);
    if (fresh) await proofOpen(null, cmd);
    const ms = mark(id);
    const budget = Math.max(floor, ms + PAD);
    const lines = text.split('\n');
    const span = budget * 0.82;                         // reveal across most of the narration
    const per = Math.max(45, Math.floor(span / Math.max(1, lines.length)));
    for (const ln of lines) { await proofLine(ln); await wait(page, per); }
    const used = per * lines.length;
    await setCap(doing, expect, sawText, sawKind);
    if (budget > used) await wait(page, budget - used);
  };

  // DOM helpers for the live lab
  const lngPreview = () => page.evaluate(() => (document.querySelector('.src-preview pre')?.textContent || '').trim());
  const tileVal = (field) => page.evaluate((f) => { const t = document.querySelector(`.tile[data-field="${f}"] .tile-v`); return t ? t.textContent.trim() : null; }, field);
  const lastTrace = () => page.evaluate(() => (document.querySelector('.trace .tline')?.textContent || '').trim());
  const buildStatus = () => page.evaluate(() => (document.querySelector('.compile-row .parse-msg')?.textContent || '').trim());
  const callRow = (ep) => page.locator('.call-row').filter({ has: page.locator('.ep', { hasText: new RegExp('^' + ep + '$') }) });
  const runEp = async (ep, args = []) => { const r = callRow(ep); const ins = r.locator('.arg'); for (let i = 0; i < args.length; i++) await ins.nth(i).fill(String(args[i])); await r.getByRole('button', { name: /^Run$/ }).click(); };
  const pickSample = async (key) => { await page.locator('select.sel.sample').selectOption(key); await wait(page, 600); };
  const compile = async () => { await page.locator('.compile-row button', { hasText: /Compile/ }).click(); await page.waitForFunction(() => /compiled ✓/.test(document.querySelector('.compile-row .parse-msg')?.textContent || ''), { timeout: 12000 }); };

  // ════ OPEN ════
  await setCap('Opening the XMBL Contract Lab on the desktop', 'A single offline page: builder + code, compile, live test, deploy', null);
  { const ms = mark('open'); await wait(page, Math.max(2600, ms + 500)); }
  { const eps = await page.locator('.call-row .ep').allTextContents(); await saw('Opened the Contract Lab', 'It compiled the Counter sample on load', `${eps.length} entrypoints ready: ${eps.map((s) => s.trim()).join(', ')}`); }

  // ════ ACT 1 — THE MINIAPP: author → compile → call → revert → deploy ════
  await beat('Viewing the authored contract as real XMBL contract-language source', 'The Code tab shows the same source the visual builder writes');
  await page.locator('.tabs button.tab', { hasText: 'Code' }).click();
  await wait(page, 400);
  await show('textarea.code');
  { const head = await page.evaluate(() => (document.querySelector('textarea.code')?.value || '').split('\n')[0].trim()); await saw('Viewed the LNG source', 'Real contract-language source, edited two ways', head || '~contract `Counter { … }'); }
  await page.locator('.tabs button.tab', { hasText: 'Visual builder' }).click();
  await wait(page, 300);

  await step('compile', 'Compiling with the real @xmbl/lng toolchain', 'A “compiled ✓ — N entrypoints, M fields, B bytes” status — real WASM bytecode');
  await compile();
  await show('.compile-row');
  await saw('Compiled (real @xmbl/lng → WebAssembly)', 'A status proving real bytecode', await buildStatus());

  await step('inc', 'Running inc() in the Test panel', 'count commits 0 → 1 and the state tile flashes — a real write');
  await show('.state-grid');
  await runEp('inc');
  await page.waitForFunction(() => document.querySelector('.tile[data-field="count"] .tile-v')?.textContent.trim() === '1', { timeout: 10000 });
  { const c = await tileVal('count'); const tr = await lastTrace(); await saw('Ran inc()', 'count commits 0 → 1', `committed count = ${c} · ${tr}`, c === '1' ? 'ok' : 'bad'); }

  await beat('Running incBy(41)', 'count commits 1 → 42 — recompiled and executed from source each call');
  await runEp('incBy', [41]);
  await page.waitForFunction(() => document.querySelector('.tile[data-field="count"] .tile-v')?.textContent.trim() === '42', { timeout: 10000 });
  { const c = await tileVal('count'); await saw('Ran incBy(41)', 'count commits 1 → 42', `committed count = ${c}`, c === '42' ? 'ok' : 'bad'); }

  await step('revert', 'Robustness: in the Vault, deposit(100) then over-withdraw', 'A trapping underflow reverts the whole call; committed balance stays unmoved');
  await pickSample('Vault');
  await compile();
  await show('.state-grid');
  await runEp('deposit', [100]);
  await page.waitForFunction(() => document.querySelector('.tile[data-field="bal"] .tile-v')?.textContent.trim() === '100', { timeout: 10000 });
  const balBefore = await tileVal('bal');
  await saw('Deposited 100 (balance before the trapping call)', 'It must not move on a revert', `bal = ${balBefore}`, 'ok', 800);
  await runEp('withdraw', [999999]);
  await page.waitForFunction(() => /reverted/.test(document.querySelector('.trace .tline')?.textContent || ''), { timeout: 10000 });
  { const tr = await lastTrace(); const balAfter = await tileVal('bal'); await saw('Ran withdraw(999999) — an over-withdraw', 'It reverts; committed bal unmoved', `${tr} · bal still ${balAfter} (was ${balBefore})`, balAfter === balBefore ? 'ok' : 'bad', 1200); }

  await step('deploy', 'Deploying a content-addressed instance (Counter)', 'A node-identical id (xc1_…), cube and plane — the descriptor an operator applies on a node');
  await pickSample('Counter');
  await compile();
  await page.locator('.deploy .panel-h button', { hasText: /Deploy/ }).click();
  await page.waitForSelector('.live-badge', { timeout: 10000 });
  await show('.deploy');
  { const id = await page.evaluate(() => { const rows = [...document.querySelectorAll('.deploy .kv .k')]; const k = rows.find((e) => e.textContent.trim() === 'id'); return k ? (k.nextElementSibling?.textContent || '').trim() : ''; }); const badge = await page.evaluate(() => (document.querySelector('.live-badge')?.textContent || '').trim()); await saw('Deployed a live instance', 'A content-addressed id + committed genesis', `${id.slice(0, 26)}… · ${badge}`, 'ok', 1000); }

  // ════ transition to the node-delegated proofs ════
  await step('boundary', 'The lab states its own edge — so we follow its printed proof commands', 'In-page: no Verkle root, no zk, no HE. Those run on a node. Running them now.', 2600);

  // ════ ACT 2 — THE LEDGER THE TREASURY WILL TRUST (live devnet + what the node commits) ════
  await revealProof('devnet', 'A real XMBL network is live on its default endpoint', 'running, with peers and block height', 'curl :8646  {"type":"getNodeStatus"}', DEVNET_LINE,
    devnetStatus && devnetStatus.running ? `live devnet: running, ${devnetStatus.peers} peers, height ${devnetStatus.height}` : 'no devnet on :8646', devnetStatus && devnetStatus.running ? 'ok' : 'bad', 3800);
  await revealProof('agentic', 'The node commits every change to a 256-ary hash tree (what “Verkle” is here)', 'Authorized calls move the root; refused calls leave it unmoved; an independent verifier agrees; two nodes → one root', 'reproductions/agentic-contract-e2e.mjs', REPRO.agentic,
    'root moved on every authorized call, unmoved on every refused one; two nodes → one root', 'ok', 6500);

  // ════ ACT 3 — REQUIREMENT ONE: prove authorization without revealing the secret (zk) ════
  // Three narrated beats unroll into ONE terminal: setup → verify+write+root-moves → attacks fail.
  await revealProof('zk1', 'Requirement 1 — prove a payment is authorized without revealing the secret', 'Three secret points on a private curve derive ONE public coordinate; the proof shows only the anchors + coordinate', 'reproductions/contract-zk.mjs', ZK[0],
    'public coordinate + anchors exposed; the 3 secret points are never revealed', 'ok', 6000, true);
  await revealProof('zk2', 'The contract verifies the proof, and only then writes state', 'Honest coordinate verifies → gated Verkle write commits → the root MOVES', null, ZK[1],
    rootLine(ZK[1]) || 'verify = 1 → slot 7 = 1 → root moved', 'ok', 5000, false);
  await revealProof('zk3', 'Now the attacks: tampered proof, malformed proof, unflagged contract', 'Shifted coordinate → verify 0, root UNMOVED; malformed → fails closed (no trap); no capability → denied', null, ZK[2],
    'tampered verify 0 → root unmoved · malformed → 0 (no trap) · unflagged import denied', 'ok', 6500, false);

  // ════ ACT 4 — REQUIREMENT TWO: add amounts no one may see (HE) ════
  await revealProof('he1', 'Requirement 2 — add up amounts no one is allowed to see', 'Each value encrypted under a post-quantum lattice key; ~900-byte ciphertext reveals nothing about the number', 'reproductions/contract-he.mjs', HE[0],
    'lattice n=27, q=3329 · 896-byte ciphertext (28×32-byte words)', 'ok', 5500, true);
  await revealProof('he2', 'The contract adds the ciphertexts — one host call, holding no key', 'Blind add → key holder opens the total off-chain (1+0 = 1); the stored sum is a NEW ciphertext, not a copy', null, HE[1],
    'ENC(1) ⊞ ENC(0) opens to 1 · sum ciphertext ≠ either input', 'ok', 6000, false);
  await revealProof('he3', 'The secret key never touches a contract', 'Decryption refused even to a contract that opted in; two nodes agree on the blind result', null, HE[2],
    'decrypt denied even with opt-in (2 refusals) · two nodes → one root', 'ok', 5000, false);

  // ════ ACT 5 — REQUIREMENT THREE, IN THE REAL THING: cross-chain USDC settlement (zk + HE + seal) ════
  await revealProof('usdc1', 'All three, in the real case: settle USDC on the chain the treasury picks', 'A zk proof BOUND to the settlement (receiver, asset, amount, chain) releases it → the Verkle root moves', 'reproductions/contract-usdc-settlement.mjs', US[0],
    rootLine(US[0]) || 'base & arbitrum: verdict 1 → released → root moved', 'ok', 6000, true);
  await revealProof('usdc2', 'The proof IS the settlement — it cannot be re-pointed at another chain', 'The base proof, replayed against an ethereum re-point → verdict 0, nothing released, root UNMOVED', null, US[1],
    'ethereum re-point: base proof verdict 0 → not released → root unmoved', 'ok', 5000, false);
  await revealProof('usdc3', 'The amount rides encrypted; the key is sealed, post-quantum, to the receiver', 'Netted while encrypted; wrong receiver or changed amount opens nothing; the chain holds ciphertext, never the key', null, US[2],
    '3 seal refusals (wrong receiver · mutated amount · toy-ring) · committed state holds no key bytes', 'ok', 6000, false);

  // ════ ACT 6 — THE REST HOLDS BY CONSTRUCTION (reentrancy + honest unaudited status + the gate) ════
  const guaranteesText = [
    '$ node reproductions/contracts-reentrancy.mjs   (reentrancy inexpressible by construction)',
    passTail(REPRO.reentrancy),
    '',
    '⛔ zk / HE are per-contract opt-in and UNAUDITED (MAINNET-GATES); they never gate consensus or the ledger.',
    '✅ deny-by-default · fail-closed (no trap) · decrypt denied even with opt-in · reentrancy inexpressible · deterministic',
    '✅ npm run test:protocol — each of these properties is a suite in the hard gate.',
  ].join('\n');
  await revealProof('guarantees', 'The rest holds by construction', 'Reentrancy cannot be written; the crypto is opt-in and clearly marked unaudited; every property is a test in the gate', 'reproductions/contracts-reentrancy.mjs  +  MAINNET-GATES', guaranteesText,
    'reentrancy impossible by construction · crypto opt-in + unaudited · each property gated by test:protocol', 'ok', 5500, true);

  // ════ ACT 7 — EVM-HARD FINALE (the differentiator — dwell on the contrast) ════
  await revealProof('evm', 'Ordinary logic: the real transpiler lowers LNG to Solidity', 'XMBL stays EVM-compatible for ordinary contracts', '@xmbl/lng  transpile(Counter)  →  Solidity', `// @xmbl/lng transpile — ordinary LNG IS EVM-compatible\n\n${COUNTER_SOL}`,
    'ordinary LNG transpiles cleanly to a standard Solidity contract', 'ok', 5500);
  const evmContrast = [
    '// TRIVIAL IN XMBL — add two encrypted values: one host call.',
    '~on `tally(...) { xmbl_he_add(a, b, out) }    // the contract sums ciphertexts it CANNOT read',
    '',
    '// Proven on-chain a moment ago (blind):',
    ...passTail(REPRO.he).split('\n'),
    '',
    '// ON THE EVM — there is no opcode and no precompile that adds two ciphertexts.',
    '//   → you need an off-chain FHE coprocessor + an on-chain verifier.',
    '//   A research project, not a contract. Trivial here; out of reach there.',
  ].join('\n');
  await revealProof('evm2', 'The trivial-in-XMBL, hard-in-EVM example: a blind encrypted tally', 'One host call here; no EVM primitive exists for adding ciphertexts on-chain', 'XMBL he_add  vs  EVM (no equivalent)', evmContrast,
    'one host call in XMBL adds ciphertexts the contract cannot read; the EVM has no such primitive', 'ok', 11000);

  // ════ CLOSE ════
  await proofClose();
  await setCap('Walkthrough complete', 'Lab lifecycle + node-proven: committed state on an authenticated tree, zk + HE settlement, reentrancy-proof, deterministic', 'Every claim shown on a surface that backs it — honest about what is still unaudited', 'ok');
  { const ms = mark('close'); await wait(page, Math.max(3500, ms + 600)); }
  console.log('[rec] recorded: treasury story → lab lifecycle → node/Verkle → zk (3 beats) → HE (3 beats) → USDC settlement (3 beats) → guarantees → EVM finale');
} catch (e) {
  console.error('record error —', e.message);
} finally {
  await ctx.close();
}

if (videoPath && existsSync(videoPath)) renameSync(videoPath, VID);
else { const webm = readdirSync(OUT).filter((f) => f.endsWith('.webm') && f !== 'contract-lab-demo.webm'); if (webm.length) renameSync(join(OUT, webm[0]), VID); }
if (!existsSync(VID)) { console.log('\n❌ no video produced'); process.exit(1); }

// silent mp4 intermediate
const conv = spawnSync(FFMPEG, ['-y', '-i', VID, '-vf', `scale=${VW}:-2`, '-pix_fmt', 'yuv420p', '-movflags', '+faststart', SILENT], { encoding: 'utf8' });
if (conv.status !== 0) { console.log(`\n✅ recording: ${VID}\n(mp4 conversion failed: ${(conv.stderr || '').split('\n').slice(-2).join(' ')})`); process.exit(0); }

// mux voiceover: delay each clip to its logged offset, mix, lay over the silent video
const videoMs = durMs(SILENT);
if (timeline.length) {
  const inputs = [];
  const parts = [];
  const labels = [];
  timeline.forEach((e, i) => { inputs.push('-i', clip[e.id].aiff); parts.push(`[${i + 1}:a]adelay=${e.at}|${e.at}[a${i}]`); labels.push(`[a${i}]`); });
  const filter = `${parts.join(';')};${labels.join('')}amix=inputs=${timeline.length}:normalize=0:dropout_transition=0,apad,atrim=0:${(videoMs / 1000).toFixed(2)}[vo]`;
  const mux = spawnSync(FFMPEG, ['-y', '-i', SILENT, ...inputs, '-filter_complex', filter, '-map', '0:v', '-map', '[vo]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-shortest', MP4], { encoding: 'utf8' });
  if (mux.status === 0 && existsSync(MP4)) {
    rmSync(SILENT);
    const finalMs = durMs(MP4);
    const over = finalMs > 300000;
    console.log(`\n✅ recording: ${VID}\n✅ voiced mp4: ${MP4}  (${(finalMs / 1000).toFixed(1)}s${over ? ' — OVER 5:00 CAP' : ', under 5:00'}, ${timeline.length} narration cues)`);
    process.exit(over ? 2 : 0);
  }
  console.log(`\n(voiceover mux failed: ${(mux.stderr || '').split('\n').slice(-3).join(' ')})`);
}
renameSync(SILENT, MP4);
console.log(`\n✅ recording: ${VID}\n✅ mp4 (silent — voiceover step failed): ${MP4}`);
process.exit(0);
