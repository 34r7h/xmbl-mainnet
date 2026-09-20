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

### 3.7 What the tests establish

The `fri.js` self-tests are outcome checks: FRI **accepts** a random degree-`<32`
codeword, **rejects** a codeword with a few tampered points, **rejects** a degree-`39`
(`>K`) codeword, and **rejects** both a broken grinding seal and a lowered grinding
claim. The extension arithmetic is checked directly (`X⁴ === W`, commutativity).

`xzk.test.mjs` (22 checks) additionally pins completeness, soundness against a forged
derived value and a wrong `derivedX`, the prover-chosen degree bound (F4), a thinned
query set, a lowered proof-of-work claim, the commitment binding (§3.6), the blind's
freshness and its inability to move the derived value, and that no opened field
element in a ~950 KB proof equals a secret point's value.

---

## 4. Assumptions & required changes for any security reliance

| # | Statement | Status |
|---|-----------|--------|
| Z1 | FRI is a sound low-degree test in the ROM (hash-based, post-quantum) | Standard, IF adequately parameterised |
| Z2 | Shipped parameters reach a cryptographic target | **≈100 bits provable / ≈372 conjectured** (§3) |
| Z3 | Fiat–Shamir challenges are drawn from a ≥124-bit space | **CLOSED — quartic extension `F_p[X]/(X⁴−11)`** (§3.1) |
| Z4 | Grinding PoW seals the query transcript | **CLOSED — 20 bits, verifier-enforced** (§3.2) |
| Z5 | Verifier fold-check logic is correct | Rewritten and readable (§3.3); **still an external-audit item** |
| Z6 | xzk hiding: secret points blinded by `Z_R·B` (degree-18 blind) | Blind is now FRESH randomness, every coefficient independent, CSPRNG by default (§3.3 of the code). **The hiding ARGUMENT — that `nq+nc` openings stay below the blind's degree — is still not proved. Audit item.** |
| Z7 | FRI must not gate consensus/ledger/sealing | Enforced by policy (`MAINNET-GATES.md`) — keep until the audit lands |
| Z8 | The degree bound is the VERIFIER's parameter | **CLOSED — F4, library and contract host** (§3.4) |
| Z9 | Fiat–Shamir challenges bind the whole statement | **Not yet** — transcript covers Merkle roots only (§3.5) |
| Z10 | The low-degree test and the constraint openings are one codeword | **CLOSED** (§3.6) |

**What remains before `xzk` can be relied on.** The parameter findings (F1, F2) and
the two verifier defects (F3's dead logic, F4's prover-chosen bound) are closed, and
the commitment binding (§3.6) is added. Open: (a) the **zero-knowledge argument** —
the blind is now fresh randomness with independent coefficients, but nobody has proved
that `nq + nc` openings stay below its degree, which is the actual hiding claim (Z6);
(b) absorbing the public points, derived coordinate and parameters into the
Fiat–Shamir transcript (Z9, §3.5); (c) an **external review by a ZK cryptographer**,
ideally MAYO/UOV-adjacent since `xzk` composes with MAYO. Until (c) lands the
`MAINNET-GATES.md` ⛔ stands and `core` keeps the commitment strictly additive.

This document states measured parameters and derived soundness bounds. Reaching a bit
target is a necessary condition, not a sufficient one, and nothing here substitutes for
the audit.
