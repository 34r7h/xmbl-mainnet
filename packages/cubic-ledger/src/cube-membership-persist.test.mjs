// Cube membership must survive to DISK. _finalizeCube assigns each member block its final
// location.{faceIndex,position,cubeIndex,cubeSequentialIndex} — but every block was already db.put BEFORE that
// assignment (three put sites: addTransaction, sealAgreedBlocks, the legacy face path), so without a re-put the
// stored record keeps its pre-cube placeholder forever. That is why membership was unreadable on the live chain:
// all 2898 persisted blocks read cubeIndex=0 / faceIndex=0 / cubeSequentialIndex=null — one value each, zero bits.
// The cube record cannot answer it either: cubeData.faces holds face INDICES [0,1,2], never ids.
//
// This test reads the LEVEL STORE BACK FROM DISK after a seal, so it fails if the re-put is removed. Reading
// ledger.blocks (the in-memory map) instead would pass either way — the mutation always happens in memory.
// Run: node cube-membership-persist.test.mjs
import { Ledger } from './ledger.js';
import { micromine, type6TxBody } from './micromine.js';
import { Level } from 'level';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const check = (n, c) => { assert.ok(c, n); console.log('  ok  ', n); pass++; };

const dbPath = fs.mkdtempSync(path.join(os.tmpdir(), 'xclt-membership-'));
// Real type-6 txs: transaction-validator enforces that xid content-addresses the canonical body at the given
// nonce, so a hand-written xid is rejected at Block.fromTransaction. Mine each one the way the emitter does.
const mkTx = (i) => {
  const t = { type: 'tx', chain: 'xmbl', from: ['agent-a'], to: ['agent-b'], asset: 'USDC', amount: '0.01', seq: i, prev: '', unspent: '' };
  const { xid, nonce } = micromine(type6TxBody(t), 6);
  return { ...t, xid, nonce };
};

const ledger = new Ledger({ dbPath, consensusV2: true });
// _initDb() is fired from the constructor and not awaited; the puts under test are all guarded by _dbOpen, so
// give it a tick to land. Without this the test would pass vacuously (every put skipped).
for (let i = 0; i < 200 && !ledger._dbOpen; i++) await new Promise((r) => setTimeout(r, 10));
check('level store opened (guards the whole test against passing vacuously)', ledger._dbOpen === true);

// 27 txs -> pool. consensusV2 pools instead of local-sealing.
await ledger.addSealedBatch(Array.from({ length: 27 }, (_, i) => mkTx(i)));
check('27 blocks pooled, none sealed locally', ledger.getMembershipPool().length === 27);

// L1: three quorum-agreed 9-block sets -> three faces.
const pool = [...ledger.getMembershipPool()];
const faces = [];
for (let i = 0; i < 3; i++) faces.push(await ledger.sealAgreedBlocks(pool.slice(i * 9, i * 9 + 9)));
check('three faces sealed from the agreed sets', faces.filter(Boolean).length === 3);

// A block persisted by sealAgreedBlocks carries the PLACEHOLDER cube location — this is the pre-fix state, and
// it is the negative control: it proves the assertion below can distinguish "re-put happened" from "reader is
// always green". Read from disk, not from memory.
// level is single-writer, so these read through the ledger's OWN handle — still the PERSISTED record (a level
// get goes to the store, never to ledger.blocks), which is what the assertion needs. The final scan re-opens a
// fresh handle after close() to prove the write is durable and not just in an unflushed cache.
const readBlock = async (db, id) => JSON.parse(await db.get(`block:${id}`));
{
  const b = await readBlock(ledger.db, pool[0].id);
  check('NEGATIVE CONTROL: pre-cube, stored record has cubeIndex 0 / cubeSequentialIndex null', b.location.cubeIndex === 0 && b.location.cubeSequentialIndex === null);
}

// L2: the agreed 3 faces -> one content-keyed cube. This calls _finalizeCube.
const cube = await ledger.sealAgreedCube(faces);
check('cube assembled from the three agreed faces', !!cube && cube.faces.size === 3);

// THE ASSERTION: every member block's PERSISTED location names the cube.
{
  const members = [];
  for (const face of cube.faces.values()) for (const b of face.blocks.values()) members.push(b.id);
  check('cube has 27 member blocks', members.length === 27);

  let named = 0; const faceIdxSeen = new Set(), posSeen = new Set();
  for (const id of members) {
    const rec = await readBlock(ledger.db, id);
    if (rec.location.cubeIndex === cube.id) named++;
    faceIdxSeen.add(rec.location.faceIndex);
    posSeen.add(rec.location.position);
  }
  check(`all 27 persisted blocks name the cube (${named}/27 have location.cubeIndex === "${cube.id}")`, named === 27);
  check('persisted faceIndex spans all three faces (0,1,2) — not one collapsed value', faceIdxSeen.size === 3);
  check('persisted position spans all nine slots — not one collapsed value', posSeen.size === 9);
}

// DURABILITY + the membership join, stated as the query a reader would actually run, against a FRESH handle.
await ledger.db.close().catch(() => {});
{
  const probe = new Level(dbPath); await probe.open();
  const found = [];
  for await (const [k, v] of probe.iterator()) {
    if (!k.startsWith('block:')) continue;
    const rec = JSON.parse(v);
    if (rec.location?.cubeIndex === cube.id) found.push(rec.tx?.xid);
  }
  check('membership is READABLE after reopen: scanning blocks by location.cubeIndex returns exactly the 27 member xids', found.length === 27 && new Set(found).size === 27);
  await probe.close();
}

fs.rmSync(dbPath, { recursive: true, force: true });
console.log(`\n${pass} checks passed`);
