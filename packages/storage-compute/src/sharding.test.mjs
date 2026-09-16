// THE ERASURE CODER WAS 28.3% COVERED, AND IT RETURNED CORRUPTED DATA WITHOUT SAYING SO.
//
// sharding.js splits a blob into k data shards plus m XOR parity shards so a lost shard can be rebuilt.
// Only the encode path had ever run. Recovery — the entire reason the parity exists — had not.
//
// FOUND HERE AND FIXED. XOR parity recovers at most ONE loss per parity group: parity[i] covers data
// shards i, i+m, i+2m, … so losing two members of one group is mathematically unrecoverable. decode()
// handled that by filling the missing chunk with zeros and RETURNING THE BUFFER AS IF IT HAD SUCCEEDED.
// Measured on k=4, m=2: dropping data shards 0 and 2 (both in parity group 0) returned bytes that
// differed from the original with no error, no flag, and no short read — and when only the parity shards
// survived, decode returned a buffer of essentially nothing and called it the file. A storage layer that
// hands back silently corrupted data is worse than one that fails, because the caller cannot tell.
// decode() now reports the shard indices it could not recover. Sections 4 and 5 fail on the parent commit.
//
// Every recovery claim below is checked by BYTE COMPARISON against the original, never by "it returned
// something".
import { StorageShard } from './sharding.js';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('ok   ' + n); } else { fail++; console.log('FAIL ' + n); } };
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re ? re.test(e.message) : true; } };

const DATA = Buffer.from('The quick brown fox jumps over the lazy dog 0123456789 abcdefghijklmnopqrstuv');
const drop = (all, ...idx) => all.filter((s) => !(!s.isParity && idx.includes(s.index)));

// ── 1. SPLITTING PRESERVES THE BYTES AND THE ORIGINAL LENGTH ──
{
  const { shards, parity } = StorageShard.encode(DATA, 4, 2);
  ok('k data shards are produced', shards.length === 4);
  ok('m parity shards are produced', parity.length === 2);
  ok('data shards are indexed 0..k-1', shards.map((s) => s.index).join() === '0,1,2,3');
  ok('PARITY SHARDS ARE INDEXED FROM k — decode recovers k from the lowest parity index',
     parity.map((s) => s.index).join() === '4,5');
  ok('parity shards are flagged as parity, data shards are not',
     parity.every((s) => s.isParity) && shards.every((s) => !s.isParity));
  ok('EVERY SHARD CARRIES THE ORIGINAL LENGTH — padding is otherwise indistinguishable from data',
     [...shards, ...parity].every((s) => s.originalLength === DATA.length));
  ok('every shard is the same size, so XOR is well defined',
     new Set([...shards, ...parity].map((s) => s.data.length)).size === 1);
  ok('the chunk size is ceil(len/k)', shards[0].data.length === Math.ceil(DATA.length / 4));
  ok('the last shard is zero-padded rather than short', shards[3].data.length === shards[0].data.length);

  ok('a full set decodes back to the exact original bytes',
     Buffer.compare(StorageShard.decode([...shards, ...parity]), DATA) === 0);
  ok('the decoded length is the ORIGINAL length, not the padded one',
     StorageShard.decode([...shards, ...parity]).length === DATA.length);
  ok('decoding from data shards alone works — parity is for loss, not for reading',
     Buffer.compare(StorageShard.decode([...shards]), DATA) === 0);

  ok('create() produces one indexed shard of the same split', (() => {
    const one = StorageShard.create(DATA, 2, 4);
    return one.index === 2 && one.originalLength === DATA.length
      && Buffer.compare(one.data, shards[2].data) === 0;
  })());
  ok('reconstruct() joins data shards back into the original',
     Buffer.compare(StorageShard.reconstruct(shards), DATA) === 0);
  ok('reconstruct ignores parity shards rather than splicing them into the payload',
     Buffer.compare(StorageShard.reconstruct([...shards, ...parity]), DATA) === 0);
  ok('reconstruct does not depend on the order it is handed the shards',
     Buffer.compare(StorageShard.reconstruct([...shards].reverse()), DATA) === 0);
}

// ── 2. SINGLE-SHARD LOSS IS RECOVERED EXACTLY, FOR EVERY SHARD AND SEVERAL SHAPES ──
// This is the property the module exists for, and it had never been executed.
{
  for (const [k, m] of [[4, 2], [4, 1], [6, 2], [3, 1], [8, 2], [5, 1], [2, 1]]) {
    const { shards, parity } = StorageShard.encode(DATA, k, m);
    const all = [...shards, ...parity];
    let recovered = 0;
    for (let i = 0; i < k; i++) {
      try { if (Buffer.compare(StorageShard.decode(drop(all, i)), DATA) === 0) recovered++; } catch { /* counted as a miss */ }
    }
    ok(`k=${k} m=${m}: LOSING ANY ONE DATA SHARD STILL RECOVERS THE EXACT ORIGINAL (${recovered}/${k})`,
       recovered === k);
  }
  const { shards, parity } = StorageShard.encode(DATA, 4, 2);
  const all = [...shards, ...parity];
  ok('losing a PARITY shard costs nothing — the data shards are all present',
     Buffer.compare(StorageShard.decode(all.filter((s) => s.index !== 5)), DATA) === 0);
  ok('losing BOTH parity shards costs nothing while every data shard survives',
     Buffer.compare(StorageShard.decode([...shards]), DATA) === 0);
  ok('shards handed back out of order still decode', (() => {
    const shuffled = drop(all, 1).slice().reverse();
    return Buffer.compare(StorageShard.decode(shuffled), DATA) === 0;
  })());
}

// ── 3. TWO LOSSES IN DIFFERENT PARITY GROUPS ARE STILL RECOVERABLE ──
// With m=2, group 0 is {0,2} and group 1 is {1,3}: one loss from each is fine.
{
  const { shards, parity } = StorageShard.encode(DATA, 4, 2);
  const all = [...shards, ...parity];
  for (const [a, b] of [[0, 1], [0, 3], [2, 1], [2, 3]]) {
    ok(`losing ${a} and ${b} — one per parity group — recovers exactly`,
       Buffer.compare(StorageShard.decode(drop(all, a, b)), DATA) === 0);
  }
}

// ── 4. TWO LOSSES IN THE SAME PARITY GROUP ARE REFUSED, NOT FAKED ──
// THE BUG. These returned wrong bytes with no signal at all.
{
  const { shards, parity } = StorageShard.encode(DATA, 4, 2);
  const all = [...shards, ...parity];
  for (const [a, b] of [[0, 2], [1, 3]]) {
    ok(`LOSING ${a} AND ${b} — BOTH IN ONE PARITY GROUP — IS REPORTED, not silently returned as data`,
       throws(() => StorageShard.decode(drop(all, a, b)), /Cannot reconstruct data/));
  }
  ok('the refusal names exactly which shards are missing',
     throws(() => StorageShard.decode(drop(all, 0, 2)), /shard\(s\) 0, 2 are missing/));
  ok('the refusal explains the limit rather than just failing',
     throws(() => StorageShard.decode(drop(all, 0, 2)), /at most one loss per parity group/));
  ok('WITH ONLY THE PARITY SHARDS LEFT, DECODE REFUSES — it used to return a buffer of nothing',
     throws(() => StorageShard.decode([...parity]), /Cannot reconstruct data/));
  ok('...and names every missing shard, not just the first',
     throws(() => StorageShard.decode([...parity]), /shard\(s\) 0, 1, 2, 3 are missing/));
  ok('three losses across two groups are refused too',
     throws(() => StorageShard.decode(drop(all, 0, 1, 2)), /Cannot reconstruct data/));
}

// ── 5. NO SURVIVING PATH MAY EVER RETURN THE WRONG BYTES SILENTLY ──
// The exhaustive statement of section 4: over every subset of a k=4/m=2 encoding, a decode that RETURNS
// must return the original. Anything else must throw.
{
  const { shards, parity } = StorageShard.encode(DATA, 4, 2);
  const all = [...shards, ...parity];
  let returnedWrong = 0, returnedRight = 0, refused = 0;
  for (let mask = 0; mask < (1 << all.length); mask++) {
    const subset = all.filter((_, i) => mask & (1 << i));
    if (subset.length === 0) continue;
    try {
      const out = StorageShard.decode(subset.map((s) => s));
      if (Buffer.compare(out, DATA) === 0) returnedRight++; else returnedWrong++;
    } catch { refused++; }
  }
  ok(`OVER ALL ${(1 << all.length) - 1} SUBSETS, NO DECODE RETURNS THE WRONG BYTES (wrong=${returnedWrong})`,
     returnedWrong === 0);
  ok('...and the recoverable subsets really do return the original', returnedRight > 0);
  ok('...and the unrecoverable ones refuse', refused > 0);
}

// ── 6. EDGE-SIZED PAYLOADS ──
{
  const roundTrips = (buf, k, m) => {
    const { shards, parity } = StorageShard.encode(buf, k, m);
    return Buffer.compare(StorageShard.decode([...shards, ...parity]), buf) === 0;
  };
  ok('a one-byte payload round-trips', roundTrips(Buffer.from([7]), 4, 2));
  ok('a payload that divides evenly into k round-trips', roundTrips(Buffer.alloc(64, 0xab), 4, 2));
  ok('a payload one byte over a multiple round-trips', roundTrips(Buffer.alloc(65, 0xcd), 4, 2));
  ok('a payload SHORTER than k round-trips', roundTrips(Buffer.from([1, 2]), 8, 2));
  ok('a 64 KiB payload round-trips', roundTrips(Buffer.alloc(65536, 0x5a), 6, 2));
  ok('binary data with every byte value round-trips',
     roundTrips(Buffer.from(Array.from({ length: 256 }, (_, i) => i)), 4, 2));
  ok('a payload of all zeros round-trips (zeros are data, not absence)',
     roundTrips(Buffer.alloc(100, 0), 4, 2));
  ok('a one-byte payload survives losing a shard', (() => {
    const { shards, parity } = StorageShard.encode(Buffer.from([7]), 4, 2);
    // Only shard 0 holds the byte; the rest are zero-length, so the loss to prove is shard 0's.
    try { return Buffer.compare(StorageShard.decode(drop([...shards, ...parity], 0)), Buffer.from([7])) === 0; }
    catch { return false; }
  })());
}

// ── 7. REFUSALS RATHER THAN GUESSES ──
{
  ok('decoding nothing is refused', throws(() => StorageShard.decode([]), /Cannot determine original data length/));
  ok('reconstructing with no data shards is refused', throws(() => StorageShard.reconstruct([]), /No data shards provided/));
  ok('reconstructing from parity alone is refused — parity is not data', (() => {
    const { parity } = StorageShard.encode(DATA, 4, 2);
    return throws(() => StorageShard.reconstruct(parity), /No data shards provided/);
  })());
  ok('A SHARD WITH NO ORIGINAL LENGTH IS REFUSED — the padding could not be trimmed',
     throws(() => StorageShard.decode([new StorageShard(0, Buffer.alloc(8), false, null)]),
            /Cannot determine original data length/));
  ok('a shard with an empty data buffer is refused', (() => {
    const s = new StorageShard(0, Buffer.alloc(0), false, 10);
    return throws(() => StorageShard.decode([s]), /Invalid shard data/);
  })());
}

// ── 8. THE PARITY DEGREE IS A PROPERTY OF THE ENCODING, NOT OF THE SURVIVORS ──
// The second half of the bug, and the subtler one. parity[i] is the XOR of data shards {i, i+m, i+2m, …},
// so decode needs m — and m was inferred from the number of parity shards PRESENT. Lose one parity shard
// and the inferred m shrinks, the recovery group becomes the wrong set, and decode XORs the wrong shards
// together. MEASURED on k=4, m=2: given data shards 0, 1, 2 and parity shard 4 only, the inferred m was 1,
// so the group became {0,1,2,3} instead of {0,2} and decode returned wrong bytes with no error. m is now
// carried on every shard, exactly as originalLength is.
{
  const { shards, parity } = StorageShard.encode(DATA, 4, 2);
  const all = [...shards, ...parity];
  ok('EVERY SHARD CARRIES THE ENCODING\'S PARITY DEGREE', all.every((s) => s.parityCount === 2));
  ok('a different encoding stamps its own degree',
     StorageShard.encode(DATA, 4, 1).parity.every((s) => s.parityCount === 1));

  // The four subsets that used to return wrong bytes: three data shards plus the LOW parity shard only.
  for (const missing of [3, 2, 1, 0]) {
    const subset = drop(all, missing).filter((s) => s.index !== 5);
    const kept = subset.map((s) => (s.isParity ? 'P' : 'D') + s.index).join(',');
    let out = null;
    try { out = StorageShard.decode(subset.map((s) => s)); } catch { out = null; }
    ok(`${kept}: recovers the exact original, or refuses — never the wrong bytes`,
       out === null || Buffer.compare(out, DATA) === 0);
  }
  ok('losing data shard 2 with only parity 4 left STILL RECOVERS — 2 is in parity group 0',
     Buffer.compare(StorageShard.decode(drop(all, 2).filter((s) => s.index !== 5)), DATA) === 0);
  ok('LOSING DATA SHARD 1 WITH ONLY PARITY 4 LEFT IS REFUSED — 1 is in group 1, whose parity is gone',
     throws(() => StorageShard.decode(drop(all, 1).filter((s) => s.index !== 5)), /Cannot reconstruct data/));

  // A legacy shard set, minted before the degree was carried, must refuse parity recovery rather than guess.
  const legacy = all.map((s) => new StorageShard(s.index, s.data, s.isParity, s.originalLength));
  ok('legacy shards (no parity degree) still decode when every data shard is present',
     Buffer.compare(StorageShard.decode(legacy.filter((s) => !s.isParity)), DATA) === 0);
  ok('LEGACY SHARDS REFUSE PARITY RECOVERY rather than computing it from a guessed degree',
     throws(() => StorageShard.decode(legacy.filter((s) => s.index !== 0)), /Cannot reconstruct data/));
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
