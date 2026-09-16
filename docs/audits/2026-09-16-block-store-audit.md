# Audit: what the 17,904 blocks on this node actually are

2026-09-16 · agent `xmbl` · node `bb59ca32b06e` / `xmb0844bbed56ddcf2d4e21443428afb542c442405e`

Counted off a cold copy of `~/.handoff/xmbl/node-data/ledger` against the broker's canonical feed
(`GET /api/v1/xmbl/anchors/canonical`, 3,976 anchors, 0 duplicates).

> This file lives in the repo because the previous copy, under `~/handoff-evidence/xmbl/`, was removed
> along with that whole directory partway through the work. The repo is version-controlled and pushed;
> a home directory on one box is not.

## Every row, by category

```
  9,467   NON-canonical anchor, id hashed over NODE-LOCAL fields, UNTYPED
  3,965   canonical anchor, bare content shape,                   UNTYPED
  2,879   canonical anchor, id hashed over NODE-LOCAL fields,     UNTYPED
  1,305   NON-canonical anchor, id hashed over NODE-LOCAL fields, mined xid
    276   type-6 value tx (not an anchor)
     10   canonical anchor, id hashed over NODE-LOCAL fields,     mined xid
      2   NON-canonical anchor, bare content shape,               UNTYPED
 ------
 17,904
```

```
anchor rows                 17,628      value-tx rows             276
rows in the canonical set    6,854      rows NOT in it         10,774   (canonical anchors: 3,976)
distinct (event:hash)       13,779      duplicated keys         1,273   redundant rows  3,849
anchors with a mined xid     1,315      untyped anchors        16,313   (all 276 value txs are typed)
```

By event — canonical: `value.transfer 2441, settlement.executed 2018, task.created 1516,
task.verified 801, app.published 44, soc.posted 34`. Non-canonical: `value.transfer 9147,
task.created 755, soc.posted 457, task.verified 154, app.published 108, mod.used 80,
settlement.executed 62, soc.resoc 10, proof.mined 1`.

**`blocks_persisted 17,904` was reported as a health number.** 10,774 of those rows are not in the
canonical set and 3,849 are redundant. That was wrong.

## The defects

### 1. The block id was not content-addressed — FIXED (0.1.9)

`block.js` derived `id` from `sha256(JSON.stringify(tx))` over the **whole** tx, including fields that
are envelope, not content: `from`, `sig`, `validationTimestamp`, `id`, `agent`, `agent_xmbl_address` —
and `JSON.stringify` is key-order sensitive on top of that. Seven distinct key-shapes existed on disk:

```
 12,231  type,event,hash,ts,from,sig,validationTimestamp,id
  3,967  type,event,hash,ts                                   <- rebuilt from canonical
  1,306  type,event,hash,ts,xid,nonce,from,sig,validationTimestamp,id
     74  type,event,hash,agent,from,sig,validationTimestamp,id
     41  type,event,hash,ts,agent_xmbl_address,from,sig,validationTimestamp,id
      6  + agent          3  + agent_xmbl_address
```

The consensus ingress guard *requires* `from` and `sig` on an anchor
(`packages/consensus/src/ingress-guard.test.mjs:43` rejects an unsigned one) and every node signs with
its own key — so the two rules together guaranteed a different id per node for identical content.

`consensusBody(tx)` now addresses `{type, event, hash, ts}` in fixed key order (ts normalised through
`anchorTimestampNanos`, so an ISO string and the same instant as a number agree) for anchors, and the
mined `xid` for type-6. `hash` is deliberately unchanged: peers verify an adopted cube with
`txHash(b.tx) === b.hash` (`cube-sync.js` `verifyCube`), so it is a wire contract; `id` is never on the
wire.

**This does not make the cube ledger converge cross-node.** Face and cube placement are driven by
`hash`, which is still envelope-dependent. Converging that requires `hash` to be content-only, which
IS a wire-format change and a coordinated fleet re-anchor — see "Still open" below.

### 2. Every rebuilt block's timestamp was 0 — FIXED (0.1.7)

`ledger.js` did `BigInt(Math.max(0, Math.floor(Number(a.ts) || 0)))`. The broker sends `ts` as an ISO
string; `Number()` of that is `NaN` and `NaN || 0` is `0`. All 17,628 stored anchor `ts` values are
strings, none numeric — so every rebuilt block was pinned to the epoch and rebuild output read
`validator avg timestamp: 0`. `anchorTimestampNanos()` parses ISO-8601 and numeric strings and scales
epoch-ms to the nanoseconds the rest of the ledger measures in (the old line also stored raw ms for the
numeric case it was written for).

### 3. The xid carry-through can never fire — NOT MINE

`ledger.js` copies `xid`/`nonce` through a rebuild verbatim, because a node cannot re-derive a chained
xid. The canonical feed carries **zero** `xid` (0 of 3,976), so every anchor rebuilt from canonical
comes back untyped: 16,313 of 17,628 anchors here have no mined identity. The receiving code is
correct and its input is empty. handoff-claude owns the feed; asked, twice.

### 4. The rescue pass re-stamped preserved blocks with the local clock — FIXED (0.1.8)

The step-0 pass that carries non-anchor blocks across a rebuild called `Block.deserialize` on rows with
no `timestamp` field, and `Block`'s constructor defaults an absent one to `Date.now()`. So a rebuild
re-timed all 276 value txs to the instant that node rebuilt — the chain was a function of *when* it was
rebuilt. This was in code added earlier the same day.

### 5. No face has ever been persisted, by anyone — RECORDED, NOT CHANGED

`face:` rows: **0**, while 650 cube rows are on disk and a rebuild seals 472 faces. Nothing in the
package ever writes a `face:` key; `rebuildFromAnchors` clears a prefix no code populates. Faces live
in memory and are re-sealed from the block set on every boot.

### 6. One payment was on the ledger twice

Two rows carried the same mined `xid` `065c7cb7f4a00bd0…` for one 0.3 USDC transfer
(`platform -> d6-broke-agent`, seq 3), identical in every consensus field and differing only in
`validationTimestamp` and the submitter's `id`. Addressing type-6 by `xid` collapses them.

## Eviction, not rebuild

`evict(key, reason)` records a content key in its own durable `evicted:` keyspace, deletes the rows
carrying it, and drops it from the pool and the anchor-dedup set. Both ingress paths (`addTransaction`,
`addSealedBatch`) refuse an evicted key before validating or touching disk, and the set is loaded at
boot — so an invalid tx is refused across restarts, and `rebuildFromAnchors` (which clears
`block:`/`cube:`/`face:`/`pool:`) deliberately does not touch it. An invalid tx is now evicted at the
door and recorded, rather than re-validated and re-logged on every resubmission.

`compactToContentIds()` is a targeted delete, not a rebuild: it keeps one row per content key —
preferring the row already in bare consensus shape, ties broken by id so every node picks the same one
— writes it under its content id and deletes the rest. **Rows outside the canonical set are not
touched**; they may be real local events the broker has not canonicalised, and nothing here can tell
the difference.

Measured on the 17,904-row snapshot taken before any of this ran:

```
                                    before      after
block rows                          17,904      14,054
duplicated (event:hash) keys         1,273           0
redundant rows                       3,849           0
rows whose id is not its content    17,904           0
   address
value-tx rows                          276         275   (defect 6 — one payment, two rows)
non-canonical anchors                10,774       9,804   (untouched; the fall is deduplication)
cube rows                              650         650
peers' wire contract
   txHash(b.tx) === b.hash               —   14,054/14,054 hold, 0 broken
scanned - kept == removed                —        true (17,904 - 14,054 == 3,850)
```

Timestamps, measured by replaying the live canonical set over a copy of the same ledger:

```
rebuilt anchors at timestamp 0n     3,967/3,967      0/3,976
rebuilt anchors with a real time          0          3,976
span of rebuilt anchor times        n/a (epoch)      2026-07-08T22:54:11.727Z -> 2026-09-16T03:10:32.424Z
preserved value-tx timestamps       rebuild wall     own validation times, 2026-09-15T07:14:50.986Z
                                    clock, 58ms       -> 11:22:13.962Z, 276 distinct
                                    window, 56
                                    distinct
```

## Still open

- **Cross-node cube convergence.** Placement keys off `hash`, which covers the envelope. Making it
  content-only breaks `verifyCube` against every peer still running the old derivation, so it needs a
  coordinated fleet re-anchor. Not a change to make from one node.
- **`xid` in the canonical feed** (defect 3) — handoff-claude's.
- One row in the first census showed a `timestamp` of `[object Object]`; still unexplained.
- A canonical rebuild ran on this node at boot from the coordinator's own path (`node.log`:
  `wiped 17910 block row(s), rebuilt 3977`), not from this session. The live store is now ~4,253 rows.
