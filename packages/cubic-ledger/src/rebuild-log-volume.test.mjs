import { createHash } from 'node:crypto';
// A CANONICAL REBUILD PRINTS ONE LINE, NOT ONE PER FACE AND CUBE. Every face and cube a rebuild sealed printed a
// progress line; node.log on the operator's MacBook reached 6.08 GB at ~84 KB/s (measured 2026-11-09), and 99.9%
// of a 20 MB tail of it was those lines. They are debug output now: on under LOG_LEVEL=debug or XMBL_LEDGER_DEBUG=1.
import { test } from 'node:test';
import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { Ledger } from './ledger.js';
import { micromineTx } from './transaction-validator.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const anchors = Array.from({ length: 243 }, (_, i) => {
  const t = micromineTx({ type: 'anchor', event: 'task.created', hash: createHash('sha256').update(`log-volume-${i}`).digest('hex'), ts: 1000 + i });
  return { event: t.event, hash: t.hash, ts: t.ts, xid: t.xid, nonce: t.nonce, prior: t.prior };
});

async function linesDuringRebuild(env) {
  const saved = { L: process.env.LOG_LEVEL, D: process.env.XMBL_LEDGER_DEBUG };
  delete process.env.LOG_LEVEL; delete process.env.XMBL_LEDGER_DEBUG;
  Object.assign(process.env, env);
  const dir = `/tmp/xclt-logvol-${process.pid}-${Object.keys(env).join('') || 'none'}`;
  rmSync(dir, { recursive: true, force: true });
  const led = new Ledger({ dbPath: dir });
  for (let i = 0; i < 100 && !led._dbOpen; i++) await sleep(50);
  const lines = [];
  const orig = console.log;
  console.log = (...a) => { lines.push(a.join(' ')); };
  let r;
  try { r = await led.rebuildFromAnchors(anchors); } finally {
    console.log = orig;
    if (saved.L === undefined) delete process.env.LOG_LEVEL; else process.env.LOG_LEVEL = saved.L;
    if (saved.D === undefined) delete process.env.XMBL_LEDGER_DEBUG; else process.env.XMBL_LEDGER_DEBUG = saved.D;
    await led.db.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
  return { lines, r };
}

test('a rebuild of 243 anchors prints one summary line by default', async () => {
  const { lines, r } = await linesDuringRebuild({});
  assert.ok(r.faces_sealed >= 27, `the fixture must seal faces (sealed ${r.faces_sealed})`);
  assert.strictEqual(lines.length, 1, `expected the one summary line, got ${lines.length}:\n${lines.slice(0, 5).join('\n')}`);
  assert.match(lines[0], /\[XCLT\] canonical rebuild/);
});

test('LOG_LEVEL=debug and XMBL_LEDGER_DEBUG=1 bring the per-face lines back', async () => {
  for (const env of [{ LOG_LEVEL: 'debug' }, { XMBL_LEDGER_DEBUG: '1' }]) {
    const { lines, r } = await linesDuringRebuild(env);
    const faces = lines.filter((l) => l.startsWith('Face complete')).length;
    assert.strictEqual(faces, r.faces_sealed, `${JSON.stringify(env)}: one line per sealed face`);
  }
});
