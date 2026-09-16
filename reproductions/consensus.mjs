// REPRODUCTION — CONSENSUS VALIDATES IN THE OPERATOR'S ORDER, AND NAMES THE STAGE THAT REFUSED
// (packages/consensus × packages/cubic-ledger).
//
// CLAIM (operator, 2026-09-16, verbatim): "consensus should obviously first validate a tx can happen, then
// check the xid is correct, then verify the geometric placement". Three stages, in that order, and a refusal
// says which one it failed — `REJECT [can-happen]`, `REJECT [xid]`, `REJECT [placement]` — because a refusal
// that does not name its stage sends the caller to fix the wrong thing.
//
// WHAT EACH STAGE MEANS:
//   1. can-happen — a known type carrying its required fields, AUTHORIZED, with a value that can exist.
//      Authorization is read from the type table (tokens.json `authority`), never hardcoded: type 6 and the
//      type-7 anchor are CONTENT-ADDRESSED, so their authority is their xid and they need no signature; the
//      other five types must be signed by a sender. That distinction is not cosmetic — those anchors are
//      minted by a node-less custodial broker that no end user ever signs for, and before the table was read
//      every one of them was refused here as "unsigned".
//   2. xid — the micromined identity: the right type prefix, a re-derivable body, a verifiable nonce.
//   3. placement — a face's nine positions are the hash ranks of its blocks and a cube's face indices are the
//      ranks of its roots, re-derived and compared against what is claimed.
//
// WHAT THIS PROVES BY COUNT: each stage refuses what it owns, the FIRST failing stage is the one reported (a
// tx that is both unsigned and untyped is reported as can-happen, never xid), the real ingress admits and
// refuses accordingly, and placement catches a block moved to a position its hash does not rank at.
//
// Exits non-zero if any claim fails, so it is also a hard-gate test (reproductions.test.mjs).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateCanHappen, validateXidStage, validatePlacementStage, validateForConsensus, STAGES, ConsensusWorkflow } from '@xmbl/consensus';
import { micromineTx, authorityOf, contentAddressedTypes, Block } from '@xmbl/cubic-ledger';

const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
const selfDigest = createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex');
console.log('XMBL reproduction — consensus validates in order and names the stage that refused');
console.log(`source sha256: ${selfDigest}\n`);

let failures = 0;
const ok = (name, cond, detail = '') => { console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`); if (!cond) failures++; };

// ── the stages exist, in order ──
ok('the three stages are named, in the operator\'s order', JSON.stringify(STAGES) === JSON.stringify(['can-happen', 'xid', 'placement']), STAGES.join(' → '));

// ── STAGE 1: can it happen ──
const anchor = micromineTx({ type: 'anchor', event: 'task.created', hash: sha('a1'), ts: 1 });
const utxoUnsigned = micromineTx({ type: 'utxo', from: 'xmbA', to: 'xmbB', amount: '5' });
const utxoSigned = { ...utxoUnsigned, sig: 'SIGNATURE' };
ok('the type table says which types are content-addressed', JSON.stringify(contentAddressedTypes()) === JSON.stringify(['anchor', 'tx']), contentAddressedTypes().join(', '));
ok('an anchor is content-addressed — no signature required', authorityOf('anchor') === 'content-addressed' && validateCanHappen(anchor).ok === true);
ok('an unsigned utxo CANNOT happen — value moves on a signature', validateCanHappen(utxoUnsigned).ok === false && /unsigned/.test(validateCanHappen(utxoUnsigned).reason));
ok('the same utxo, signed, CAN happen', validateCanHappen(utxoSigned).ok === true);
const negative = { ...utxoSigned, amount: -5 };
ok('a value that cannot exist is refused at stage 1', validateCanHappen(negative).ok === false && /cannot happen/.test(validateCanHappen(negative).reason));
const labelAnchor = { ...anchor, hash: 'proofofmined-1789450900844' };
ok('an anchor whose hash is a label, not a digest, is refused at stage 1', validateCanHappen(labelAnchor).ok === false);

// ── STAGE 2: is the xid correct ──
const untyped = { type: 'anchor', event: 'task.created', hash: sha('a2'), ts: 2 };
ok('a typed anchor passes stage 2', validateXidStage(anchor).ok === true);
ok('an UNTYPED anchor fails stage 2 (no micromined xid)', validateXidStage(untyped).ok === false && /no micromined xid/.test(validateXidStage(untyped).reason));
const forged = { ...anchor, hash: sha('tampered') };
ok('a FORGED xid fails stage 2 — the body no longer content-addresses it', validateXidStage(forged).ok === false && /does not content-address/.test(validateXidStage(forged).reason));
const wrongPrefix = { ...anchor, xid: '02' + anchor.xid.slice(2) };
ok('an xid carrying the WRONG type prefix fails stage 2', validateXidStage(wrongPrefix).ok === false && /type prefix/.test(validateXidStage(wrongPrefix).reason));
const noPrior = (() => { const t = { ...anchor }; delete t.prior; return t; })();
ok('an anchor with no `prior` fails stage 2 — the pointer body cannot be re-mined', validateXidStage(noPrior).ok === false && /prior/.test(validateXidStage(noPrior).reason));

// ── THE ORDER ITSELF: the FIRST failing stage is the answer ──
const bothBroken = { type: 'utxo', from: 'xmbA', to: 'xmbB', amount: '5' };   // unsigned AND untyped
const first = validateForConsensus(bothBroken);
ok('a tx that fails BOTH stages is reported as can-happen, not xid', first.ok === false && first.stage === 'can-happen', `stage=${first.stage}`);
const onlyXid = validateForConsensus(untyped);
ok('a tx that passes stage 1 and fails stage 2 is reported as xid', onlyXid.ok === false && onlyXid.stage === 'xid', `stage=${onlyXid.stage}`);
ok('a good anchor passes both and is handed to placement', validateForConsensus(anchor).ok === true && validateForConsensus(anchor).next === 'placement');

// ── STAGE 3: is the geometric placement right ──
const blocks = Array.from({ length: 9 }, (_, i) => Block.fromTransaction(micromineTx({ type: 'anchor', event: 'face.member', hash: sha('f' + i), ts: 10 + i })));
const ranked = [...blocks].sort((a, b) => (a.hash < b.hash ? -1 : 1));
const honestFace = { blocks: ranked.map((b, i) => ({ hash: b.hash, position: i })) };
ok('a face whose nine positions ARE the hash ranks passes stage 3', validatePlacementStage(honestFace).ok === true);
const moved = { blocks: honestFace.blocks.map((b, i) => (i === 3 ? { ...b, position: 7 } : b)) };
ok('one block moved to a position its hash does not rank at is REFUSED at stage 3',
   validatePlacementStage(moved).ok === false && /ranks/.test(validatePlacementStage(moved).reason));
const short = { blocks: honestFace.blocks.slice(0, 8) };
ok('a face that is not nine blocks is refused at stage 3', validatePlacementStage(short).ok === false);

// ── THE REAL DOOR: the ingress guard applies stages 1→2 to live traffic ──
const w = new ConsensusWorkflow({});
w.getPublicKeyByAddress = () => null;                       // node-less custodial broker: nothing resolves
ok('the real ingress ADMITS the unsigned content-addressed anchor', w._admitToPool('broker', anchor) === true);
ok('the real ingress REFUSES the unsigned utxo', w._admitToPool('attacker', utxoUnsigned) === false);
ok('the real ingress REFUSES the untyped anchor', w._admitToPool('broker', untyped) === false);
ok('the real ingress REFUSES the forged xid', w._admitToPool('broker', forged) === false);
const rawTxId = await w.submitTransaction('broker', anchor);
ok('submitTransaction returns a real id for the admitted anchor (not the null that means rejected)', typeof rawTxId === 'string' && rawTxId.length > 0);
try { await w.mempool?.db?.close?.(); } catch { /* in-memory */ }

console.log(failures === 0
  ? '\nREPRODUCED — every stage refuses what it owns, the first failing stage is the one reported, and the live ingress agrees.'
  : `\nNOT REPRODUCED — ${failures} assertion(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
