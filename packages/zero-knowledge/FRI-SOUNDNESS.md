# FRI parameter & soundness write-up (audit prep — T2.5)

**Status: PRE-AUDIT REVIEWER PACKAGE for an EXPERIMENTAL, UNAUDITED primitive.**
`@xmbl/zero-knowledge` (`xzk`) is a hash-based (post-quantum) low-degree-test /
state-commitment layer built on FRI. This document states its parameters and, in
concrete numbers, its **soundness** — and the finding is unambiguous: **at the
shipped defaults this is a demonstration parameterisation with ~single-to-low-tens
of bits of soundness, NOT a 100/128-bit-secure proof system.** It must not gate
consensus, ledger, or sealing (as `MAINNET-GATES.md` §`@xmbl/zero-knowledge`
already states); this write-up is the reviewer-facing basis the ⛔ AUDIT attacks.

Authoritative sources — every number below is derived from these:

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
| Field prime | `p` | **2013265921 = 15·2²⁷+1** (the "BabyBear" prime) | `fri.js:8` |
| Field size | — | **31 bits** | derived |
| 2-adicity | — | `p−1 = 2²⁷·15` ⇒ subgroups up to size 2²⁷ | derived |
| Degree bound | `K` | **32** | `xzk.js:34` |
| Domain size | `N` | **128** | `xzk.js:34` |
| Blowup | `N/K` | **4** | derived |
| Rate | `ρ = K/N` | **1/4** | derived |
| Folding rounds | `log₂K` | **5** (fold by 2 to a constant) | `fri.js:57` |
| Queries | `nq` | **12** | `xzk.js:34` |
| Domain generator | `ω` | `31^((p−1)/N)`, smooth 2-power subgroup | `fri.js:34` |
| Hash | — | SHA-256 (Merkle + Fiat–Shamir) | `fri.js:13` |

Folding is the standard even/odd split: `next[j] = even + β·odd` where
`even = (a+b)/2`, `odd = (a−b)/(2·d[j])`, `β = FS(transcript)` — verified against
each next layer, and the final layer must be **constant** (`friVerify` rejects a
non-constant final word). Queries and betas are Fiat–Shamir-derived from the
transcript of Merkle roots.

---

## 3. Soundness — the concrete numbers (the load-bearing finding)

FRI soundness has two parts: (i) the **query phase** — a codeword `δ`-far from any
degree-`<K` polynomial is caught with probability ≈ `δ` per query, so `nq` queries
give error ≈ `(1−δ)^{nq}`; and (ii) the **commit/folding phase** soundness. Bits of
security ≈ `−log₂(error)`.

At the shipped defaults (`ρ = 1/4`, `nq = 12`):

- **Unique-decoding regime** (provable, conservative): proximity radius
  `δ ≤ (1−ρ)/2 = 0.375`. Per-query catch ≥ `0.375` ⇒ soundness
  `≈ nq · log₂(1/(1−0.375)) ≈ **8 bits**`.
- **List-decoding / conjectured regime** (the optimistic bound modern STARKs cite):
  `≈ nq · log₂(1/ρ) = 12 · 2 = **24 bits**`.

**Either way this is nowhere near a cryptographic target.** 8–24 bits means a
cheating prover succeeds with probability between `2⁻⁸` and `2⁻²⁴` — trivially
grindable. To reach ~100 bits one needs, roughly, **`nq` on the order of 50–100+**
(at `ρ = 1/4`, conjectured) or a smaller rate, *and* the field problem below fixed.

### 3.1 FINDING F1 — 31-bit base field ⇒ Fiat–Shamir challenges are grindable

All randomness (fold `β`, query indices) is drawn from the **31-bit** base field via
`fsField`/`fsIndex` over SHA-256 (`fsField` reduces 64 bits mod `p ≈ 2³¹`). A 31-bit
challenge space means a prover can **grind** the Fiat–Shamir transcript (re-roll
Merkle-committed nonces) to hit favourable challenges at `≈ 2³¹` work — cheaper than
any 100-bit target. Real STARKs over BabyBear **never** sample challenges from the
base field: they use a **degree-4+ extension field** (~124 bits) for all FS
challenges and folding. **This code has no extension field at all.** This is the
single most important structural finding: soundness cannot exceed the challenge
entropy regardless of `nq`.

### 3.2 FINDING F2 — no grinding/proof-of-work bits, no repetition to an extension

There is no proof-of-work ("grinding") factor in the transcript and no soundness
repetition over an extension field, both of which production FRI (e.g. ethSTARK,
Plonky2) rely on to buy back bits cheaply. Absent these, `nq` is the only knob and
it is set to 12.

### 3.3 FINDING F3 — `friVerify` fold-consistency check is convoluted (audit the logic)

`fri.js:102–110` contains dead/degenerate expressions — e.g.
`query.steps[f+1][(i % nextHalf) === query.steps[f+1].i ? 'a' : 'a']` (a ternary
that yields `'a'` in both branches) and an unused `nextVal`/`nv`. The effective
check (line 109–110, `openedNext !== folded`) does appear to enforce the fold
relation (the self-tests accept a genuine degree-`<K` word and reject tampered and
too-high-degree words), but the surrounding logic is confusing enough that a
reviewer **must** verify by hand that the folded value is compared against the
*correct* opened index at every layer, and that a malicious prover cannot exploit
the index bookkeeping (`i % half`) to open inconsistent positions. This is a
correctness/soundness review item, not just style.

### 3.4 What the tests DO establish

The self-tests are genuine outcome checks: FRI **accepts** a random degree-`<32`
codeword, **rejects** a codeword with a few tampered points (now far from any
degree-`<K` poly), and **rejects** a degree-`39` (`>K`) codeword. So the primitive
is *functionally* a low-degree test; the issue is **quantitative soundness**, not
that it fails to reject high-degree inputs in these cases.

---

## 4. Assumptions & required changes for any security reliance

| # | Statement | Status |
|---|-----------|--------|
| Z1 | FRI is a sound low-degree test in the ROM (hash-based, post-quantum) | Standard, IF adequately parameterised |
| Z2 | Shipped defaults give ~8–24 bits soundness | **Finding — demo only, not cryptographic** (§3) |
| Z3 | 31-bit base field ⇒ FS challenges ≤31 bits, grindable | **Finding F1 — needs an extension field** (§3.1) |
| Z4 | No grinding PoW / extension-field repetition | **Finding F2** (§3.2) |
| Z5 | Verifier fold-check logic is correct | **Must be hand-verified** (Finding F3, §3.3) |
| Z6 | xzk hiding: secret points blinded by `Z_R·B` (degree-18 blind) | Not analysed here — audit the blind's zero-knowledge/soundness interplay |
| Z7 | FRI must not gate consensus/ledger/sealing | Enforced by policy (`MAINNET-GATES.md`) — keep until Z2–Z5 resolved |

**To make `xzk` security-relevant** an implementation must at minimum: (a) move all
Fiat–Shamir challenges and folding to a ≥124-bit **extension field** of BabyBear;
(b) raise `nq` (and/or lower `ρ`) to hit the target bits, optionally with a grinding
PoW factor; (c) have the folding/consistency check in `friVerify` rewritten cleanly
and re-proven; (d) analyse the `xzk` blinding (Z6) for zero-knowledge. Until then
`xzk` is an **experimental** commitment demo and is correctly firewalled from
consensus.

This document claims nothing secure; it quantifies exactly how far the current
parameters sit from a cryptographic soundness target and names the changes required.
