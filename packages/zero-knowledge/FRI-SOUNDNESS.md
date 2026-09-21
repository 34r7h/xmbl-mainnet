# FRI parameter & soundness write-up (audit prep — T2.5)

**Status: PRE-AUDIT REVIEWER PACKAGE for an EXPERIMENTAL, UNAUDITED primitive.**
`@xmbl/zero-knowledge` (`xzk`) is a hash-based (post-quantum) low-degree-test /
state-commitment layer built on FRI. This document states its parameters and, in
concrete numbers, its **soundness**.

**At the shipped parameters the construction targets ~100 bits in the provable
(unique-decoding) regime and ~372 bits under the list-decoding conjecture, with a
~124-bit Fiat–Shamir challenge space.** Every folding challenge is drawn from the
quartic extension `F_p[X]/(X^4 − 11)`, the rate is `ρ = 1/16`, 88 queries are asked,
and the query transcript is sealed with 20 bits of proof-of-work. The earlier
demonstration parameterisation (31-bit base-field challenges, `ρ = 1/4`, 12 queries,
~8–24 bits) is described in §3.1/§3.2 as the closed findings F1 and F2.

The primitive is nevertheless still **⛔ UNAUDITED** and still firewalled from
consensus, ledger and sealing by `MAINNET-GATES.md`. Parameters reaching a target
is not the same as a cryptographer having reviewed the construction; what remains
open is stated in §4.

Authoritative sourcesAuthoritative sources — every number below is derived from these:

- `src/fri.js` — the FRI low-degree test (`friProve` / `friVerify`), field, folding
- `src/xzk.js` — the ZK cube-curve commitment that composes two FRI instances
- self-tests at the foot of each file (accepts genuine / rejects tampered codeword)

---

## 1. What FRI proves here

FRI is a **low-degree test**: given a Merkle-committed codeword `cw` over an
evaluation domain of size `N`, it convinces a verifier that `cw` is (close to) the
evaluations of a polynomial of degree `< K`, using **`O(nq · log K)` openings —
independent of the degree** (the property that makes hiding possible; the direct
test would open `deg+1` points and reconstruct the polynomial).

`xzk` uses this to prove *"the committed degree-`<K` curve passes through the public
points AND the (blinded) secret points"* without revealing the secret points —
`prove()` runs **two** FRI instances (`friP`, `friC`) plus Merkle commitments; the
statement is a state commitment that **composes with MAYO** (which still signs
identities/txs). FRI is a commitment/soundness layer, **not** a signature.

---

## 2. Parameters (from the code)

| Parameter | Symbol | Shipped default | Source |
|-----------|--------|-----------------|--------|
| Field prime | `p` | **2013265921 = 15·2²⁷+1** (the "BabyBear" prime) | `fri.js` |
| Base field size | — | **31 bits** | derived |
| **Challenge field** | `F_p[X]/(X⁴−11)` | **~124 bits** | `fri.js` `fsExt`, `eMul` |
| 2-adicity | — | `p−1 = 2²⁷·15` ⇒ subgroups up to size 2²⁷ | derived |
| Degree bound | `K` | **32** | `xzk.js` `setup` |
| Domain size | `N` | **512** | `xzk.js` `setup` |
| Blowup | `N/K` | **16** | derived |
| Rate | `ρ = K/N` | **1/16** | derived |
| Folding rounds | `log₂K` | **5** (fold by 2 to a constant) | `fri.js` |
| Queries | `nq` | **88** | `xzk.js` `setup` |
| Constraint openings | `nc` | **32** | `xzk.js` `setup` |
| Grinding | `GRIND_BITS` | **20** | `fri.js` |
| Domain generator | `ω` | `31^((p−1)/N)`, smooth 2-power subgroup | `fri.js` |
| Hash | — | SHA-256 (Merkle + Fiat–Shamir) | `fri.js` |
| Proof size | — | ~950 KB | measured |
| Prove / verify | — | ~1.0 s / ~10 ms | measured |

`X⁴ − 11` is irreducible over `F_p` by Serret's criterion: `ord(11)` is even and
`(p−1)/ord(11)` is odd, and `4 | p−1`. It is the same quartic Plonky3 uses for
BabyBear.

Folding is the standard even/odd split: `next[j] = even + β·odd` where
`even = (a+b)/2`, `odd = (a−b)/(2·d[j])`, and **`β ∈ F_p^4`** is Fiat–Shamir-derived
from the transcript of Merkle roots. Layer 0 stays in the base field — deliberately,
so its Merkle leaf encoding is identical to a caller's own `merkle(cw)` and the two
commitments can be bound (see §3.6) — and layers 1..5 are extension-valued, committed
under a distinct leaf tag. The final layer must be **constant in `F_p^4`**
(`friVerify` rejects a non-constant final word). Query indices are derived only
**after** the transcript is sealed with proof-of-work.

## 3. Soundness — the concrete numbers

FRI soundness has two parts: (i) the **query phase** — a codeword `δ`-far from any
degree-`<K` polynomial is caught with probability ≈ `δ` per query, so `nq` queries
give error ≈ `(1−δ)^{nq}`; and (ii) the **commit/folding phase** soundness, which is
bounded by the challenge space. Bits of security ≈ `−log₂(error)`.

At the shipped parameters (`ρ = 1/16`, `nq = 88`, 20 grinding bits):

- **Unique-decoding regime** (provable, conservative): proximity radius
  `δ ≤ (1−ρ)/2 = 0.469`. Per-query catch ≥ `0.469` ⇒
  `nq · log₂(1/(1−δ)) = 88 · 0.912 ≈ 80 bits`, **+20 grinding ⇒ ≈ 100 bits**.
- **List-decoding / conjectured regime**: `nq · log₂(1/ρ) = 88 · 4 = 352`,
  **+20 ⇒ ≈ 372 bits**.
- **Fiat–Shamir challenge space**: `≈ 124 bits` (was 31 — see F1).
- **Constraint check** (`xzk`, `nc = 32` random points, committed degree ≤ 50):
  false accept ≈ `(deg/N)^{nc}` ⇒ `≈ 107 bits`.

The binding number is therefore **≈100 bits provable**, and the challenge space is no
longer the ceiling it was.

### 3.1 FINDING F1 — 31-bit base field ⇒ grindable challenges (CLOSED)

All randomness — fold `β` and query indices — was drawn from the **31-bit** base field
via `fsField`/`fsIndex`. A 31-bit challenge space lets a prover **grind** the
Fiat–Shamir transcript (re-roll the committed data) to hit favourable challenges at
`≈ 2³¹` work, and no query count could exceed that ceiling. This was the decisive gap.

**Closed.** `fri.js` now carries the quartic extension `F_p[X]/(X⁴−11)` (`eMul`,
`eAdd`, `eScale`, `eEq`, `merkleExt`, `mverifyExt`) and every folding challenge comes
from `fsExt` — four independently hashed limbs, `≈124 bits`. Folding, the layer
commitments and the final-word constancy check all happen in the extension. Pinned by
`xzk.test.mjs` ("folding challenges are drawn from ~124 bits, not 31") and by the
`fri.js` self-tests (`X⁴ === W`, commutativity).

### 3.2 FINDING F2 — no grinding PoW, rate too high (CLOSED)

There was no proof-of-work factor in the transcript and the rate was `ρ = 1/4` with
`nq = 12`, leaving `nq` as the only knob.

**Closed.** The query transcript is sealed with `GRIND_BITS = 20` of proof-of-work
before any query index is derived (`friProve` searches a nonce; `friVerify` re-checks
it), and the rate is now `ρ = 1/16` with `nq = 88`. The verifier owns all three:
`friVerify` rejects a proof whose `K`, `N`, query count or `grindBits` differ from the
parameters it was given, so a prover can neither thin its query set nor lower its own
proof-of-work. Pinned by `xzk.test.mjs` ("a thinned query set is rejected", "a lowered
proof-of-work claim is rejected") and the `fri.js` self-tests (a broken grind seal is
rejected).

### 3.3 FINDING F3 — `friVerify` fold-consistency check was convoluted (CLOSED)

The check contained dead/degenerate expressions — a ternary yielding `'a'` in both
branches, an unused `nextVal`/`nv` — so although the effective comparison did enforce
the fold relation, a reviewer could not read it and be sure the folded value met the
*correct* opened index at every layer.

**Closed.** The loop is rewritten: one `sc = 1/(2·d[i])` scalar, one `folded`, and a
single explicit statement of which opening at layer `f+1` is index `i` (`stn.i === i`
or `stn.i + nextHalf === i`, the only two possibilities since layer `f+1` has half the
points). The index bookkeeping is now stated rather than inferred. It remains a review
item for the external audit — "readable" is not "proven" — but there is no longer dead
logic obscuring it.

### 3.4 FINDING F4 — the prover chose the degree bound (FOUND AND FIXED, 2026-09-20)

`friVerify` destructured `K` and `N` **from the proof itself**, and `xzk.verify` called
`friVerify(proof.friP, dom)` without ever comparing against `ctx.K`. The degree bound — the whole
content of a low-degree test — was therefore prover-chosen: fold one extra round, declare `K=64`,
and a curve carrying far more degrees of freedom than the agreed bound is accepted by a verifier
set up at `K=32`. Since the DOF of the committed curve is exactly what bounds how much the secret
points are constrained, this weakened both the binding and the statement itself.

Reproduced as an outcome, not an argument: a degree-50 codeword is **rejected** when proved at
`K=32` and **verifies** when the same codeword is proved at a claimed `K=64`.

**Fixed.** `friVerify(proof, dom0, expectK)` now takes the bound as a required verifier-side
parameter and rejects `proof.K !== expectK`, rejects `proof.N !== dom0.length`, and is fail-closed
when `expectK` is omitted so no caller can reintroduce the hole; `xzk.verify` passes `ctx.K`.
Pinned by `xzk.test.mjs` ("a prover-declared degree bound is rejected by a K=32 verifier (F4)"),
which fails against the pre-fix code and passes after. This one is CLOSED — unlike F1/F2, it was a
verifier bug rather than a parameter choice.

**The same hole existed one layer up, at the contract boundary, and is also closed.** The zk host
call built its context with `zk.setup(staged.opts || {})`, and `staged` is the single `opts.zk`
object supplied by whoever supplies the proof (`contract-host.js:414`) — so a contract's verifier
parameters were caller-chosen even after the library fix. Verified as an outcome: against the
pre-fix host, a curve proved at a claimed `K=64` with `opts: { degreeBound: 64 }` staged made
`xmbl_zk_verify` return **1** and would have gated a Verkle write on it. The host now builds its
context from the module defaults and treats any staged attempt to move `degreeBound`, `domainSize`,
`nQueries` or `nConstraints` as unavailable, so verify returns 0 and the root stays put. Pinned by
`reproductions/contract-zk.mjs` claim 5b, which fails against the pre-fix host.

### 3.5 Hygiene — the Fiat–Shamir transcript does not bind the statement

`fsIdx` draws the constraint indices from `comP.root + ':' + comC.root` only, and `friProve` starts
its transcript at the codeword's Merkle root: neither commits to the public anchor points, the
derived coordinate, or `K`/`N`. This is not currently a break — `verify` rebuilds `I_R`/`Z_R` from
its **own** public points, so a proof transplanted onto a different statement fails the divisibility
check — but binding all public inputs and parameters into the transcript is standard practice and
removes a class of grinding the ≥124-bit extension field (F1) would otherwise still permit.

### 3.6 The two commitments are bound to one codeword

`xzk.prove` Merkle-commits the evaluations (`rootP`/`rootC`, which authenticate the
constraint openings) and separately runs FRI over the same evaluations (which
authenticates low-degreeness). Nothing forced those to be the *same* codeword: a
prover could have supplied a low-degree proof of one polynomial and constraint
openings from another. `xzk.verify` now requires `proof.friP.roots[0] === proof.rootP`
and `proof.friC.roots[0] === proof.rootC`. Keeping FRI layer 0 in the base field, with
the same Merkle leaf encoding as `merkle(cw)`, is what makes that check possible.
Pinned by `xzk.test.mjs` ("an unbound constraint commitment is rejected").

### 3.7 FINDING F5 — the AIR path was not zero-knowledge (FOUND AND FIXED, 2026-09-21)

Reported by `handoff-claude` against the published `@xmbl/zero-knowledge@0.1.12`,
reproduced here independently, and fixed.

`air.js` proved a general AIR by FRI-testing the composition
`C(x) = Σ α_k·T_k(x)/Z_T(x) + Σ β_j·(col'_j(x) − v_j)/(x − g^row)`.
`α` and `β` are public — Fiat–Shamir over the roots and the statement — and `C(x)` is an
element of `F_p⁴`, while `u = T/Z_T` and `v = (col' − value)/(x − g^row)` are base-field
scalars. One opening is therefore **four equations in two unknowns**: solve any two limbs
for `v`, and `col'(x) = v·(x − g^row) + value`. Every FRI query opens layer 0 at two
points, so `nq = 96` queries handed out ~178 distinct evaluations of a polynomial of
degree `2T − 1 + blindDeg = 71`. Interpolating and evaluating at `g⁰` returned the secret
`1234567` exactly, in about a second. The `(x^T − 1)` blind could not help: it is sized
for the `2·nc` direct openings and vanishes on the trace domain by construction. The
suite's `!JSON.stringify(proof).includes(secret)` check was true and irrelevant.

**Fix — mask the composition.** A uniformly random polynomial `M` with EXTENSION
coefficients and degree `< K` is committed before any challenge is drawn; `γ` is drawn
from a transcript that includes `M`'s root; FRI runs on `D = C + γ·M`. Each opening is now
four equations in six unknowns (`u`, `v`, and `M(x)`'s four limbs) — rank 4 of 6, two free
dimensions, `col'(x)` undetermined. At the `nc` consistency points the verifier opens `M`
against its own root and checks `D(x) = C_recomputed(x) + γ·M(x)`.

**Masking cannot hide a false statement.** If `M` were not of degree `< K`, then `D` being
of degree `< K` would require `C_hi + γ·M_hi = 0`, which pins `γ` to a single element of
`F_p⁴` (~2^124) — and `γ` is drawn after `M` is committed.

**Parameters.** `M` hides only while the transcript reveals fewer than its `K` coefficients.
A query opens both halves at layer 0 and one genuinely new sibling at each of the remaining
`log2 K − 1` folds, so the count is `nq·(log2 K + 1) + nc`. `setup` now doubles `K` until it
clears that with margin: at `nq = 100`, `nc = 40` this gives `K = 2048`, `N = 16384`,
revealed 1240 of 2048. Raising `K` is the cheap knob — it grows the domain and the fold
count but leaves every polynomial degree where it was. `nc` was raised 16 → 40 in the same
change: each consistency point is `−log2(K/N) = 3` bits, so `nc = 16` was a ~48-bit check
sitting behind a ~100-bit FRI, and `nc = 40` makes it ~120.

The coset evaluation is now an NTT (`fri.js` `ntt`, `evalCoset`) — a degree-2047 mask over
16384 points is 33M multiplications by Horner and 115k butterflies by NTT. Proving is
faster than before the fix despite the larger domain.

**The `xzk` path was attacked the same way and survives.** FRI layer 0 of `friP` IS the
curve codeword in the clear, so ~150 openings recover the committed curve `Pt` exactly —
the curve is public and always was. The witness is not: `Pt = P + Z_R·B` with `B` uniform
of degree 18 while `(P − I_R)/Z_R` has degree 1, so the recovered curve is consistent with
a 2-parameter family of secret point sets. `xzk.test.mjs` exhibits a second witness and the
legal blind that carries the same proof.

### 3.8 What the tests establish

The `fri.js` self-tests are outcome checks: FRI **accepts** a random degree-`<32`
codeword, **rejects** a codeword with a few tampered points, **rejects** a degree-`39`
(`>K`) codeword, and **rejects** both a broken grinding seal and a lowered grinding
claim. The extension arithmetic is checked directly (`X⁴ === W`, commutativity).

`xzk.test.mjs` (26 checks) additionally pins completeness, soundness against a forged
derived value and a wrong `derivedX`, the prover-chosen degree bound (F4), a thinned
query set, a lowered proof-of-work claim, the commitment binding (§3.6), the blind's
freshness and its inability to move the derived value, and that no opened field
element in a ~950 KB proof equals a secret point's value — and that the recovery attack of
§3.7 recovers the committed curve but not the witness.

`air.test.mjs` (30 checks) pins the general-purpose path: completeness over three
computations, a trace that breaks its own rule, tampered trace / composition / MASK
openings, a thinned opening set, statement binding against a same-sized other statement,
and the §3.7 recovery attack as a standing check — it still collects 200 openings for a
degree-119 interpolation and returns neither the secret nor any other trace row.

---

## 4. Assumptions & required changes for any security reliance

| # | Statement | Status |
|---|-----------|--------|
| Z1 | FRI is a sound low-degree test in the ROM (hash-based, post-quantum) | Standard, IF adequately parameterised |
| Z2 | Shipped parameters reach a cryptographic target | **≈100 bits provable / ≈372 conjectured** (§3) |
| Z3 | Fiat–Shamir challenges are drawn from a ≥124-bit space | **CLOSED — quartic extension `F_p[X]/(X⁴−11)`** (§3.1) |
| Z4 | Grinding PoW seals the query transcript | **CLOSED — 20 bits, verifier-enforced** (§3.2) |
| Z5 | Verifier fold-check logic is correct | Rewritten and readable (§3.3); **still an external-audit item** |
| Z6 | xzk hiding: secret points blinded by `Z_R·B` (degree-18 blind) | Blind is FRESH randomness, every coefficient independent, CSPRNG by default. The openings do NOT stay below the blind's degree — the whole curve is recoverable — but the hiding does not depend on that: `deg B = 18` over a witness quotient of degree 1 leaves a 2-parameter family of witnesses per proof, exhibited in `xzk.test.mjs` (§3.7). **The general argument for arbitrary point counts is still not proved. Audit item.** |
| Z7 | FRI must not gate consensus/ledger/sealing | Enforced by policy (`MAINNET-GATES.md`) — keep until the audit lands |
| Z8 | The degree bound is the VERIFIER's parameter | **CLOSED — F4, library and contract host** (§3.4) |
| Z9 | Fiat–Shamir challenges bind the whole statement | **CLOSED for `air`** — `statementTag` absorbs every parameter and boundary cell; **open for `xzk`**, whose transcript covers Merkle roots only (§3.5) |
| Z11 | AIR hiding: the FRI transcript reveals nothing about the trace | **CLOSED — F5** (§3.7): unmasked it revealed the trace outright; the composition is now masked by a uniform extension-valued degree-`<K` polynomial and `setup` keeps `K` above everything the transcript reveals |
| Z10 | The low-degree test and the constraint openings are one codeword | **CLOSED** (§3.6) |

**What remains before `xzk` can be relied on.** The parameter findings (F1, F2) and
the two verifier defects (F3's dead logic, F4's prover-chosen bound) are closed, and
the commitment binding (§3.6) is added. Open: (a) the **zero-knowledge argument** —
`air`'s hiding is now a counting argument (§3.7, Z11) and `xzk`'s is a witness-family
argument, both checked empirically against the attack that broke the unmasked version, but
neither is a proof (Z6, Z11);
(b) absorbing the public points, derived coordinate and parameters into the
Fiat–Shamir transcript (Z9, §3.5); (c) an **external review by a ZK cryptographer**,
ideally MAYO/UOV-adjacent since `xzk` composes with MAYO. Until (c) lands the
`MAINNET-GATES.md` ⛔ stands and `core` keeps the commitment strictly additive.

This document states measured parameters and derived soundness bounds. Reaching a bit
target is a necessary condition, not a sufficient one, and nothing here substitutes for
the audit.
