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
await host.stop();

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
