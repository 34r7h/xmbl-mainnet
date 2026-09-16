// A FORGERY MUST NEVER EVICT THE DATUM IT IMPERSONATES.
//
// FOUND by reproductions/three-nodes.mjs on its first run: three nodes given the identical 36-anchor set plus
// one forgery ended with 36 / 35 / 36 blocks. The ledger evicted an invalid typed datum by the xid it CLAIMED —
// and a datum fails validateXid precisely when its body does not hash to that xid, i.e. when the xid is
// somebody else's. So a forgery that copies an honest anchor's xid and changes one byte of the body made the
// honest anchor unavailable on every node that saw the forgery: refused forever if it had not arrived yet, and
// its stored rows DELETED by evict() if it had. Every xid is public, so this was a denial-of-service against
// any transaction on the chain, executable by anyone, with no key material.
//
// The fix: a datum whose claimed xid is not its content address is evicted under a digest of ITS OWN bytes.
// The forgery is still refused forever; the xid it impersonated is untouched.
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Ledger } from './ledger.js';
import { micromineTx } from './transaction-validator.js';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('ok   ' + n); } else { fail++; console.log('FAIL ' + n); } };
const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
const honest = (label) => micromineTx({ type: 'anchor', event: 'task.created', hash: sha(label), ts: 1789500000000 });

// ── 1. THE ATTACK, IN ITS WORST ORDER: the forgery arrives FIRST ──
{
  const dir = mkdtempSync(join(tmpdir(), 'xmbl-poison-a-'));
  const l = new Ledger({ dbPath: dir }); await l.initialize?.();
  const real = honest('victim-a');
  const forgery = { ...real, hash: sha('forged-body') };          // same xid + nonce, different body

  let threw = null;
  try { await l.addTransaction(forgery); } catch (e) { threw = e; }
  ok('the forgery is REFUSED', threw !== null && /does not content-address/.test(threw.message));
  ok('the refusal is tagged XID_MISMATCH (the claimed xid is not proven to be its own)', threw.code === 'XID_MISMATCH');
  ok('the honest xid was NOT evicted', !l._evicted.has(`xid:${real.xid}`));
  ok('the forgery WAS evicted, under a key derived from its own bytes', [...l._evicted].some((k) => k.startsWith('forged:')));

  const res = await l.addTransaction(real);                        // the victim arrives afterwards
  ok('THE HONEST ANCHOR IS STILL ADMITTED after its xid was impersonated', !!res && res.evicted !== true);
  ok('the honest anchor is in the ledger (1 block)', l._membershipPool.length === 1);

  let again = null;
  try { await l.addTransaction(forgery); } catch (e) { again = e; }
  ok('a resubmission of the SAME forgery is still refused', again !== null);
  ok('and the honest anchor survived that too', l._membershipPool.length === 1);
  await l.close?.(); rmSync(dir, { recursive: true, force: true });
}

// ── 2. THE OTHER ORDER: the honest anchor is already stored when the forgery arrives ──
{
  const dir = mkdtempSync(join(tmpdir(), 'xmbl-poison-b-'));
  const l = new Ledger({ dbPath: dir }); await l.initialize?.();
  const real = honest('victim-b');
  await l.addTransaction(real);
  const before = l._membershipPool.length;
  ok('the honest anchor is stored first (1 block)', before === 1);

  const forgery = { ...real, hash: sha('forged-body-2') };
  let threw = null;
  try { await l.addTransaction(forgery); } catch (e) { threw = e; }
  ok('the forgery is refused', threw !== null && threw.code === 'XID_MISMATCH');
  ok('THE STORED BLOCK WAS NOT DELETED — evict() never ran against the honest xid', l._membershipPool.length === before);
  ok('the honest xid is still absent from the eviction set', !l._evicted.has(`xid:${real.xid}`));
  await l.close?.(); rmSync(dir, { recursive: true, force: true });
}

// ── 3. THE FIX DID NOT WEAKEN EVICTION: a genuinely invalid datum is still refused for good ──
{
  const dir = mkdtempSync(join(tmpdir(), 'xmbl-poison-c-'));
  const l = new Ledger({ dbPath: dir }); await l.initialize?.();
  // A shape forgery: a label where a digest belongs. It carries no valid xid, so it is evicted by content key.
  const shapeForgery = { type: 'anchor', event: 'proof.mined', hash: 'proofofmined-1789450900844', ts: 1 };
  let t1 = null;
  try { await l.addTransaction(shapeForgery); } catch (e) { t1 = e; }
  ok('a shape forgery (a label where a digest belongs) is refused', t1 !== null);
  ok('and it is recorded as evicted, so it is never examined again', l._evicted.size >= 1);

  // Two DIFFERENT forgeries of the same xid get two different keys — neither can mask the other.
  const real = honest('victim-c');
  const f1 = { ...real, hash: sha('f1') }, f2 = { ...real, hash: sha('f2') };
  for (const f of [f1, f2]) { try { await l.addTransaction(f); } catch { /* expected */ } }
  const forgedKeys = [...l._evicted].filter((k) => k.startsWith('forged:'));
  ok('two distinct forgeries of one xid are evicted under two distinct keys', new Set(forgedKeys).size === 2);
  ok('the impersonated xid is still clean', !l._evicted.has(`xid:${real.xid}`));
  const r = await l.addTransaction(real);
  ok('and the honest anchor still gets in', !!r && r.evicted !== true);
  await l.close?.(); rmSync(dir, { recursive: true, force: true });
}

// ── 4. THE SAME ATTACK THROUGH THE DEDUP DOOR: a forgery that keeps the honest event:hash ──
// The content key is claimed BEFORE validation, so a forgery sharing an honest anchor's event and hash used to
// hold that key forever once it failed — and the honest anchor was then answered `duplicate: true` and
// silently dropped. Same denial-of-service, different door.
{
  const dir = mkdtempSync(join(tmpdir(), 'xmbl-poison-d-'));
  const l = new Ledger({ dbPath: dir }); await l.initialize?.();
  const real = honest('victim-d');
  // identical event + hash, broken identity (nonce moved, so the body no longer mines to the xid)
  const twin = { ...real, nonce: real.nonce + 1 };
  let threw = null;
  try { await l.addTransaction(twin); } catch (e) { threw = e; }
  ok('a forgery sharing the honest event:hash is refused', threw !== null && threw.code === 'XID_MISMATCH');
  ok('it does NOT keep the content key it claimed before validation', !l._anchorKeys.has(`${real.event}:${real.hash}`));
  const res = await l.addTransaction(real);
  ok('THE HONEST ANCHOR IS STILL ADMITTED, not answered "duplicate"', res && res.duplicate !== true);
  ok('and it is really stored (1 block)', l._membershipPool.length === 1);
  const dupe = await l.addTransaction(real);
  ok('a genuine duplicate of the honest anchor is still deduped', dupe && dupe.duplicate === true);
  ok('the ledger still holds exactly one block for it', l._membershipPool.length === 1);
  await l.close?.(); rmSync(dir, { recursive: true, force: true });
}

// ── 5. THE SAME TWO DOORS THROUGH THE SEAL PATH — addSealedBatch, not addTransaction ──
// addTransaction is the legacy incremental path; the path a FINALIZED transaction actually takes on a live
// node is consensus `tx:finalized` → lead-worker.handleFinalizedTx → addSealedBatch. That function claims the
// anchor content key before validation exactly as addTransaction did, and had no failure handling at all — so
// both doors the sections above closed were still standing behind it, on the only path that carries real
// node traffic. A fix that handles one entry point and not the other is not a fix.
{
  const dir = mkdtempSync(join(tmpdir(), 'xmbl-poison-e-'));
  const l = new Ledger({ dbPath: dir }); await l.initialize?.();
  const real = honest('victim-e');
  const twin = { ...real, nonce: real.nonce + 1 };               // same event:hash, broken identity
  let threw = null;
  try { await l.addSealedBatch([twin]); } catch (e) { threw = e; }
  ok('SEAL PATH: a forgery sharing the honest event:hash is refused', threw !== null && threw.code === 'XID_MISMATCH');
  ok('SEAL PATH: it does not keep the content key it claimed before validation', !l._anchorKeys.has(`${real.event}:${real.hash}`));
  ok('SEAL PATH: the honest xid was NOT evicted', !l._evicted.has(`xid:${real.xid}`));
  ok('SEAL PATH: the forgery WAS evicted under a key derived from its own bytes', [...l._evicted].some((k) => k.startsWith('forged:')));
  const res = await l.addSealedBatch([real]);
  ok('SEAL PATH: THE HONEST ANCHOR IS STILL ADMITTED after the forgery', !!res);
  ok('SEAL PATH: and it is really stored (1 block)', l._membershipPool.length === 1);
  await l.addSealedBatch([real]);
  ok('SEAL PATH: a genuine duplicate is still deduped (still 1 block)', l._membershipPool.length === 1);
  await l.close?.(); rmSync(dir, { recursive: true, force: true });
}

// ── 6. ONE BAD TRANSACTION MUST NOT DISCARD THE HONEST ONES BATCHED WITH IT ──
// addSealedBatch takes a LIST. A throw out of the middle of the loop drops every remaining entry on the floor,
// so one forgery placed ahead of honest traffic silently deletes it — a cheaper denial of service than either
// door above, needing no xid collision at all.
{
  const dir = mkdtempSync(join(tmpdir(), 'xmbl-poison-f-'));
  const l = new Ledger({ dbPath: dir }); await l.initialize?.();
  const a = honest('batch-a'), b = honest('batch-b'), c = honest('batch-c');
  const poison = { ...honest('batch-poison'), nonce: 7 };         // invalid: body no longer mines to its xid
  let threw = null;
  try { await l.addSealedBatch([a, poison, b, c]); } catch (e) { threw = e; }
  ok('a batch carrying one forgery still reports the refusal', threw !== null && threw.code === 'XID_MISMATCH');
  ok('THE THREE HONEST TRANSACTIONS BEHIND IT ARE ALL ADMITTED', l._membershipPool.length === 3);
  ok('the forgery itself is not in the ledger', l._membershipPool.length === 3 && !l._membershipPool.some((blk) => blk.tx.nonce === 7));
  await l.close?.(); rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
