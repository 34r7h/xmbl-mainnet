// ⛔ EVERY PEER THE RANDOM WALK MEETS MUST BE COLLECTABLE ONCE IT HAS BEEN HANDED OVER.
//
// libp2p 3.3.11's RandomWalk.walk() leaks one abort listener — holding the walked peer — per peer, for as long as
// the walk runs (random-walk-leak.js has the measurement: 2,838 of each object in 7.5 min, heap OOM every 30-45 min
// on the 173.255.233.69 node). This asserts the OUTCOME on a started node: walk thousands of peers through a live
// walk, keep the walk running (as relay discovery does in production), force GC, and count how many walked peers
// were actually freed. The negative control runs the SAME measurement against libp2p's own walk() and must show
// them retained — otherwise this test could pass against the leak.
import v8 from 'node:v8';
import vm from 'node:vm';
import { XNNode } from './node.js';
import { plugRandomWalkLeak } from './random-walk-leak.js';

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc');

let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); if (!ok) failures++; };
const N = 3000;

// The started node's own RandomWalk is busy with relay discovery (and its real DHT, which has no peers here), so the
// measurement runs on a FRESH instance of the very same class the node loaded, fed by a peer router that never runs
// dry — exactly a box that has peers to walk. The fix under test is the same plugRandomWalkLeak() the node applies.
const host = new XNNode({ addresses: ['/ip4/127.0.0.1/tcp/0'], mdns: false });
await host.start();
const live = host.node.components.randomWalk;
check('the started node runs the replaced walk (the fix is wired in, not just written)', live.__xmblWalkLeakPlugged === true && live.walk !== Object.getPrototypeOf(live).walk);
const RandomWalk = Object.getPrototypeOf(live).constructor;

async function measure({ fix }) {
  let seq = 0;
  const rw = new RandomWalk({
    logger: host.node.components.logger,
    peerRouting: {
      async *getClosestPeers() {
        while (true) {
          await new Promise((r) => setImmediate(r));
          yield { id: { toString: () => `walked-${seq}` }, seq: seq++, multiaddrs: [], payload: new Uint8Array(1024) };
        }
      },
    },
  });
  rw.start();
  if (fix) plugRandomWalkLeak({ components: { randomWalk: rw } });
  let freed = 0;
  const registry = new FinalizationRegistry(() => { freed++; });
  const it = rw.walk({});
  for (let i = 0; i < N; i++) {
    const { value } = await it.next();
    registry.register(value, value.seq);
  }
  // The walk is still alive here — `it` has not returned — which is the production condition.
  for (let i = 0; i < 6; i++) { gc(); await new Promise((r) => setTimeout(r, 50)); }
  const result = freed;
  await it.return();
  rw.stop();
  return result;
}

const fixed = await measure({ fix: true });
check(`with the fix, walked peers are freed while the walk keeps running (${N} walked)`, fixed >= N * 0.9, `${fixed} of ${N} freed`);

const control = await measure({ fix: false });
check(`CONTROL: libp2p's own walk() retains the walked peers (${N} walked)`, control <= N * 0.1, `${control} of ${N} freed`);

// ⛔ THE WALK IS PACED. libp2p's startWalk() starts the next DHT query the moment the last one ends; on a small mesh
// that is ~500 queries a second (random-walk-leak.js has the measurement). Each case below drives a fresh RandomWalk
// whose router answers on the next turn of the event loop, and counts how many queries it ran.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function paced(router, gaps, fix = true) {
  const rw = new RandomWalk({ logger: host.node.components.logger, peerRouting: { getClosestPeers: router } });
  rw.start();
  if (fix) plugRandomWalkLeak({ components: { randomWalk: rw } }, gaps);
  return rw;
}
// A consumer that keeps asking for peers until told to stop, as relay discovery does.
function consume(rw) {
  const got = [];
  let stop = false;
  const done = (async () => { for await (const p of rw.walk({})) { got.push(p); if (stop) break; } })().catch(() => {});
  return { got, end: async () => { stop = true; await Promise.race([done, sleep(200)]); } };
}
const tick = () => new Promise((r) => setImmediate(r));
const samePeer = (calls) => async function* () { calls.n++; await tick(); yield { id: { toString: () => 'only-peer' }, multiaddrs: [] }; };

{
  const calls = { n: 0 };
  const rw = paced(samePeer(calls), { minGapMs: 50, maxGapMs: 400 });
  const c = consume(rw);
  await sleep(1000);
  await c.end();
  rw.stop();
  const ctl = { n: 0 };
  const raw = paced(samePeer(ctl), null, false);
  const c2 = consume(raw);
  await sleep(1000);
  await c2.end();
  raw.stop();
  check('a walk that keeps meeting the same peer backs off instead of querying in a loop', calls.n >= 3 && calls.n <= 10,
    `${calls.n} queries in 1 s at 50 ms doubling to 400 ms; libp2p's own startWalk ran ${ctl.n}`);
  check('CONTROL: libp2p\'s own startWalk queries in a loop', ctl.n > 100, `${ctl.n} queries in 1 s`);
}

{
  const calls = { n: 0 };
  const rw = paced(samePeer(calls), { minGapMs: 10000, maxGapMs: 60000 });
  const t0 = Date.now();
  const it = rw.walk({});
  const first = await Promise.race([it.next(), sleep(1000).then(() => null)]);
  check('the first query runs at once', first?.value?.id?.toString() === 'only-peer' && Date.now() - t0 < 500, `${Date.now() - t0} ms`);
  // The walk is now in its 10 s pause; the last consumer leaving must end it now, not after the pause.
  await it.return();
  await sleep(50);
  check('the last consumer leaving ends a walk that is mid-pause', rw.walking === false && calls.n === 1, `walking=${rw.walking} queries=${calls.n}`);
  rw.stop();
}

{
  let seq = 0;
  const calls = { n: 0 };
  const rw = paced(async function* () { calls.n++; await tick(); yield { id: { toString: () => `new-${seq++}` }, multiaddrs: [] }; }, { minGapMs: 50, maxGapMs: 400 });
  const c = consume(rw);
  await sleep(1000);
  await c.end();
  rw.stop();
  check('a walk that keeps meeting new peers keeps the shortest gap', calls.n >= 12 && calls.n <= 25, `${calls.n} queries in 1 s at a 50 ms gap`);
}

{
  // A walk() that arrives while the previous walk is winding down (its last consumer just left) must still get peers.
  const calls = { n: 0 };
  const rw = paced(samePeer(calls), { minGapMs: 10000, maxGapMs: 60000 });
  const a = rw.walk({});
  await a.next();
  const left = a.return();
  const b = rw.walk({});
  await left;
  const got = await Promise.race([b.next(), sleep(1000).then(() => null)]);
  check('a consumer that arrives as the walk winds down still gets a peer', got?.value?.id?.toString() === 'only-peer', `queries=${calls.n}`);
  await b.return();
  rw.stop();
}
await host.stop();

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
