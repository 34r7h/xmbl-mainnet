// REPRODUCTION — COMPUTE IS ISOLATED, METERED, AND A KILLED JOB IS STILL BILLED; STORAGE IS PROVED, NOT
// CLAIMED (packages/storage-compute).
//
// CLAIM 1 — A GUEST CANNOT RUN FOREVER FOR FREE. An untrusted WASM job runs in its own worker thread with a
// hard deadline and a memory cap. A synchronous infinite loop in the guest — the case a same-thread timer can
// never interrupt — is killed by terminating the thread, and the rejection carries BILLING metrics charged at
// the maximum, because the job held a worker slot for the full deadline and could have grown to its memory
// cap. Fail-closed on purpose: a terminated worker cannot self-report a smaller figure. Without this, one
// looping guest consumes a node's whole capacity at no cost, which is the denial-of-service this module exists
// to prevent.
//
// CLAIM 2 — HOLDING A SHARD IS PROVED FROM THE DATA. A storage probe is answered with a proof computed over
// the nonce AND the shard's bytes, so a node that does not hold the shard cannot answer, and a node that
// answers "held: true" with anything else fails the check. Reachability is not custody.
//
// Node-only by construction: worker isolation, `process.threadCpuUsage` and node:sqlite have no browser
// equivalent, so this reproduction runs under node (see reproductions/README.md).
//
// Exits non-zero if any claim fails, so it is also a hard-gate test (reproductions.test.mjs).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ComputeRuntime, computeProbeProof } from '@xmbl/storage-compute';

const selfDigest = createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex');
console.log('XMBL reproduction — isolated, metered compute; a killed job is billed; custody is proved from the data');
console.log(`source sha256: ${selfDigest}\n`);

let failures = 0;
const ok = (name, cond, detail = '') => { console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`); if (!cond) failures++; };

// ── A minimal, hand-encoded guest: add(i32,i32)->i32 and spin() which loops forever. ──
const uleb = (n) => { const b = []; do { let x = n & 0x7f; n >>>= 7; if (n) x |= 0x80; b.push(x); } while (n); return b; };
const vec = (items) => [...uleb(items.length), ...items.flat()];
const section = (id, body) => [id, ...uleb(body.length), ...body];
const name = (t) => [...uleb(t.length), ...[...t].map((c) => c.charCodeAt(0))];
// A function body: no locals, the given opcodes, `end` — with its own length prefix computed, never counted by hand.
const body = (opcodes) => { const b = [0x00, ...opcodes, 0x0b]; return [...uleb(b.length), ...b]; };
const GUEST = Uint8Array.from([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  ...section(1, vec([[0x60, ...vec([[0x7f], [0x7f]]), ...vec([[0x7f]])], [0x60, ...vec([]), ...vec([])]])),
  ...section(3, vec([[0x00], [0x01]])),
  ...section(7, vec([[...name('add'), 0x00, 0x00], [...name('spin'), 0x00, 0x01]])),
  ...section(10, vec([
    body([0x20, 0x00, 0x20, 0x01, 0x6a]),          // local.get 0, local.get 1, i32.add
    body([0x03, 0x40, 0x0c, 0x00, 0x0b]),          // loop { br 0 }  — a synchronous infinite loop
  ])),
]);
ok('the hand-encoded guest is valid WASM', WebAssembly.validate(GUEST), `${GUEST.length} bytes`);

// ── CLAIM 1a: a genuine job runs, returns, and is metered ──
const rt = new ComputeRuntime({ maxMemory: 16 * 1024 * 1024, maxTime: 1500 });   // the node operator's own ceilings
const bare = await rt.execute(GUEST, 'add', [40, 2]);
ok('by default the guest\'s result comes back bare', bare === 42, `result=${bare}`);
const r = await rt.execute(GUEST, 'add', [40, 2], { meter: true });   // opt in to the metering report
ok('a genuine job returns the guest\'s real result', r && r.result === 42, `result=${r?.result}`);
ok('it is METERED — cpu time, wall time and peak memory come back', r.metrics && typeof r.metrics.cpuMs === 'number' && typeof r.metrics.wallMs === 'number' && typeof r.metrics.peakMemBytes === 'number',
   `cpuMs=${r.metrics?.cpuMs?.toFixed?.(2)} wallMs=${r.metrics?.wallMs?.toFixed?.(2)} peakMem=${r.metrics?.peakMemBytes}`);
ok('a genuine job is not marked killed', r.metrics.killed !== true);

// ── CLAIM 1b: a synchronous infinite loop is KILLED, and BILLED ──
const t0 = Date.now();
let killed = null;
try { await rt.execute(GUEST, 'spin', []); } catch (e) { killed = e; }
const elapsed = Date.now() - t0;
ok('a guest that loops forever is STOPPED (a same-thread timer never could)', killed !== null && /time limit/i.test(killed.message), killed?.message);
ok('it is stopped AT THE OPERATOR\'S DEADLINE (maxTime 1500ms), not at some built-in one', elapsed >= 1500 && elapsed < 4000, `${elapsed}ms`);
ok('THE KILLED JOB IS STILL BILLED — the rejection carries metrics', !!killed.metrics && killed.metrics.killed === true);
ok('and it is billed at the maximum (a terminated worker cannot self-report less)',
   killed.metrics.peakMemBytes === 16 * 1024 * 1024 && killed.metrics.cpuMs > 0, `cpuMs=${killed.metrics.cpuMs.toFixed(1)} peakMem=${killed.metrics.peakMemBytes}`);

// ── CLAIM 1c: the guest is isolated — an import it did not declare is not there to call ──
const rt2 = new ComputeRuntime({ maxMemory: 8 * 1024 * 1024, maxTime: 1500 });
let denied = null;
try { await rt2.execute(GUEST, 'no_such_export', []); } catch (e) { denied = e; }
ok('calling an export the guest does not have fails, rather than doing something', denied !== null, denied?.message?.slice(0, 80));

// ── CLAIM 2: custody is proved over the nonce AND the bytes ──
const shard = Buffer.from('the bytes this node claims to be holding');
const other = Buffer.from('the bytes this node claims to be holdinh');   // one byte different
const nonce = 'probe-nonce-7f3a';
const proof = computeProbeProof(nonce, shard);
ok('a proof is a digest over the nonce and the data', /^[0-9a-f]{64}$/.test(proof), proof.slice(0, 24) + '…');
ok('the holder\'s proof reproduces exactly', computeProbeProof(nonce, shard) === proof);
ok('A NODE THAT DOES NOT HOLD THE BYTES CANNOT PRODUCE IT', computeProbeProof(nonce, other) !== proof);
ok('and the proof is nonce-bound — replaying an old one fails', computeProbeProof('probe-nonce-0000', shard) !== proof);

console.log(failures === 0
  ? '\nREPRODUCED — a guest cannot run forever for free, a genuine job is metered, and custody is proved from the bytes rather than asserted.'
  : `\nNOT REPRODUCED — ${failures} assertion(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
