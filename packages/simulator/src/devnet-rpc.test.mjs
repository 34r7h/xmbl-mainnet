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

  // live ledger state root (real, moves as faces seal)
  const sr = await call({ type: 'getStateRoot' });
  ok('getStateRoot returns landed count and pooled', sr.landed === 1 && typeof sr.pooled === 'number', JSON.stringify(sr));

  // ── node-side capability surface: each a REAL primitive verified + negative-controlled ──
  const zk = await call({ type: 'zkProof', derivedX: 99 });
  ok('zkProof verifies the genuine coordinate and rejects the tampered one', zk.ok === true && zk.genuineVerifies === true && zk.tamperedRejected === true, JSON.stringify(zk));

  const he1 = await call({ type: 'heAdd', a: 1, b: 0 });
  ok('heAdd: ENC(1) ⊞ ENC(0) decrypts to 1 (blind add)', he1.ok === true && he1.sum === 1, JSON.stringify(he1));
  const he2 = await call({ type: 'heAdd', a: 1, b: 1 });
  ok('heAdd: ENC(1) ⊞ ENC(1) decrypts to 0 (mod-2 wrap)', he2.ok === true && he2.sum === 0, JSON.stringify(he2));
  // the message space is a single bit: a non-bit operand is rejected, NOT silently coerced to a
  // green verdict for an operation nobody asked for
  const heBad = await call({ type: 'heAdd', a: 3, b: 5 });
  ok('heAdd rejects non-bit operands (no coerced false pass)', heBad.ok === false && /0 or 1/.test(heBad.error || ''), JSON.stringify(heBad));

  const sig = await call({ type: 'sigVerify', message: 'xbe' });
  ok('sigVerify signs+verifies and rejects a tampered message', sig.ok === true && sig.signedVerifies === true && sig.tamperedRejected === true, JSON.stringify(sig));

  const seal = await call({ type: 'seal', secret: 'authorizing-key' });
  ok('seal round-trips a secret through a PQ KEM envelope', seal.ok === true && seal.roundTrip === true, JSON.stringify(seal));

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
