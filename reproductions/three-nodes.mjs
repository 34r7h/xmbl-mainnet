#!/usr/bin/env node
// THREE FULL NODES, ONE CHAIN — the convergence claim, reproduced under adversarial delivery (B2 / T6.2 c).
//
// THE CLAIM: three XMBL nodes given the same set of transactions seal the IDENTICAL chain — same blocks, same
// faces, same cubes, same cube set_digest, same state root — no matter what order the transactions reach them,
// how often they are re-delivered, or what junk arrives alongside. That is the whole basis of the protocol's
// convergence: a block's hash is a pure function of its transaction's consensus body, a face's membership is
// the hash-sorted partition of the pool, and a cube's faces are ranked by their roots. Nothing in that chain of
// reasoning may depend on arrival order, on a node's clock, or on who relayed a datum.
//
// WHY IT NEEDED A REPRODUCTION: this was measured failing. On 2026-08-03, after a full wipe and an identical
// replay, two nodes reached 5,145 blocks / 190 cubes with DIFFERENT set_digests, because face membership was
// "join the oldest pending face with room, seal on the 9th ARRIVAL" — order-dependent by construction. The
// fix (hash-sorted membership) and the content-only block hash are what this reproduces, on REAL XMBLCore
// instances rather than on subsystems wired together by the test.
//
// THE CHAOS: each node receives the same set in its own shuffled order, drawn from a seeded PRNG so a failing
// run is replayable; deliveries are interleaved across the three nodes rather than run node-by-node; a random
// share of transactions is delivered TWICE (the re-gossip a real mesh produces); and forged datums are mixed
// in — a tampered anchor whose xid no longer matches its body, and an untyped anchor with no xid at all —
// which every node must refuse identically. Convergence that only holds on clean input is not convergence.
//
// WHAT THIS REPRODUCTION FOUND, on its first run: a forged anchor that reuses an honest anchor's xid with a
// changed body made the honest anchor disappear. The ledger evicted by the CLAIMED xid, and a datum fails
// validation precisely when its body does not hash to that xid — so the eviction always landed on somebody
// else's datum. Three nodes given the identical 36-anchor set ended at 36 / 35 / 36 blocks, the short one being
// whichever node saw the forgery first. Anyone could have done it to any transaction, since every xid is
// public. Fixed: a forgery is now evicted under a digest of its OWN bytes.
//
// TWO PHASES, because the nodes have two sealing modes and they do not converge alike:
//   1. EAGER LOCAL SEALING (the default: XPC_CONSENSUS_V2 unset) — a node seals hash-sorted nines out of its
//      own pool the moment it holds nine. The partition is therefore a function of WHEN transactions arrived,
//      not only of WHICH: the block SET converges, the cube partition does not. This phase measures exactly
//      that, and it is why the live nodes converge through the canonical rebuild rather than through live
//      sealing.
//   2. AGREED SEALING (XPC_CONSENSUS_V2=1) — the seal boundary is agreed before it is cut. Same chaos, same
//      forgeries, and now the cubes, the cube set_digest and the state root are identical on all three.
//
// Run:  node reproductions/three-nodes.mjs [runs] [txs]
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { XMBLCore } from '@xmbl/core';
import { micromineTx } from '@xmbl/cubic-ledger';

const RUNS = Number(process.argv[2] || 3);
const TXS = Number(process.argv[3] || 36);      // 36 anchors = 4 faces; ≥27 gives a full cube
const HERE = dirname(fileURLToPath(import.meta.url));

// CONTENT ADDRESS — the exact bytes that produced this transcript.
const selfDigest = createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex');
console.log('XMBL reproduction — three full nodes converge on one chain under adversarial delivery');
console.log(`source sha256: ${selfDigest}`);
console.log(`runs: ${RUNS}   transactions per run: ${TXS}\n`);

// A seeded PRNG: a failing run is replayable from the seed printed with it.
function prng(seed) {
  let s = seed >>> 0;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
const shuffle = (arr, rand) => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};
const sha = (s) => createHash('sha256').update(String(s)).digest('hex');

// The cube set digest exactly as the control socket's `list_cube_keys` computes it — the number the nodes
// compares after a coordinated rebuild.
function setDigest(core) {
  const cubes = [];
  for (const c of core.xclt.cubes.values()) cubes.push({ id: c.id, merkleRoot: c.merkleRoot ?? null });
  cubes.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return createHash('sha256').update(cubes.map((c) => `${c.id}:${c.merkleRoot}`).join('|')).digest('hex');
}
// EVERY block a node holds — sealed into this.blocks AND still in the membership pool. Counting only
// this.blocks reports 0 on the live submit path (blocks enter the pool and move on to faces), which would make
// a "digests match" assertion vacuously true over two empty sets.
const allBlocks = (core) => {
  const seen = new Map();
  for (const b of core.xclt.blocks.values()) seen.set(b.id, b);
  for (const b of core.xclt._membershipPool) seen.set(b.id, b);
  for (const cube of core.xclt.cubes.values()) {
    for (const face of (cube.faces?.values?.() ?? [])) {
      for (const b of (face.blocks?.values?.() ?? [])) seen.set(b.id, b);
    }
  }
  // Faces cut but not yet gathered into a cube hold blocks too — miss these and a node that sealed 4 faces
  // into 1 cube reports 27 of its 36 blocks.
  for (const face of (core.xclt.getPendingCubeFaces?.() ?? [])) {
    for (const b of (face.blocks?.values?.() ?? [])) seen.set(b.id, b);
  }
  return [...seen.values()];
};
const blockDigest = (core) => createHash('sha256')
  .update(allBlocks(core).map((b) => b.hash).sort().join('|')).digest('hex');

let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!cond) failures++;
};
const note = (name, detail) => console.log(`  ..    ${name}  ${detail}`);

async function bootNodes(tag, run) {
  const dirs = [], nodes = [];
  for (let n = 0; n < 3; n++) {
    const d = mkdtempSync(join(tmpdir(), `xmbl-3n-${tag}-${run}-${n}-`));
    dirs.push(d);
    const core = new XMBLCore({
      network: { addresses: ['/ip4/127.0.0.1/tcp/0'], bootstrap: [] },
      ledger: { dbPath: join(d, 'ledger') },
      stateMachine: { dbPath: join(d, 'xvsm') },
      storage: { dbPath: join(d, 'storage') },
      consensus: { dbPath: join(d, 'xpc') },
    });
    await core.start();
    nodes.push(core);
  }
  return { nodes, dirs };
}

async function teardown(nodes, dirs) {
  for (const n of nodes) { try { await n.stop(); } catch { /* best effort */ } }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

// One chaotic delivery plan per node: its own shuffled order, ~20% re-gossiped duplicates, and two forgeries
// spliced in at a random point.
function deliveryPlans(set, forgeries, rand) {
  return [0, 1, 2].map(() => {
    const order = shuffle(set, rand);
    const stream = [];
    for (const tx of order) { stream.push(tx); if (rand() < 0.2) stream.push(tx); }
    stream.splice(Math.floor(rand() * stream.length), 0, ...forgeries);
    return stream;
  });
}

async function deliver(nodes, plans) {
  const refused = [0, 0, 0];
  const maxLen = Math.max(...plans.map((p) => p.length));
  for (let i = 0; i < maxLen; i++) {
    for (let n = 0; n < 3; n++) {
      const tx = plans[n][i];
      if (!tx) continue;
      try { await nodes[n].xclt.addTransaction(tx); } catch { refused[n]++; }
    }
  }
  return refused;
}

for (let run = 0; run < RUNS; run++) {
  const seed = 0x5eed0000 + run;
  const rand = prng(seed);
  console.log(`\u2500\u2500 run ${run + 1}/${RUNS}  seed 0x${seed.toString(16)} \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500`);

  // ONE transaction set, typed exactly as the nodes type them.
  const set = Array.from({ length: TXS }, (_, i) =>
    micromineTx({ type: 'anchor', event: i % 3 === 0 ? 'task.created' : i % 3 === 1 ? 'value.transfer' : 'soc.posted',
                  hash: sha(`run${run}-tx${i}`), ts: 1789500000000 + i }));

  // THE FORGERIES every node must refuse identically. The first is the dangerous one: it keeps an honest
  // anchor's xid and nonce and changes the body, so a node that evicts by the claimed xid loses the honest
  // anchor instead of the forgery.
  const forgeries = [
    { ...set[0], hash: sha(`run${run}-TAMPERED`) },
    { type: 'anchor', event: 'task.created', hash: sha(`run${run}-UNTYPED`), ts: 1789500000999 },
  ];

  // ── PHASE 1 — EAGER LOCAL SEALING (production default) ──
  delete process.env.XPC_CONSENSUS_V2;
  {
    const { nodes, dirs } = await bootNodes('eager', run);
    const plans = deliveryPlans(set, forgeries, rand);
    ok('phase 1: each node is given a DIFFERENT delivery order of the same set',
       new Set(plans.map((p) => p.map((t) => t.xid ?? 'none').join())).size === 3);
    const refused = await deliver(nodes, plans);
    ok('phase 1: every node refused the same number of forged/untyped datums',
       refused[0] === refused[1] && refused[1] === refused[2], `refused=${refused.join('/')}`);
    ok('phase 1: the forgeries WERE refused', refused[0] >= 2, `refused=${refused[0]}`);

    const blocks = nodes.map((n) => allBlocks(n).length);
    const bDigests = nodes.map(blockDigest);
    ok('phase 1: NO HONEST ANCHOR WAS LOST — all three hold every transaction in the set',
       new Set(blocks).size === 1 && blocks[0] === TXS, `blocks=${blocks.join('/')} expected=${TXS}`);
    ok('phase 1: all three agree on the BLOCK SET digest (content, not order)', new Set(bDigests).size === 1);

    const cubes = nodes.map((n) => n.xclt.cubes.size);
    const digests = nodes.map(setDigest);
    note('phase 1: cubes sealed per node', cubes.join(' / '));
    note('phase 1: cube set_digest agreement',
         new Set(digests).size === 1
           ? 'IDENTICAL (this run happened to seal on the same boundaries)'
           : `${new Set(digests).size} distinct — eager sealing cuts the pool wherever a node happens to hold nine, so the PARTITION follows arrival time. The block set still matches. This is why the nodes converge through the canonical rebuild, and why agreed sealing exists (phase 2).`);
    await teardown(nodes, dirs);
  }

  // ── PHASE 2 — AGREED SEALING (XPC_CONSENSUS_V2=1) ──
  process.env.XPC_CONSENSUS_V2 = '1';
  {
    const { nodes, dirs } = await bootNodes('agreed', run);
    const plans = deliveryPlans(set, forgeries, rand);
    const refused = await deliver(nodes, plans);
    ok('phase 2: every node refused the same number of forged/untyped datums',
       refused[0] === refused[1] && refused[1] === refused[2], `refused=${refused.join('/')}`);

    const pooled = nodes.map((n) => n.xclt._membershipPool.length);
    ok('phase 2: nothing sealed on arrival — every honest tx is pooled, awaiting an agreed boundary',
       new Set(pooled).size === 1 && pooled[0] === TXS, `pooled=${pooled.join('/')}`);

    // THE AGREEMENT. A seal round agrees WHICH nine are cut; here the agreed list is derived once (hash-sorted,
    // the same rule every node applies) and handed to all three, which is exactly what agreement delivers.
    const agreedIds = nodes[0].xclt._membershipPool.map((b) => b.id).sort();
    for (let i = 0; i + 9 <= agreedIds.length; i += 9) {
      const chunk = new Set(agreedIds.slice(i, i + 9));
      for (const n of nodes) await n.xclt.sealAgreedBlocks(n.xclt._membershipPool.filter((b) => chunk.has(b.id)));
    }
    const faces = nodes.map((n) => n.xclt.getPendingCubeFaces().length);
    ok('phase 2: all three cut the SAME number of faces from the agreed boundaries', new Set(faces).size === 1, `faces=${faces.join('/')}`);

    const agreedRoots = nodes[0].xclt.getPendingCubeFaces().map((f) => f.getMerkleRoot()).sort();
    for (let i = 0; i + 3 <= agreedRoots.length; i += 3) {
      const roots = agreedRoots.slice(i, i + 3);
      for (const n of nodes) await n.xclt.sealAgreedCube(n.xclt.getPendingFacesByRoots(roots));
    }

    const blocks = nodes.map((n) => allBlocks(n).length);
    const cubes = nodes.map((n) => n.xclt.cubes.size);
    const digests = nodes.map(setDigest);
    const bDigests = nodes.map(blockDigest);
    const roots = nodes.map((n) => { try { return n.xvsm.getStateRoot(); } catch { return null; } });
    console.log(`  phase 2: blocks ${blocks.join(' / ')}   cubes ${cubes.join(' / ')}`);
    console.log(`  phase 2: cube set_digest  ${digests[0].slice(0, 32)}\u2026`);
    console.log(`  phase 2: block digest     ${bDigests[0].slice(0, 32)}\u2026`);
    console.log(`  phase 2: state root       ${String(roots[0]).slice(0, 32)}\u2026`);

    ok('phase 2: all three hold the same blocks', new Set(blocks).size === 1 && blocks[0] === TXS, `blocks=${blocks.join('/')}`);
    ok('phase 2: at least one cube was sealed (a real chain, not an empty one)', cubes[0] >= 1, `cubes=${cubes[0]}`);
    ok('phase 2: all three sealed the SAME number of cubes', new Set(cubes).size === 1, `cubes=${cubes.join('/')}`);
    ok('phase 2: all three agree on the BLOCK SET digest', new Set(bDigests).size === 1);
    ok('phase 2: all three agree on the CUBE set_digest — the number the nodes compare', new Set(digests).size === 1);
    ok('phase 2: all three agree on the state root', new Set(roots.map(String)).size === 1);
    await teardown(nodes, dirs);
  }
  delete process.env.XPC_CONSENSUS_V2;
  console.log('');
}

console.log(failures === 0
  ? `REPRODUCED \u2014 ${RUNS} chaotic run(s), three full nodes each: the block set converges under any delivery order, and under agreed seal boundaries the cubes, the cube set_digest and the state root converge too.`
  : `NOT REPRODUCED \u2014 ${failures} assertion(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
