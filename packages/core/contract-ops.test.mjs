// CONTRACT EXECUTION THROUGH A REAL NODE — the seam that existed, was tested, and was never plugged in.
//
// `ComputeNode` has taken a `contractHost` option since it was written and `runContract()` uses it, but
// `XMBLCore` never passed one: on every deployed node `contractHost` was null and every contract call
// answered "contract execution is not enabled". @xmbl/contracts' own suite passed throughout, because it
// wires the host itself — which is precisely why a package suite cannot close this. So these assert
// against a REAL XMBLCore over its REAL VerkleStateTree and its REAL ledger, through the control socket a
// coordinator actually speaks, and they read the store AFTER each call rather than trusting a reply flag.
//
// Covered: the role gate (and that a half-configured node refuses to boot rather than lie), deploy from
// LNG source and from raw WASM, persisted state across calls, the state root moving, deploy and call both
// ANCHORED as blocks, replay of a deployment from the block store after a restart, a revert applying
// nothing, and — the operator's settlement question — exactly which host capabilities an LNG contract can
// reach today.
import assert from 'node:assert';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { XMBLCore } from './index.js';
import { createControlServer, replayContracts } from './control-socket.js';
import { compile } from '@xmbl/lng';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('ok   ' + n); } else { fail++; console.log('FAIL ' + n); } };
const check = async (n, f) => { try { await f(); pass++; console.log('ok   ' + n); } catch (e) { fail++; console.log(`FAIL ${n}\n       ${e.message}`); } };

const call = (sockPath, req) => new Promise((res, rej) => {
  const s = net.connect(sockPath);
  let b = '';
  s.on('data', (d) => { b += d; const i = b.indexOf('\n'); if (i >= 0) { s.end(); res(JSON.parse(b.slice(0, i))); } });
  s.on('error', rej);
  s.on('connect', () => s.write(JSON.stringify(req) + '\n'));
});

// A stateful counter in LNG. `count` is a `~u256` public field, so it persists through the byte-pointer
// state ABI — the only way `bump` can return 7 on the second call is by reading the first call's
// COMMITTED write back out of the node's Verkle tree.
const COUNTER_SRC = '~contract `C {\n  ~state { ~public { `count ~u256 0 } }\n  ~on `bump(`n ~u256) { `count = `count + `n; return `count }\n}';
// Reverts on division by zero — the EVM/WASM/interpreter all agree a revert is a revert.
const REVERT_SRC = '~contract `R {\n  ~state { ~public { `v ~u256 1 } }\n  ~on `boom(`d ~u256) { `v = 99; return `v / `d }\n}';

async function bootNode(dir, roles) {
  const core = new XMBLCore({
    roles,
    ledger: { dbPath: join(dir, 'l') },
    stateMachine: { dbPath: join(dir, 'v') },
    storage: { dbPath: join(dir, 's') },
  });
  await core.start();
  const sockPath = join(dir, 'n.sock');
  const server = await createControlServer({ core, config: {}, sockPath, statusSnapshot: () => ({ pid: process.pid }) });
  return { core, server, sockPath };
}

// ── 1. THE ROLE GATE ───────────────────────────────────────────────────────────────────────────────
const offDir = mkdtempSync(join(tmpdir(), 'xmbl-xcl-off-'));
{
  const { core, server, sockPath } = await bootNode(offDir, {});
  ok('a node WITHOUT roles.contracts has no contractHost', core.contractHost === null);
  const d = await call(sockPath, { op: 'contract_deploy', lng_source: COUNTER_SRC });
  ok('contract_deploy is refused with the role named, not a null-pointer crash',
    d.ok === false && /roles\.contracts/.test(d.error));
  const c = await call(sockPath, { op: 'contract_call', contract_id: 'x', method: 'y' });
  ok('contract_call is refused the same way', c.ok === false && /roles\.contracts/.test(c.error));
  server.close();
  await core.stop?.();
}

// A config asking for contracts WITHOUT compute must not boot half-on: answering the role while every
// call returns "not enabled" is the exact failure this feature exists to end.
const badDir = mkdtempSync(join(tmpdir(), 'xmbl-xcl-bad-'));
await check('roles.contracts without roles.compute REFUSES to start, naming why', async () => {
  const core = new XMBLCore({
    roles: { contracts: true },
    ledger: { dbPath: join(badDir, 'l') }, stateMachine: { dbPath: join(badDir, 'v') }, storage: { dbPath: join(badDir, 's') },
  });
  await assert.rejects(() => core.start(), /roles\.contracts requires roles\.compute/);
  await core.stop?.();
});

// ── 2. THE REAL THING ──────────────────────────────────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), 'xmbl-xcl-'));
const { core, server, sockPath } = await bootNode(dir, { compute: true, contracts: true });

ok('a node WITH roles.contracts holds a ContractHost', !!core.contractHost);
ok('the host writes through the node\'s REAL VerkleStateTree, not a private store',
  core.contractHost.state === core.xvsm.stateTree);
ok('the compute node was handed the same host', core.computeNode.contractHost === core.contractHost);

const rootAtBoot = core.xvsm.getStateRoot();

// DEPLOY FROM LNG SOURCE. The daemon compiles, so the bytes anchored are the bytes it executes.
const dep = await call(sockPath, { op: 'contract_deploy', lng_source: COUNTER_SRC, slots: [0] });
ok('contract_deploy from lng_source returns a contract_id and coordinates',
  dep.ok === true && typeof dep.contract_id === 'string' && dep.contract_id.length > 0 && !!dep.coordinates);
ok('it reports that it compiled from LNG, and the module size', dep.compiled_from_lng === true && dep.bytes > 0);
ok('OUTCOME: the node holds the contract', core.contractHost.contracts.has(dep.contract_id));

// DEPLOYMENT IS ANCHORED. A deploy that lives only in this process is not a deployment.
ok('the deploy was anchored as a block and carries a tx_id', dep.anchored === true && typeof dep.tx_id === 'string');
let contractBlocks = 0, deployedBytecode = null;
for await (const [, v] of core.xclt.db.iterator({ gte: 'block:', lt: 'block;' })) {
  const tx = JSON.parse(v.toString()).tx;
  if (tx && tx.type === 'contract' && tx.contractHash === dep.contract_id) { contractBlocks++; deployedBytecode = tx.bytecode; }
}
ok('OUTCOME: a type-4 contract block carrying the bytecode is on disk', contractBlocks === 1 && !!deployedBytecode);

// THE BYTES ON THE CHAIN ARE THE BYTES THE NODE RUNS — not a re-compilation that might differ.
ok('OUTCOME: the anchored bytecode is byte-identical to the deployed module',
  Buffer.from(deployedBytecode, 'base64').equals(Buffer.from(core.contractHost.contracts.get(dep.contract_id).wasm)));

// CALL IT. Twice, with different arguments, so the second result can only be right if the first write
// was committed to — and read back out of — the real Verkle tree.
const c1 = await call(sockPath, { op: 'contract_call', contract_id: dep.contract_id, method: 'bump', params: [5] });
ok('contract_call returns a result and a write set', c1.ok === true && c1.result === '5' && c1.write_set.length >= 1);
ok('the state root MOVED', c1.root_moved === true && c1.state_root !== c1.state_root_before);

const c2 = await call(sockPath, { op: 'contract_call', contract_id: dep.contract_id, method: 'bump', params: [2] });
ok('OUTCOME: state PERSISTED across calls — 5 then +2 reads back as 7, from the node\'s own tree',
  c2.ok === true && c2.result === '7');
ok('OUTCOME: the node\'s state root advanced past its boot value', core.xvsm.getStateRoot() !== rootAtBoot);
ok('the reported root is the node\'s actual root, not a private one', c2.state_root === core.xvsm.getStateRoot());

// THE RECEIPT IS ANCHORED TOO.
ok('the call was anchored as a block with a tx_id', c1.anchored === true && typeof c1.tx_id === 'string');
let diffBlocks = 0, receipt = null;
for await (const [, v] of core.xclt.db.iterator({ gte: 'block:', lt: 'block;' })) {
  const tx = JSON.parse(v.toString()).tx;
  if (tx && tx.type === 'state_diff' && tx.contractAddress === dep.contract_id) { diffBlocks++; receipt = tx; }
}
ok('OUTCOME: type-5 state_diff receipts are on disk, one per call', diffBlocks === 2);
ok('the receipt names the method, the caller and the applied write set',
  receipt.function === 'bump' && typeof receipt.caller === 'string' && Array.isArray(receipt.args.writes) && receipt.args.writes.length >= 1);

// THE `contracts` OP — what this node actually holds.
const listed = await call(sockPath, { op: 'contracts' });
ok('the contracts op lists the deployment with its host flags',
  listed.ok === true && listed.count === 1 && listed.contracts[0].contract_id === dep.contract_id
  && listed.contracts[0].hosts.byteState === true);

// ── 3. RAW WASM DEPLOY ─────────────────────────────────────────────────────────────────────────────
const rawBytes = compile(COUNTER_SRC, { hostState: true });
const depRaw = await call(sockPath, { op: 'contract_deploy', wasm: Buffer.from(rawBytes).toString('base64'), slots: [0] });
ok('contract_deploy accepts base64 wasm directly', depRaw.ok === true && depRaw.compiled_from_lng === false);
ok('OUTCOME: identical bytes place at the identical content-addressed id (deploy is idempotent)',
  depRaw.contract_id === dep.contract_id);

// ── 4. A REVERT IS A RESULT, AND IT APPLIES NOTHING ────────────────────────────────────────────────
const depRev = await call(sockPath, { op: 'contract_deploy', lng_source: REVERT_SRC, slots: [0] });
ok('setup: the reverting contract deployed', depRev.ok === true);
const rootBeforeRevert = core.xvsm.getStateRoot();
const rev = await call(sockPath, { op: 'contract_call', contract_id: depRev.contract_id, method: 'boom', params: [0] });
ok('a reverting call answers ok:false with reverted:true, and does not crash the daemon', rev.ok === false && rev.reverted === true);
ok('OUTCOME: the state root is UNCHANGED after a revert — nothing was applied',
  core.xvsm.getStateRoot() === rootBeforeRevert && rev.state_root === rootBeforeRevert);
// The daemon is still answering after a guest trap — the whole point of the sandbox.
ok('the node still answers after a revert', (await call(sockPath, { op: 'status' })).ok === true);

// ── 5. REFUSALS ────────────────────────────────────────────────────────────────────────────────────
ok('contract_deploy with neither wasm nor lng_source is refused',
  (await call(sockPath, { op: 'contract_deploy' })).ok === false);
ok('contract_call with no method is refused',
  (await call(sockPath, { op: 'contract_call', contract_id: dep.contract_id })).ok === false);
const unknown = await call(sockPath, { op: 'contract_call', contract_id: 'deadbeef', method: 'bump', params: [1] });
ok('calling an unknown contract reverts rather than throwing out of the daemon',
  unknown.ok === false && /unknown contract/.test(unknown.error));
const badSrc = await call(sockPath, { op: 'contract_deploy', lng_source: 'this is not lng' });
ok('an uncompilable lng_source is refused with the compiler\'s reason', badSrc.ok === false && /lng compile failed/.test(badSrc.error));
const tooBig = await call(sockPath, { op: 'contract_deploy', wasm: Buffer.alloc(300 * 1024).toString('base64') });
ok('a module larger than a block should carry is refused', tooBig.ok === false && /capped at/.test(tooBig.error));

// ── 6. THE SETTLEMENT QUESTION, MEASURED ───────────────────────────────────────────────────────────
// The operator's expectation is that ZK and FHE let an XMBL contract authorize settlement elsewhere. The
// host functions are real and XCL binds them — but the LNG backend has no builtin that emits them, so a
// `~contract` cannot CALL them today. Asserting that here means the day LNG grows the builtin, this test
// fails and the capability gets re-measured rather than assumed.
for (const flag of ['zk_host', 'he_host', 'fhe_host', 'air_host']) {
  const r = await call(sockPath, { op: 'contract_deploy', lng_source: COUNTER_SRC, [flag]: true });
  ok(`lng_source + ${flag} is REFUSED and names the reachable backends (LNG has no such builtin)`,
    r.ok === false && /cannot reach/.test(r.error) && Array.isArray(r.lng_backends));
}
// What an LNG contract CAN reach is the signature verifiers — the ones a settlement authorization needs.
// A ~bytes LITERAL is how a message reaches a verifier — as a PARAM it is refused, because a committed
// field and a call argument are both 32-byte words with nowhere to carry a length.
const SIG_SRC = "~contract `S {\n  ~state { ~public { `okd ~u256 0 } }\n  ~on `att() { `okd = `xmbl.mayo.verify('0b16212c3742'); return `okd }\n}";
await check('LNG CAN emit the crypto verifiers, so a contract can gate on a real signature', async () => {
  const bytes = compile(SIG_SRC, { hostState: true, crypto: true });
  assert.ok(bytes.length > 0, 'compiled');
  const d = await call(sockPath, { op: 'contract_deploy', lng_source: SIG_SRC, crypto_host: true, slots: [0] });
  assert.strictEqual(d.ok, true, d.error || 'deploy failed');
  const listed = await call(sockPath, { op: 'contracts' });
  const row = listed.contracts.find((c) => c.contract_id === d.contract_id);
  assert.strictEqual(row.hosts.crypto, true, 'the node records that this contract holds the crypto capability');
});

server.close();
await core.stop?.();

// ── 7. REPLAY AFTER A RESTART ──────────────────────────────────────────────────────────────────────
// A contract the chain records must be executable by a node that never received the deploy CALL. Without
// the replay the first call after a restart answers "unknown contract" for a contract on its own disk.
await check('a RESTARTED node re-deploys every contract from its own block store', async () => {
  const core2 = new XMBLCore({
    roles: { compute: true, contracts: true },
    ledger: { dbPath: join(dir, 'l') }, stateMachine: { dbPath: join(dir, 'v') }, storage: { dbPath: join(dir, 's') },
  });
  await core2.start();
  assert.strictEqual(core2.contractHost.contracts.size, 0, 'a fresh host starts empty — the registry is in memory');
  const r = await replayContracts(core2);
  assert.ok(r.scanned >= 2, `expected the contract blocks to be found, scanned ${r.scanned}`);
  assert.strictEqual(r.failed, 0, 'every recorded deployment was readable');
  // The code alone is not the contract: without the footprint the host stages nothing and every field
  // reads back zero. The receipts are what carry it.
  assert.ok(r.receipts >= 2 && r.keys_restored >= 1, `expected the state footprint to be restored, got ${r.keys_restored} key(s) from ${r.receipts} receipt(s)`);
  // OUTCOME: the contract is holdable and CALLABLE, not merely counted.
  assert.ok(core2.contractHost.contracts.has(dep.contract_id), 'the counter came back');
  const sock2 = join(dir, 'n2.sock');
  const srv2 = await createControlServer({ core: core2, config: {}, sockPath: sock2, statusSnapshot: () => ({ pid: process.pid }) });
  const r3 = await call(sock2, { op: 'contract_call', contract_id: dep.contract_id, method: 'bump', params: [1] });
  assert.strictEqual(r3.ok, true, r3.error || 'call failed after replay');
  // 7 was committed before the restart; the replayed contract reads it back and returns 8.
  assert.strictEqual(r3.result, '8', `expected the PERSISTED 7 + 1, got ${r3.result}`);
  srv2.close();
  await core2.stop?.();
});

for (const d of [dir, offDir, badDir]) rmSync(d, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
