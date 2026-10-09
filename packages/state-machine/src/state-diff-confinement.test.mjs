// A STATE_DIFF WRITES XMBL DATUMS, EACH UNDER ITS MICROMINED KEY. The state machine applied a state_diff's args AS
// the changes, keys and all, and nothing checked which. MEASURED 2026-10-09 against the published 0.1.20 bytes: a
// state_diff signed by a fresh identity with args {'utxo:forged0000': {to: <itself>, amount: '1000000000'}} passed
// validateForConsensus, went through Ledger.addTransaction into the tree, and a TRANSFER contract spent it.
// Now a write is `${xid}_${nonce}` → {oid, nonce, data}: the key and record the app's set() makes (xmbl
// src/stores/api.js), the type in the xid's prefix, the lowest nonce. The golden vectors below are produced by a
// line-for-line port of the app's hash()/micro() onto WebCrypto — it shares no code with cubic-ledger's micromine.js.
import assert from 'assert';
import { StateMachine } from './state-machine.js';
import { validateShape, micromineTx, stateDiffWrites, datumWrite, micromine } from '@xmbl/cubic-ledger';
import { rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let pass = 0, fail = 0;
const check = async (n, f) => { try { await f(); console.log(`  ok   ${n}`); pass++; } catch (e) { console.log(`  FAIL ${n}\n       ${e.message}`); fail++; } };
const dir = join(tmpdir(), 'xvsm-state-diff-confinement-test');
const fresh = async () => { rmSync(dir, { recursive: true, force: true });
  const sm = new StateMachine({ dbPath: dir }); await sm.ready(); return sm; };
const rootOf = (sm) => String(sm.stateTree.getRoot());
const put = (args, extra = {}) => micromineTx({ type: 'state_diff', function: 'put', args, from: 'xmbNode', timestamp: 1, ...extra });
const shapeError = (tx) => { try { validateShape(tx); return null; } catch (e) { return e.message; } };
const only = (w) => Object.entries(w)[0];

// ── the app's hash() and set(), ported line for line (xmbl src/stores/api.js) ──
const sha = async (s) => Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))))
  .map((b) => b.toString(16).padStart(2, '0')).join('');
async function appHash({ content, type }) {
  let nonce = 0;
  const micro = async (type, realhash) => {
    const temphash = await sha(realhash + String(nonce));
    return temphash.indexOf(type) == 0 ? [temphash, nonce] : (nonce++, micro(type, realhash));
  };
  const contentstring = typeof content == 'string' ? content : typeof content == 'object' ? JSON.stringify(content) : String(content);
  const hashHex = await sha(contentstring);
  const typecode = '0' + (type || '0');
  return !type ? hashHex : [hashHex, ...(await micro(typecode, hashHex))];
}
async function appSet(data, type) {
  const [oid, xid, nonce] = await appHash({ content: { data }, type });
  return { [`${xid}_${nonce}`]: { oid, nonce, data } };
}

const post = { text: 'hello xmbl', at: '2026-10-09T00:00:00.000Z' };
const comp = { type: 'div', props: { class: 'card' } };
const compReordered = { props: { class: 'card' }, type: 'div' };
const GOLDEN = {
  post: ['00c015a98989cb8c89535f1ee853bf66ca85c220e98c466d8436d3365f6727ce_73', '36a64d0e45bf7f3c697db1f5dcef0eb348861a8cdd17043828dac22b32215b7d', 73],
  comp: ['02bb5c1936099a6cfbe6c9fe4e50ba7150f6bf3bb017392a4e54fe60afc39f90_77', '09e891361c274815a15390eb4289ac0d73cddf497beefd42a83cfd6bc496a207', 77],
  compReordered: ['0215c71bce02eb1afcbf7c40e52bbb7d2a3458286bdb41f5dd23d799d5ce191a_51', '3c705b8cf6d59a7ba842967d9a36e4e78b6a5f8fad923cf0b7e2070f0345645b', 51],
  link: ['07746193f2897e415d5a31a4b3431981922b4846581a8e7f08416ddd1121590d_128', '140be9b87b19ea1d2c6f520578443f70a5e6950c6e6539bbce2c139b417d2811', 128],
};
const link = { from: [GOLDEN.post[0]], to: [GOLDEN.comp[0]], how: 'link' };
const postW = datumWrite(post, 0);
const [postKey, postRec] = only(postW);

console.log('\n1. golden vectors — the key and record are the ones the app\'s set() makes');
for (const [name, data, type] of [['post', post, 0], ['comp', comp, 2], ['compReordered', compReordered, 2], ['link', link, 7]]) {
  await check(`${name} (type ${type}): datumWrite = the app's set() = the pinned vector`, async () => {
    const [k, v] = only(datumWrite(data, type));
    assert.deepStrictEqual(datumWrite(data, type), await appSet(data, String(type)));
    assert.deepStrictEqual([k, v.oid, v.nonce], GOLDEN[name]);
    assert.ok(k.startsWith('0' + type));
  });
}

console.log('\n2. the door (validateShape) — what a state_diff may write');
await check('a type-0 datum under its micromined key is admitted', async () => {
  assert.strictEqual(shapeError(put(postW)), null);
});
for (const k of ['utxo:forged0000', 'identity:victim', 'spend:abc', `tx:${GOLDEN.post[0]}`, 'token:t1', 'contract:c1',
  `anchor:task.created:${'a'.repeat(64)}`, 'xcl/c1/slot/0', 'k:1', `app:datum:${postRec.oid}`, `app:datum:${postKey.split('_')[0]}`]) {
  await check(`a state_diff writing ${k.slice(0, 48)} is refused`, async () => {
    assert.match(shapeError(put({ [k]: postRec })) || '', /writes only xmbl datums under their micromined key/);
  });
}
await check('the 0.1.20 forgery {utxo:forged0000: {to, amount}} is refused', async () => {
  assert.match(shapeError(put({ 'utxo:forged0000': { from: 'nobody', to: 'xmbAttacker', amount: '1000000000' } })) || '', /micromined key/);
});
await check('a higher nonce that also carries the type prefix is refused — a datum has one key, its lowest nonce', async () => {
  let n = postRec.nonce + 1, xid;
  for (;; n++) { xid = await sha(postRec.oid + String(n)); if (xid.startsWith('00')) break; }
  assert.match(shapeError(put({ [`${xid}_${n}`]: { ...postRec, nonce: n } })) || '', /lowest nonce/);
});
await check('a datum under another datum\'s key is refused', async () => {
  assert.match(shapeError(put({ [postKey]: { ...postRec, data: { ...post, text: 'swapped' } } })) || '', /mines to/);
});
await check('the same data claimed as another type is refused (its type-0 key is not a type-5 key)', async () => {
  const k5 = '05' + postKey.slice(2);
  assert.match(shapeError(put({ [k5]: postRec })) || '', /event \(type 5\)|mines to/);
});
await check('the record is {oid, nonce, data} and nothing else: an extra author field is refused', async () => {
  assert.match(shapeError(put({ [postKey]: { ...postRec, author: 'thief' } })) || '', /\{oid, nonce, data\} and nothing else/);
  assert.match(shapeError(put({ [postKey]: post })) || '', /\{oid, nonce, data\} and nothing else/);
});
await check('a wrong oid, or the nonce as a string, is refused', async () => {
  assert.match(shapeError(put({ [postKey]: { ...postRec, oid: 'f'.repeat(64) } })) || '', /oid and nonce/);
  assert.match(shapeError(put({ [postKey]: { ...postRec, nonce: String(postRec.nonce) } })) || '', /oid and nonce/);
});
await check('a datum carries its data: null and empty are refused', async () => {
  assert.match(shapeError(put({ [postKey]: { ...postRec, data: null } })) || '', /carries its data/);
  assert.match(shapeError(put({ [postKey]: { ...postRec, data: '' } })) || '', /carries its data/);
});
await check('a component (type 2) in schema order and in another order are each admitted, at two keys', async () => {
  assert.strictEqual(shapeError(put(datumWrite(comp, 2))), null);
  assert.strictEqual(shapeError(put(datumWrite(compReordered, 2))), null);
  assert.notStrictEqual(only(datumWrite(comp, 2))[0], only(datumWrite(compReordered, 2))[0]);
});
await check('a component missing a field, with an extra field, or with props as an array is refused', async () => {
  assert.match(shapeError(put(datumWrite({ type: 'div' }, 2))) || '', /carries exactly props,type/);
  assert.match(shapeError(put(datumWrite({ ...comp, owner: 'x' }, 2))) || '', /carries exactly props,type/);
  assert.match(shapeError(put(datumWrite({ type: 'div', props: [] }, 2))) || '', /has props as object, not array/);
});
await check('a pointer (type 7) is admitted unless it says how spend or anchor', async () => {
  assert.strictEqual(shapeError(put(datumWrite(link, 7))), null);
  assert.match(shapeError(put(datumWrite({ ...link, how: 'spend' }, 7))) || '', /minted by the chain/);
  assert.match(shapeError(put(datumWrite({ ...link, how: 'anchor' }, 7))) || '', /minted by the chain/);
});
await check('a value unit (type 6) is refused — it enters as chain type tx', async () => {
  const unit = { chain: 'xmbl', from: ['xmbA'], to: ['xmbB'], asset: 'xmbl', amount: '1', seq: 1, prev: '', unspent: '' };
  assert.match(shapeError(put(datumWrite(unit, 6))) || '', /enters as chain type tx/);
});
await check('one bad write refuses the whole state_diff', async () => {
  assert.match(shapeError(put({ ...postW, 'identity:victim': { publicKey: 'attacker' } })) || '', /micromined key/);
});
await check('args that are empty or an array are refused', async () => {
  assert.match(shapeError(put({})) || '', /writes nothing/);
  assert.match(shapeError(put([postW])) || '', /object of writes/);
});
await check('a contract_call receipt keeps {params, writes} and nothing else', async () => {
  assert.strictEqual(shapeError(put({ params: [1], writes: [] }, { contractAddress: 'c1', function: 'inc' })), null);
  assert.match(shapeError(put({ params: [1], 'utxo:forged0000': 1 }, { contractAddress: 'c1', function: 'inc' })) || '', /contract receipt/);
});
await check('a settlement_seal receipt keeps {chain, address, authorization} and nothing else', async () => {
  assert.strictEqual(shapeError(put({ chain: 'base', address: '0xa', authorization: 'x' }, { contractAddress: 'c1', function: 'settlement_seal' })), null);
  assert.match(shapeError(put({ chain: 'base', writes: [] }, { contractAddress: 'c1', function: 'settlement_seal' })) || '', /contract receipt/);
});

console.log('\n3. the tree — a state_diff that reached it some other way (sync, rebuild) writes no more than the door admits');
await check('the 0.1.20 forgery is not written; the datum is, under its key, as {oid, nonce, data}', async () => {
  const sm = await fresh();
  await sm._handleLedgerBlock({ id: 'f', tx: put({ 'utxo:forged0000': { from: 'nobody', to: 'xmbAttacker', amount: '1000000000' } }) });
  await sm._handleLedgerBlock({ id: 'v', tx: put({ 'identity:victim': { publicKey: 'attacker' } }) });
  await sm._handleLedgerBlock({ id: 'd', tx: put(postW) });
  assert.strictEqual(sm.stateTree.get('utxo:forged0000'), undefined);
  assert.strictEqual(sm.stateTree.get('identity:victim'), undefined);
  assert.deepStrictEqual(sm.stateTree.get(postKey), { oid: GOLDEN.post[1], nonce: GOLDEN.post[2], data: post });
  await sm.db.close();
});
await check('the same datum written again by another tx leaves the root and the value unchanged', async () => {
  const sm = await fresh();
  await sm._handleLedgerBlock({ id: 'd1', tx: put(postW, { timestamp: 1 }) });
  const root = rootOf(sm), value = JSON.stringify(sm.stateTree.get(postKey));
  await sm._handleLedgerBlock({ id: 'd2', tx: put(postW, { timestamp: 2 }) });
  assert.strictEqual(rootOf(sm), root);
  assert.strictEqual(JSON.stringify(sm.stateTree.get(postKey)), value);
  await sm.db.close();
});
await check('stateDiffWrites hands the tree a copy of the record, not the sender\'s object', async () => {
  const w = stateDiffWrites({ type: 'state_diff', args: postW });
  assert.ok(w.ok);
  assert.notStrictEqual(w.changes[postKey], postW[postKey]);
  assert.deepStrictEqual(w.changes[postKey], postW[postKey]);
});
await check('micromine is the chain\'s own (type prefix + lowest nonce), the one stateDiffWrites checks against', async () => {
  const m = micromine(post, 0);
  assert.strictEqual(`${m.xid}_${m.nonce}`, postKey);
});

rmSync(dir, { recursive: true, force: true });
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
