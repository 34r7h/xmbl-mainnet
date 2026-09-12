// Gate test for DevnetRpc: drives the REAL loopback HTTP surface through the browser-extension's
// five background message types and asserts responses computed from REAL devnet state. Proves the
// RPC is a faithful, non-mocked drop-in for the extension's stub BackgroundNode. Self-contained;
// exits non-zero on failure.
import assert from 'node:assert/strict';
import { LocalDevnet } from './devnet.js';
import { DevnetRpc } from './devnet-rpc.js';

let pass = 0;
const ok = (name, cond, detail = '') => { assert.ok(cond, `${name}${detail ? ' — ' + detail : ''}`); console.log('  ok  ' + name); pass++; };

const net = await new LocalDevnet({ identities: 3 }).start();
const rpc = new DevnetRpc(net, { walletIndex: 0 });
const port = await rpc.listen(0);
ok('RPC listens on a loopback port', Number.isInteger(port) && port > 0, `port=${port}`);

const call = async (msg) => {
  const res = await fetch(rpc.url(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(msg) });
  return res.json();
};

try {
  // status: real running flag, peers = other identities, height starts at 0
  const s0 = await call({ type: 'getNodeStatus' });
  ok('getNodeStatus reports running', s0.running === true);
  ok('getNodeStatus peers = other identities', s0.peers === 2, `peers=${s0.peers}`);
  ok('getNodeStatus height starts at 0', s0.height === 0, `height=${s0.height}`);

  // balance: wallet (identity 0) starts at 0 — real, not fabricated
  const b0 = await call({ type: 'getBalance' });
  ok('getBalance defaults to the wallet address', b0.address === net.addressOf(0));
  ok('wallet balance starts at 0', b0.balance === 0, `balance=${b0.balance}`);

  // send a real signed+verified tx from the wallet to another participant
  const recipient = net.addressOf(1);
  const sent = await call({ type: 'sendTransaction', tx: { to: recipient, amount: 25 } });
  ok('sendTransaction returns a real landed txId', typeof sent.txId === 'string' && /^dtx_/.test(sent.txId), JSON.stringify(sent));

  // balances reflect the landed transfer (REAL applied delta), height advanced
  const br = await call({ type: 'getBalance', address: recipient });
  ok('recipient balance reflects the landed transfer', br.balance === 25, `balance=${br.balance}`);
  const bw = await call({ type: 'getBalance' });
  ok('wallet balance is negated by the send', bw.balance === -25, `balance=${bw.balance}`);
  const s1 = await call({ type: 'getNodeStatus' });
  ok('height advanced after the send', s1.height === 1, `height=${s1.height}`);

  // a malformed send is reported, not crashed
  const bad = await call({ type: 'sendTransaction', tx: { amount: 5 } });
  ok('sendTransaction without a recipient returns an error', typeof bad.error === 'string', JSON.stringify(bad));

  // unknown type is reported
  const unk = await call({ type: 'frobnicate' });
  ok('unknown message type returns an error', /Unknown message type/.test(unk.error || ''), JSON.stringify(unk));

  // node lifecycle toggles real state
  const stop = await call({ type: 'stopNode' });
  ok('stopNode succeeds', stop.success === true);
  ok('devnet actually stopped', net.isRunning() === false);
  const start = await call({ type: 'startNode' });
  ok('startNode succeeds', start.success === true);
  ok('devnet actually running again', net.isRunning() === true);

  console.log(`\n✅ devnet-rpc: ${pass} checks passed`);
} finally {
  await rpc.close();
  await net.stop();
}
process.exit(0);
