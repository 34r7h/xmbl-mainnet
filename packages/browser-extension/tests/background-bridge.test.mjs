// Proves the extension's node bridge (src/background.js) is wired to a REAL XMBL devnet — not a
// stub. It stands up an actual LocalDevnet + DevnetRpc (packages/simulator), points a
// BackgroundNode at it, and asserts the five wallet/node messages proxy real state: a signed tx
// lands and moves real balances/height, status reports the real figures, and the lifecycle
// toggles the real node. It then points a BackgroundNode at a dead port and asserts the bridge
// degrades TRUTHFULLY (connected:false, balance 0, send errors) rather than fabricating.
//
// Self-contained; exits non-zero on failure. Run by `npm test -w packages/browser-extension`.
// (Not in the protocol hard gate — the extension is a client package.)
import assert from 'node:assert/strict';
import { LocalDevnet } from '../../simulator/src/devnet.js';
import { DevnetRpc } from '../../simulator/src/devnet-rpc.js';

// webextension-polyfill requires a chrome.* surface at import; provide one BEFORE importing
// background.js (dynamic import so the shim is in place first). No onInstalled ⇒ no self-start.
globalThis.chrome = {
  runtime: { id: 'xmbl-bridge-test' },
  storage: { local: { get: (keys, cb) => cb({}) } },
};
const { BackgroundNode } = await import('../src/background.js');

let pass = 0;
const ok = (name, cond, detail = '') => { assert.ok(cond, `${name}${detail ? ' — ' + detail : ''}`); console.log('  ok  ' + name); pass++; };

const net = await new LocalDevnet({ identities: 3 }).start();
const rpc = new DevnetRpc(net, { walletIndex: 0 });
const port = await rpc.listen(0);
const bg = new BackgroundNode({ devnetUrl: `http://127.0.0.1:${port}` });

try {
  // ── CONNECTED: the bridge reads/writes REAL devnet state ──
  const s0 = await bg.getNodeStatus();
  ok('getNodeStatus is connected and running', s0.connected === true && s0.running === true);
  ok('getNodeStatus peers = other identities', s0.peers === 2, `peers=${s0.peers}`);
  ok('getNodeStatus height starts at 0', s0.height === 0, `height=${s0.height}`);

  const b0 = await bg.getBalance('current'); // popup sends 'current' for the wallet
  ok("getBalance('current') resolves the wallet, starts at 0", b0.balance === 0 && b0.connected === true);

  const sent = await bg.sendTransaction({ to: net.addressOf(1), amount: 25 });
  ok('sendTransaction lands a REAL tx and returns its id', typeof sent.txId === 'string' && /^dtx_/.test(sent.txId), JSON.stringify(sent));

  const bw = await bg.getBalance('current');
  ok('wallet balance reflects the sent 25 (negated)', bw.balance === -25, `balance=${bw.balance}`);
  const br = await bg.getBalance(net.addressOf(1));
  ok('recipient balance reflects the received 25', br.balance === 25, `balance=${br.balance}`);
  const s1 = await bg.getNodeStatus();
  ok('height advanced to 1 after the send', s1.height === 1, `height=${s1.height}`);

  // lifecycle toggles the real node
  const stop = await bg.stopNode();
  ok('stopNode succeeds', stop.success === true);
  ok('status shows stopped after stopNode', (await bg.getNodeStatus()).running === false);
  const start = await bg.startNode();
  ok('startNode succeeds', start.success === true);
  ok('status shows running after startNode', (await bg.getNodeStatus()).running === true);

  // ── OFFLINE: a dead endpoint degrades TRUTHFULLY, never fabricates ──
  const off = new BackgroundNode({ devnetUrl: 'http://127.0.0.1:1' });
  const so = await off.getNodeStatus();
  ok('offline getNodeStatus reports disconnected + stopped', so.connected === false && so.running === false);
  const bo = await off.getBalance('current');
  ok('offline getBalance is 0 + disconnected (not a fabricated figure)', bo.balance === 0 && bo.connected === false);
  const to = await off.sendTransaction({ to: net.addressOf(1), amount: 5 });
  ok('offline sendTransaction errors instead of returning a fake txId', typeof to.error === 'string' && !to.txId, JSON.stringify(to));

  console.log(`\n✅ background bridge: ${pass} checks passed`);
} finally {
  await rpc.close();
  await net.dispose();
}
process.exit(0);
