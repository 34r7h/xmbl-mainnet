// MAYO scheme benchmark — the DELIVERABLE of MAINNET-CLOSEOUT B9 is a RATIO, so here is the instrument
// that produces it. It measures `'mayo'` (the baseline artifact) against `'mayo-cube'` (the adapted-scheme
// slot) through the SAME loader production uses — `MAYOWasm.load(scheme)` — so the day `wasm-schemes.js`
// repoints `'mayo-cube'` to its own build, this file measures the new artifact with no edit.
//
// Today both tags resolve to the one vendored artifact, so the honest ratio is 1.00. That is not a
// placeholder: it is the recorded BASELINE the adapted build has to beat, taken on the machine and runtime
// that will take the later number.
//
// Timing is not a gate — a CPU-ms assertion is a flaky test. This exits non-zero only if a scheme fails to
// load or a signature fails to round-trip; the numbers are printed for a reviewer to read.
//
// Usage:  node packages/identity/bench-mayo-schemes.mjs [iterations]
import { MAYOWasm } from './index.js';
import { KNOWN_SCHEMES, DEFAULT_SCHEME } from './src/wasm-schemes.js';

const N = Math.max(1, Number(process.argv[2] || 50));
const MSG = Uint8Array.from({ length: 64 }, (_, i) => i);
const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;

async function measure(scheme) {
  const m = await MAYOWasm.load(scheme);
  const kp = await m.keygen();
  const sig = await m.sign(MSG, kp.privateKey);
  if (!m.verifySync(MSG, sig, kp.publicKey)) throw new Error(`${scheme}: a freshly signed message did not verify`);
  if (m.verifySync(Uint8Array.from([9, 9, 9]), sig, kp.publicKey)) throw new Error(`${scheme}: a signature verified against the WRONG message`);

  for (let i = 0; i < 5; i++) { await m.sign(MSG, kp.privateKey); m.verifySync(MSG, sig, kp.publicKey); }   // warm
  let t = process.hrtime.bigint(); for (let i = 0; i < N; i++) await m.keygen();                      const keygen = ms(t) / N;
  t = process.hrtime.bigint();     for (let i = 0; i < N; i++) await m.sign(MSG, kp.privateKey);      const sign = ms(t) / N;
  t = process.hrtime.bigint();     for (let i = 0; i < N; i++) m.verifySync(MSG, sig, kp.publicKey);  const verify = ms(t) / N;

  // The wrapper hands back base64, so these are WIRE bytes, not the raw MAYO_1 sizes (cpk 1420, csk 24,
  // sig 454). Both are reported: the ratio is what matters and base64 does not change it.
  const raw = (x) => Math.floor((typeof x === 'string' ? x.length : x.length) * 3 / 4);
  return { scheme, keygen, sign, verify, pkBytes: kp.publicKey.length, skBytes: kp.privateKey.length,
           sigBytes: sig.length, pkRaw: raw(kp.publicKey), sigRaw: raw(sig) };
}

const pad = (s, w) => String(s).padStart(w);
const f3 = (x) => x.toFixed(3);

console.log(`MAYO scheme benchmark — ${N} iterations per operation, node ${process.version}`);
console.log(`schemes: ${KNOWN_SCHEMES.join(', ')}   (default: ${DEFAULT_SCHEME})\n`);

const rows = [];
for (const scheme of KNOWN_SCHEMES) rows.push(await measure(scheme));

console.log(`  ${pad('scheme', 10)} ${pad('keygen ms', 10)} ${pad('sign ms', 10)} ${pad('verify ms', 10)} ${pad('pk B', 7)} ${pad('sk B', 6)} ${pad('sig B', 7)}`);
for (const r of rows) {
  console.log(`  ${pad(r.scheme, 10)} ${pad(f3(r.keygen), 10)} ${pad(f3(r.sign), 10)} ${pad(f3(r.verify), 10)} ${pad(r.pkBytes, 7)} ${pad(r.skBytes, 6)} ${pad(r.sigBytes, 7)}`);
}

const base = rows.find((r) => r.scheme === 'mayo');
const cube = rows.find((r) => r.scheme === 'mayo-cube');
if (base && cube) {
  console.log(`\nTHE DELIVERABLE — 'mayo-cube' / 'mayo' (lower is better):`);
  console.log(`  sign    ${f3(cube.sign / base.sign)}×`);
  console.log(`  verify  ${f3(cube.verify / base.verify)}×`);
  console.log(`  pk      ${f3(cube.pkBytes / base.pkBytes)}×   (${cube.pkBytes} vs ${base.pkBytes} base64 bytes; ~${cube.pkRaw} vs ~${base.pkRaw} raw)`);
  console.log(`  sig     ${f3(cube.sigBytes / base.sigBytes)}×   (${cube.sigBytes} vs ${base.sigBytes} base64 bytes; ~${cube.sigRaw} vs ~${base.sigRaw} raw)`);
  const same = cube.pkBytes === base.pkBytes && cube.sigBytes === base.sigBytes;
  if (same) console.log(`\n  NOTE: both tags resolve to the SAME artifact today (wasm-schemes.js), so a ratio near 1.00 is\n        measurement noise, not a result. This is the baseline the adapted build has to beat.`);
}
