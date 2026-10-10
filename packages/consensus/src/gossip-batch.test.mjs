// ONE MESSAGE PER FLUSH, NOT ONE PER TX. Raw txs and validation reports wait up to XPC_GOSSIP_FLUSH_MS and go
// out together as {type:'batch', items}. Measured on 4 real nodes on loopback, 2000 node-signed datum txs
// (scripts/fleet-load.mjs): floodsub ed25519 checks per node 0.55 s -> 0.24 s, door 230 -> 271 tx/s.
// Pinned here, over a loopback transport that JSON-encodes like the libp2p one:
//   - a receiver hears a batch as exactly the events it would have heard from the messages sent one by one;
//   - nothing is batched while any live peer has not said it reads batches (a node on the previous release
//     ignores a type it does not know, and would lose every tx and report inside one);
//   - presence is never held back, and carries caps ['batch'];
//   - a flush is split before it reaches libp2p's 4 MiB frame limit;
//   - a batch inside a batch is dropped; destroy() sends what is waiting.
// Run: node gossip-batch.test.mjs
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { ConsensusGossip, everyLivePeerHas, GOSSIP_CAPS } from './gossip.js';

let pass = 0, fail = 0;
const check = async (n, f) => { try { await f(); console.log(`  ok   ${n}`); pass++; } catch (e) { console.log(`  FAIL ${n}\n       ${e.message}`); fail++; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A pubsub that delivers every published message, JSON round-tripped, to every other attached node.
function bus() {
  const nodes = [];
  return {
    wire: [],
    xn() {
      const xn = new EventEmitter();
      xn.started = true;
      xn.subscribe = async () => {};
      xn.publish = async (topic, msg) => {
        const json = JSON.stringify(msg);
        this.wire.push(json);
        for (const o of nodes) if (o !== xn) o.emit(`message:${topic}`, JSON.parse(json));
      };
      nodes.push(xn);
      return xn;
    },
  };
}
function listen(g) {
  const heard = [];
  g.on('raw_tx:received', (e) => heard.push(['raw_tx', e]));
  g.on('validation_report:received', (e) => heard.push(['validation_report', e]));
  g.on('presence:received', (e) => heard.push(['presence', e]));
  return heard;
}
const tx = (j, pad = 0) => ({ type: 'state_diff', function: 'put', args: { j, pad: 'x'.repeat(pad) }, sig: `s${j}` });
const report = (j) => ({ rawTxId: `r${j}`, taskId: `t${j}`, validatorId: 'v', timestamp: 1000 + j });
const pair = (canBatch) => {
  const b = bus();
  const a = new ConsensusGossip({ xn: b.xn(), canBatch: () => canBatch });
  const r = new ConsensusGossip({ xn: b.xn() });
  return { b, a, r, heard: listen(r) };
};
async function sendMix(a, n) {
  for (let j = 0; j < n; j++) {
    await a.broadcastRawTransaction('L', tx(j), ['L', 'M']);
    await a.broadcastValidationReport(report(j));
  }
}

await check('a batch is heard as exactly the events the messages sent one by one give', async () => {
  const alone = pair(false), batched = pair(true);
  await sendMix(alone.a, 50);
  await sendMix(batched.a, 50);
  await sleep(40);
  assert.strictEqual(alone.b.wire.length, 100);
  assert.strictEqual(batched.b.wire.length, 1, `${batched.b.wire.length} messages on the wire`);
  assert.strictEqual(JSON.parse(batched.b.wire[0]).type, 'batch');
  assert.strictEqual(batched.heard.length, 100);
  assert.deepStrictEqual(batched.heard, alone.heard);
  assert.deepStrictEqual(batched.a.stats, { messages: 1, batches: 1, batchedItems: 100 });
});

await check('while a peer cannot read batches every message goes out alone and at once', async () => {
  const { b, a, heard } = pair(false);
  await a.broadcastRawTransaction('L', tx(1), null);
  assert.strictEqual(b.wire.length, 1, 'not sent before the publish returned');
  assert.strictEqual(JSON.parse(b.wire[0]).type, 'raw_tx');
  assert.strictEqual(heard.length, 1);
});

await check('a flush holding one item sends it plain, not wrapped', async () => {
  const { b, a, heard } = pair(true);
  await a.broadcastRawTransaction('L', tx(7), null);
  assert.strictEqual(b.wire.length, 0, 'sent before the flush window');
  await sleep(40);
  assert.strictEqual(b.wire.length, 1);
  assert.strictEqual(JSON.parse(b.wire[0]).type, 'raw_tx');
  assert.deepStrictEqual(heard[0][1].tx, tx(7));
  assert.strictEqual(a.stats.batches, 0);
});

await check('presence is never held back and says it reads batches', async () => {
  const { b, a, heard } = pair(true);
  await a.broadcastPresence({ address: 'xmbA', publicKey: 'pk', roles: { validate: true } });
  assert.strictEqual(b.wire.length, 1);
  assert.deepStrictEqual(JSON.parse(b.wire[0]).caps, GOSSIP_CAPS);
  assert.deepStrictEqual(heard[0][1].caps, ['batch']);
});

await check('a presence without caps is heard with caps []', async () => {
  const { r, heard } = pair(false);
  r._handleMessage({ type: 'presence', address: 'old', publicKey: 'pk', roles: {} });
  assert.deepStrictEqual(heard[0][1].caps, []);
});

await check('1000 txs of about 3 KB go out in batches under the 4 MiB frame limit, all of them, in order', async () => {
  const { b, a, heard } = pair(true);
  for (let j = 0; j < 1000; j++) await a.broadcastRawTransaction('L', tx(j, 3000), null);
  await sleep(40);
  assert.ok(b.wire.length >= 3, `${b.wire.length} messages`);
  for (const w of b.wire) assert.ok(w.length < (1 << 20) + 4000, `a message of ${w.length} bytes`);
  assert.strictEqual(heard.length, 1000);
  assert.deepStrictEqual(heard.map(([, e]) => e.tx.args.j), Array.from({ length: 1000 }, (_, j) => j));
});

await check('a batch inside a batch is dropped, the items beside it are not', async () => {
  const { r, heard } = pair(false);
  r._handleMessage({ type: 'batch', items: [
    { type: 'raw_tx', leaderId: 'L', tx: tx(1) },
    { type: 'batch', items: [{ type: 'raw_tx', leaderId: 'L', tx: tx(2) }] },
    null,
    { type: 'validation_report', ...report(3) },
  ] });
  assert.deepStrictEqual(heard.map(([t, e]) => [t, e.tx?.args.j ?? e.rawTxId]), [['raw_tx', 1], ['validation_report', 'r3']]);
});

await check('destroy sends what is waiting', async () => {
  const { b, a, heard } = pair(true);
  await sendMix(a, 3);
  assert.strictEqual(b.wire.length, 0);
  await a.destroy();
  assert.strictEqual(b.wire.length, 1);
  assert.strictEqual(heard.length, 6);
});

await check('everyLivePeerHas: one live peer without the cap, or no live peer, means no', () => {
  const now = 100000, ttl = 20000;
  const reg = (rows) => new Map(rows);
  assert.strictEqual(everyLivePeerHas(reg([]), 'me', 'batch', ttl, now), false);
  assert.strictEqual(everyLivePeerHas(reg([['me', { lastSeen: now }]]), 'me', 'batch', ttl, now), false);
  assert.strictEqual(everyLivePeerHas(reg([['a', { caps: ['batch'], lastSeen: now }], ['b', { caps: ['batch'], lastSeen: now - 1 }]]), 'me', 'batch', ttl, now), true);
  assert.strictEqual(everyLivePeerHas(reg([['a', { caps: ['batch'], lastSeen: now }], ['b', { caps: [], lastSeen: now }]]), 'me', 'batch', ttl, now), false);
  assert.strictEqual(everyLivePeerHas(reg([['a', { caps: ['batch'], lastSeen: now }], ['b', { lastSeen: now }]]), 'me', 'batch', ttl, now), false);
  // A peer silent past the TTL is not counted either way.
  assert.strictEqual(everyLivePeerHas(reg([['a', { caps: ['batch'], lastSeen: now }], ['old', { caps: [], lastSeen: now - ttl - 1 }]]), 'me', 'batch', ttl, now), true);
  assert.strictEqual(everyLivePeerHas(reg([['old', { caps: ['batch'], lastSeen: now - ttl - 1 }]]), 'me', 'batch', ttl, now), false);
});

// A raw tx travels with the key it was signed under (signer-keys.js), alone as signerKey and in a batch once per
// signer under `keys`, so a receiver can check the signature before it has heard the signer's presence.
const KA = 'A'.repeat(1896), KB = 'B'.repeat(1896);
const signed = (j, from) => ({ ...tx(j), from });
await check('a batch carries each signer\'s key once and every raw tx is heard with its own signer\'s key', async () => {
  const { b, a, heard } = pair(true);
  for (let j = 0; j < 50; j++) {
    await a.broadcastRawTransaction('L', signed(j, 'xmbA'), null, KA);
    await a.broadcastRawTransaction('L', signed(100 + j, 'xmbB'), null, KB);
    await a.broadcastValidationReport(report(j));
  }
  await sleep(40);
  assert.strictEqual(b.wire.length, 1);
  assert.deepStrictEqual(JSON.parse(b.wire[0]).keys, { xmbA: KA, xmbB: KB });
  assert.strictEqual(b.wire[0].split(KA).length - 1, 1, 'signer A\'s key sent more than once');
  assert.strictEqual(b.wire[0].split(KB).length - 1, 1, 'signer B\'s key sent more than once');
  const raws = heard.filter(([t]) => t === 'raw_tx').map(([, e]) => e);
  assert.strictEqual(raws.length, 100);
  for (const e of raws) assert.strictEqual(e.signerKey, e.tx.from === 'xmbA' ? KA : KB, e.tx.args.j);
  assert.ok(b.wire[0].length < 100 * 900 + 2 * 1896, `${b.wire[0].length} bytes`);
});
await check('a raw tx sent alone, or alone in its flush, carries its key; one sent without a key is heard with null', async () => {
  const alone = pair(false);
  await alone.a.broadcastRawTransaction('L', signed(1, 'xmbA'), null, KA);
  await alone.a.broadcastRawTransaction('L', signed(2, 'xmbA'), null);
  assert.strictEqual(JSON.parse(alone.b.wire[0]).signerKey, KA);
  assert.deepStrictEqual(alone.heard.map(([, e]) => e.signerKey), [KA, null]);
  const one = pair(true);
  await one.a.broadcastRawTransaction('L', signed(3, 'xmbB'), null, KB);
  await sleep(40);
  assert.strictEqual(JSON.parse(one.b.wire[0]).type, 'raw_tx');
  assert.strictEqual(one.heard[0][1].signerKey, KB);
});
await check('a batch\'s key is handed only to raw txs from that signer, and a non-string key is ignored', async () => {
  const { r, heard } = pair(false);
  r._handleMessage({ type: 'batch', keys: { xmbA: KA, xmbC: 7, __proto__: { xmbD: 'inherited' } }, items: [
    { type: 'raw_tx', leaderId: 'L', tx: signed(1, 'xmbA') },
    { type: 'raw_tx', leaderId: 'L', tx: signed(2, 'xmbB') },
    { type: 'raw_tx', leaderId: 'L', tx: signed(3, 'xmbC') },
    { type: 'raw_tx', leaderId: 'L', tx: signed(4, 'constructor') },
    { type: 'raw_tx', leaderId: 'L', tx: signed(5, 'xmbA'), signerKey: KB },
  ] });
  assert.deepStrictEqual(heard.map(([, e]) => e.signerKey), [KA, null, null, null, KB]);
});

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
