# @xmbl/zero-knowledge

**XZK** — a hash-based (post-quantum) zero-knowledge state-commitment layer: FRI low-degree proofs,
an AIR over the cube geometry, and the cube-curve blinding that makes a proof hide its trace.

> ⚠ **EXPERIMENTAL AND UNAUDITED.** This composes with MAYO (which still signs identities and
> transactions); it is not the xid curve source. Do not wire it to a production path before a
> MAYO/UOV-adjacent ZK cryptographer signs off the parameters. See
> [MAINNET-GATES.md](../../MAINNET-GATES.md).

```sh
npm install @xmbl/zero-knowledge
```

## What it owns

| Export | What it is |
|---|---|
| `setup`, `blindedCurve`, `prove`, `verify` (`src/xzk.js`) | The cube-curve state-commitment proof system. |
| `src/air.js` | The AIR: trace commitment, the composition polynomial, and the FRI proof over it. |
| `FIELD_P`, `fmod`, `fadd`, `fsub`, `fmul`, `finv`, `fpow`, `EXT_BITS`, `GRIND_BITS` (`src/fri.js`) | The field and the FRI parameters. |
| `merkleSalted`, `mverifySalted`, `randomSalts` | **Salted Merkle leaves.** A base-field value is ~31 bits, and every opened leaf exposes its sibling's hash — a 2^31 brute force away from that sibling's value. Salting makes it 2^159. |

## The zero-knowledge argument, by count

The standing invariant is a **count**, not a specific attack: the points an adversary can hold must
stay below `T + blindDeg + 1`. Two things keep it there.

1. **The mask.** FRI runs on `F = C + γ·R` with `R` uniform of degree `< K` committed *before* `γ` is
   drawn, so every value FRI reveals is uniform and tells nothing about the trace. `setup()` counts
   what FRI reveals — `nq·(log2 K + 1) + 1 + nc` — and grows `K` until the mask outnumbers it.
2. **The salts.** Without them the sibling hashes hand over `2·nc` extra column evaluations for free,
   which by itself crossed the threshold and let the secret be interpolated straight back out.

Un-salt a leaf and the count doubles; that is the thing to watch in review.

## Tests

```sh
node ../../scripts/run-node-tests.mjs .
```
