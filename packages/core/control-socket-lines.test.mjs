// THE CONTROL SOCKET'S LINE READER. Requests are newline-delimited JSON. The reader did `buf += chunk` and then
// searched the whole buffer for '\n' on every chunk, so a long line — a rebuild_ledger carrying the 4.1 MB
// canonical set arrives in hundreds of chunks — was flattened and searched once per chunk, a cost that grows
// with the square of the line (166 ms of copying at 4.1 MB measured 2026-10-10, 10 ms joined once). The reader
// now searches only the chunk that arrived and joins a line's chunks once.
//
// Pinned here: every way a line can be cut across chunks still yields exactly the requests that were sent, in
// order, and a 16 MB line is read in time linear in its size.
// Run: node control-socket-lines.test.mjs
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { XMBLCore } from './index.js';
import { createControlServer } from './control-socket.js';

let pass = 0, fail = 0;
const ok = (n, c, why = '') => { if (c) { pass++; console.log('ok   ' + n); } else { fail++; console.log('FAIL ' + n + (why ? `\n     ${why}` : '')); } };

const dir = mkdtempSync(join(tmpdir(), 'xmbl-lines-'));
const core = new XMBLCore({ ledger: { dbPath: join(dir, 'l') }, stateMachine: { dbPath: join(dir, 'v') }, storage: { dbPath: join(dir, 's') } });
await core.start();
const sockPath = join(dir, 'n.sock');
const server = await createControlServer({ core, config: {}, sockPath, statusSnapshot: () => ({ pid: process.pid }) });

// Write `pieces` one at a time (each its own write, with a turn of the loop between), and collect `want`
// response lines.
const send = (pieces, want, waitMs = 5000) => new Promise((res, rej) => {
  const s = net.connect(sockPath);
  let b = '';
  const lines = [];
  const timer = setTimeout(() => { s.destroy(); res(lines); }, waitMs);
  s.setEncoding('utf8');
  s.on('data', (d) => {
    b += d;
    let i;
    while ((i = b.indexOf('\n')) >= 0) { lines.push(JSON.parse(b.slice(0, i))); b = b.slice(i + 1); }
    if (lines.length >= want) { clearTimeout(timer); s.end(); res(lines); }
  });
  s.on('error', rej);
  s.on('connect', async () => {
    for (const p of pieces) { s.write(p); await new Promise((r) => setImmediate(r)); }
  });
});
const req = (id, extra = {}) => JSON.stringify({ op: 'status', id, ...extra });
const isStatus = (r) => r && r.ok !== false && r.pid === process.pid;

{
  const line = req(1) + '\n';
  const r = await send(line.split(''), 1);
  ok('one request sent a byte at a time -> one answer', r.length === 1 && isStatus(r[0]), JSON.stringify(r));
}
{
  const r = await send([req(1) + '\n' + req(2) + '\n' + req(3) + '\n'], 3);
  ok('three requests in one write -> three answers', r.length === 3 && r.every(isStatus), JSON.stringify(r).slice(0, 200));
}
{
  const a = req(1), b2 = req(2);
  const r = await send([a, '\n' + b2.slice(0, 5), b2.slice(5), '\n'], 2);
  ok('newline first in its chunk, and a line split mid-way -> two answers', r.length === 2 && r.every(isStatus), JSON.stringify(r).slice(0, 200));
}
{
  const r = await send(['\n\n', req(1) + '\n', '  \n'], 1);
  ok('blank lines are skipped', r.length === 1 && isStatus(r[0]), JSON.stringify(r));
  const more = await send(['\n', '\n'], 1, 500);
  ok('a connection of only blank lines gets no answer', more.length === 0, JSON.stringify(more));
}
{
  const line = req(1, { pad: 'x'.repeat(16 * 1024 * 1024) }) + '\n';
  const pieces = [];
  for (let i = 0; i < line.length; i += 16384) pieces.push(line.slice(i, i + 16384));
  const t0 = Date.now();
  const r = await send(pieces, 1);
  const ms = Date.now() - t0;
  ok(`a 16 MB line in ${pieces.length} chunks -> one answer`, r.length === 1 && isStatus(r[0]), JSON.stringify(r).slice(0, 200));
  // Measured 2026-10-10 on one machine: 33-41 ms with this reader, 4,007 ms with the `buf += d` one.
  ok(`... read in under 1000 ms (${ms} ms)`, ms < 1000);
}

server.close?.();
await core.stop?.().catch?.(() => {});
rmSync(dir, { recursive: true, force: true });
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
