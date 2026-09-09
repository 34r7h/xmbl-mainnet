# XMBL Cubic Cryptography — construction & security-assumptions spec

**Status: PRE-AUDIT REVIEWER PACKAGE.** This document is the attack surface an
outside cryptanalyst is asked to break. It specifies, exactly and reproducibly,
the constructions implemented in `@xmbl/identity` and states — without softening
— which security properties are *standard and inherited* versus which are *novel
and unproven*. No construction here should be relied upon for value until the
corresponding ⛔ AUDIT gate in [`MAINNET-GATES.md`](../MAINNET-GATES.md) is closed
by a signed external report. The modules themselves report `secure: false,
audited: false` in `describe()` and this document does not override that.

This whitepaper is authored as audit-prep gates **T2.2** (Cubic-curve construction
+ security assumptions, §2–§3), **the Cubic-SIG analysis** (§5), and **T2.3** (the
PQ-Cubic-LWE parameter justification / decryption-failure analysis, §4, over
`cubic-lwe.js` and `seal.js`).

Every constant, domain tag, and derivation step below is transcribed from the
implementation and can be recomputed. Authoritative sources:

- `packages/identity/src/curve-source.js` — field arithmetic, `CubicCurveSource`
- `packages/identity/src/cubic-sig.js` — Cubic-SIG (geometric Schnorr)
- `packages/identity/src/cubic-lwe.js` — PQ-Cubic-LWE (see §4 / T2.3)
- `packages/identity/src/cubic-crypto.test.mjs` — conformance vectors

---

## 1. Scope, threat model, and the honest-claims boundary

### 1.1 What is standard (inherited security)

- **Cubic-SIG operates on the standard secp256k1 group.** Despite the name, the
  elliptic-curve arithmetic in `cubic-sig.js` uses the secp256k1 base point `G`
  and short-Weierstrass addition with curve coefficient **`a = 0`** (the default
  argument to `ecAdd`/`ecMul`), i.e. the ordinary secp256k1 curve
  `y² = x³ + 7`. Its unforgeability therefore rests on the **well-studied**
  hardness of ECDLP on secp256k1 and on Schnorr's Fiat–Shamir proof in the random
  oracle model (§5). The "cubic" geometry enters Cubic-SIG **only through the
  Fiat–Shamir challenge hash** (domain separation / spatial binding), not through
  the group law. This distinction is load-bearing for the audit: the group
  security of Cubic-SIG is *not* novel.

### 1.2 What is novel (unproven, this is the audit target)

- **`CubicCurveSource` derives fresh curves from ledger geometry** (§3). These
  curves are used as *parameter material* bound to a cube's transaction
  coordinates. Deriving elliptic curves from low-entropy public geometric points
  via a hash expansion is a **novel construction with no third-party
  cryptanalysis.** §2 states the assumptions it stands on and the attacks it must
  survive. Nothing in XMBL should treat a `CubicCurveSource`-derived curve as
  carrying discrete-log hardness comparable to secp256k1 until §2's assumptions
  are externally validated.

- **Spatial non-transferability of Cubic-SIG** (§5.3) — the claim that a signature
  is invalid outside its originating 3-point plane — is a *heuristic* property of
  the challenge binding, not a reduction to a hard problem. It is analysed, not
  proven.

### 1.3 Threat model

Adversary is polynomial-time, sees all public ledger state (cube addresses,
coordinates, plane normals, public keys, signatures, curve parameter blocks), can
adaptively request signatures/curve blocks (chosen-message / chosen-context), and
controls the network. Adversary does **not** hold any honest secret key. Quantum
adversaries: Cubic-SIG and any secp256k1-based primitive are **broken by Shor**
and are explicitly CLASSICAL-ONLY; post-quantum signing is `mayo.wasm` (MAYO,
`MAYO-PROVENANCE.md`) and PQ confidentiality is Cubic-LWE (§4). The random oracle
is instantiated with domain-separated SHA-256.

---

## 2. Cubic-curve construction — cryptanalysis assumptions

`CubicCurveSource` (§3) turns three or more ledger coordinates into an elliptic
curve `E: y² = x³ + a·x + b (mod p)` over the secp256k1 prime field. This section
states the assumptions the construction depends on and the attacks it is designed
to resist. **These are conjectures offered for attack, not theorems.**

### 2.1 Coordinates are PUBLIC and LOW-ENTROPY — not secret material

The input coordinates are ledger geometry, visible to everyone, and carry
**< ~10 bits of entropy** each in practice (small signed integers). The
construction therefore makes **no secrecy assumption** about them. They serve as
*verifiable public evaluation points*: two honest nodes with identical ledger
state derive byte-identical curve parameters (determinism is a *feature*, tested
in `cubic-crypto.test.mjs`), and any party can recompute and check the derivation.
Security must come from the hash expansion (§2.2), never from coordinate secrecy.

**Assumption A1 (no-secrecy):** the scheme's security does not degrade when the
adversary knows the coordinates, cube address, and plane normal in full.

### 2.2 MinRank / low-rank structure resistance

A naive geometric parameterisation — building curve coefficients as
outer-products or low-degree polynomials of the coordinate vectors — would expose
**low-rank algebraic structure** exploitable by MinRank-style attacks (the same
family that threatens multivariate schemes). The construction defeats this by
deriving `a` and `b` **only** through a domain-separated hash into `F_p`
(`a = H(S‖1)`, `b = H(S‖2)`, §3.4): no matrix formed from the geometric vectors
is ever used as curve material.

`curve-source.js` ships `matrixRankModP` specifically so this can be *measured*,
not merely asserted, and `cubic-crypto.test.mjs` (TEST 1) exercises it: it computes,
over `F_p`, the rank of the naive geometric outer-product (`u·vᵀ` of two
coordinate-derived vectors — **rank 1**, exactly the structure MinRank exploits)
versus the hash-expanded material derived from the *same* coordinates (a `K×K`
block of `H(seed‖i‖j)` — **full rank `K`**), demonstrating empirically that the
hash step destroys the low-rank structure. **The audit is asked to confirm** that
no residual low-rank relation survives the hash expansion (the in-repo check
covers the naive outer product only; a MinRank cryptanalyst must rule out
higher-rank / non-outer-product structure the test does not enumerate).

**Assumption A2 (hash-expansion / random-oracle):** modelling `H` as a random
oracle, `(a, b)` are computationally indistinguishable from uniform in `F_p²`
given the public inputs, so `E` is a *random* curve over `F_p` from the
adversary's view — carrying no exploitable algebraic relation to the coordinates.

### 2.3 Non-singularity is enforced, not assumed

The discriminant `Δ = 4a³ + 27b² (mod p)` is checked `≠ 0`; if a derivation hits
the negligible (`≈ 1/p`) singular case, `b` is re-derived with an incrementing
counter until `Δ ≠ 0` (bounded, deterministic). Singular (nodal/cuspidal) curves —
on which the discrete-log problem collapses — are therefore **structurally
excluded** from the output. Verifiable by recomputing `Δ` from the packed block
(the conformance test does exactly this).

### 2.4 Curves carry points but their group order is NOT validated

`describeDerivation` proves a derived curve is *non-empty* by scanning `x = 1..64`
for a quadratic residue `x³+ax+b` (via Tonelli–Shanks `sqrt`) and returning a
witnessed point. **This is existence, not cryptographic suitability.** The
construction does **not** compute the group order, does **not** check for a large
prime-order subgroup, and does **not** screen for anomalous / small-embedding-
degree (MOV/Frey–Rück) or CM-based weak curves.

**Open cryptanalytic question O1 (the central one for the audit):** a *random*
curve over `F_p` has, with overwhelming probability, near-prime order and no
special structure (Hasse + standard heuristics), but a construction that emits
curves for use with discrete-log-hardness *must* either (a) validate order /
subgroup structure per-curve, or (b) carry an argument that the random-oracle
derivation makes weak-curve output negligibly probable **and** that no adversary
can *steer* the coordinates to bias the output toward a weak curve. Neither (a)
nor (b) is currently implemented or proven. Until O1 is resolved, a
`CubicCurveSource` curve must not be relied on for discrete-log-hardness. (Note:
Cubic-SIG in §5 sidesteps O1 entirely by signing on secp256k1, not on these
derived curves.)

### 2.5 Determinism vs. grinding

Because derivation is deterministic and the coordinates are attacker-visible, an
adversary who can *influence which coordinates a cube commits* could grind toward
a curve with chosen properties. The domain tag `xmbl/xid/cubic-curve-source/v1`
and the inclusion of the plane normal + cube address in the seed raise the cost,
but **the construction does not by itself bound an adversary's ability to bias
inputs.** Any deployment relying on curve unpredictability must argue that cube
coordinates are not adversarially chosen (this is a *ledger-consensus* assumption,
not a *cryptographic* one).

---

## 3. `CurveSource` seam and the `CubicCurveSource` construction (§3.1)

### 3.0 The seam

The signature layer depends only on the abstract `CurveSource` interface:
`getCurveParams(request) → Uint8Array` of exactly `CURVE_PARAM_BLOCK_SIZE = 64`
bytes. The insecure `PlaceholderCurveSource` that once implemented this seam has
been **deleted** from the mainnet repo (a zero-security stand-in must never ship);
`CubicCurveSource` is the only concrete implementation.

A `CurveRequest` is `{ cubeAddress, coordinates: [{x,y,z,magnitude?}, …] }`.
`canonicalizeRequest` produces an **order-preserving**, type-tagged canonical
string: scalars are tagged (`b:` bigint, `n:` number, `s:` string; non-finite
numbers rejected), coordinates are **index-prefixed** so reordering identical
values yields a different canonical form, and the array is never sorted. Identical
ledger state ⇒ byte-identical canonical form ⇒ deterministic output across nodes.

### 3.1 `CubicCurveSource.getCurveParams` — the specified construction

Field: secp256k1 prime
`p = 0xFFFFFFFF…FFFFFC2F` (`SECP256K1_P`). All arithmetic via `CubicField`
(`mod`, `add`, `sub`, `mul`, `pow` by square-and-multiply, `inv` by Fermat
`a^(p−2)`, `sqrt` by Tonelli–Shanks with the `p ≡ 3 (mod 4)` shortcut
`n^((p+1)/4)`, and `hashToField` = domain-tagged SHA-256 reduced mod `p`).

Given `coordinates.length ≥ 3` and taking the first three points `c0, c1, c2`:

**Step 1 — plane normal (over `F_p`).** With `d12 = c1 − c0`, `d13 = c2 − c0`
(integer differences lifted into `F_p`, so negatives wrap correctly):

```
n = d12 × d13
nx = d12.y·d13.z − d12.z·d13.y
ny = d12.z·d13.x − d12.x·d13.z
nz = d12.x·d13.y − d12.y·d13.x     (all mod p)
```

If `n = (0,0,0)` the three points are **collinear** — there is no plane to cut the
cubic hypersurface with — and the construction **throws** rather than emit a curve
from a degenerate plane.

**Step 2 — consensus seed.**
```
S = hashToField( "xmbl/xid/cubic-curve-source/v1",
                 canonicalizeRequest(request),
                 nx, ny, nz,
                 encodeScalar(cubeAddress) )         ∈ F_p
```

**Step 3 — curve parameters.** `a = hashToField(S, 1)`, `b = hashToField(S, 2)`,
each in `F_p` (see A2, §2.2).

**Step 4 — non-singularity.** Compute `Δ = 4a³ + 27b² (mod p)`; if `Δ = 0`,
re-derive `b = hashToField(S, 2+attempts)` and retry (bounded at 255; the singular
case has probability `≈ 1/p`). Guarantees the emitted curve is non-singular (§2.3).

**Step 5 — pack.** 64-byte block `[ a_be(32) ‖ b_be(32) ]`, big-endian, zero-left-
padded. `CubicCurveSource.unpackParams` inverts this.

**Verifiability.** `describeDerivation(request)` returns *every* intermediate as
exact bigints — `d12, d13, normal, seed, a, b, Δ, nonSingular, attempts` — plus a
witnessed point `{x,y}` on `E` (via the `sqrt` scan, §2.4) and the boolean
`pointOnCurve`. A reviewer recomputes the whole derivation by hand and checks each
value rather than trusting a boolean.

### 3.2 Self-reported status

`CubicCurveSource.describe()` returns `placeholder: false, secure: false,
audited: false` with the note that the construction is *verifiable-nonsingular but
UNAUDITED; do not rely on for value until MAINNET-GATES.md is closed*. A module
never asserts its own security; this document does not either.

---

## 4. PQ-Cubic-LWE — parameter justification (gate T2.3)

`cubic-lwe.js` implements a **plain (unstructured) matrix-LWE** IND-CPA public-key
encryption and the KEM built on it; `seal.js` wraps the KEM into a hybrid sealed
envelope (KEM → HKDF-SHA256 → AES-256-GCM). This section justifies the parameters
and states — without softening — the decryption-failure behaviour and the two
findings an auditor must weigh (M1 sampler bias, M2 IND-CPA-only).

### 4.1 Construction

Regev-style LWE over `Z_q`. Secret `s`, error `e`, and all ephemeral randomness are
sampled from the **ternary ball `{−1,0,1}^N`** (`η = 1`). Public matrix `A` is
uniform `N×N`.

- **`keyGen`:** `s, e ← ternary^N`, `A ← U(Z_q^{N×N})`, `pk = (A, b = A·s + e mod q)`,
  `sk = s`.
- **`encryptBit(pk, m∈{0,1})`:** `r, e₁ ← ternary^N`, `e₂ ← ternary`;
  `u = Aᵀ·r + e₁`, `v = bᵀ·r + e₂ + m·⌊q/2⌋` (mod `q`). Ciphertext `(u, v)`.
- **`decryptBit(sk, (u,v))`:** `d = (v − sᵀ·u) mod q`; output `1` iff
  `d ∈ (q/4, 3q/4)`, else `0`.
- **KEM:** `encapsulate` draws a 256-bit secret, encrypts it **bit-by-bit** (256
  independent LWE ciphertexts), and returns `SHA-256(secret)` as the shared key;
  `decapsulate` decrypts the 256 bits and re-hashes. A fast exact-integer path is
  used when `N·(q−1)² ≤ 2^53` (true for the shipped params) and is **bit-identical**
  to the BigInt path (the bound guarantees no float rounding).

### 4.2 Parameter choices

| Param | Value | Rationale |
|-------|-------|-----------|
| `q` | **3329** (prime, ≈2¹²) | Kyber's modulus; `⌊q/2⌋ = 1664` is the bit-encoding anchor, `q/4 = 832` the decision margin. |
| `N` (toy) | **27** = 3 faces × 9 blocks | Atomic-cube dimension. **DEMONSTRATION ONLY — no quantum margin.** `DEFAULT_N`. |
| `N` (mainnet) | **729** = 27³ (`MAINNET_N`) | Level-2 supercube. `seal.js` **fails closed** below this: `seal()` throws for `N < 729` unless `allowWeak` (stamped non-value). Value envelopes therefore always ride `N = 729`. |
| noise | ternary `η = 1` | Short-vector distribution; `‖s‖, ‖e‖` small ⇒ small decryption noise (§4.3). |

**The "cubic" is dimension-labelling, not a source of hardness.** `N = 27` and
`N = 729` are chosen to line up with cube/supercube geometry, but the scheme is
ordinary plain-LWE with a ternary secret — the geometry adds *no* cryptographic
structure or hardness beyond a standard LWE instance of that dimension. This is
stated so the audit does not credit the construction with unearned novelty.

**Structure note (not a vulnerability):** this is *plain* LWE (a full `N×N` matrix
`A`), not Module/Ring-LWE. Keys are `O(N²)` and ciphertexts `O(N)`, so envelopes
are large (`seal.js` notes ≈500 KB at `N = 729`). Plain-LWE has *fewer* algebraic
structure concerns than Ring-LWE (a conservative choice), at a size cost.

### 4.3 Decryption-failure analysis (verified empirically)

Expanding `d − m·⌊q/2⌋` gives the noise
**`E = eᵀr − sᵀe₁ + e₂`** — a sum of `2N + 1` products of independent ternary
values, each product in `{−1,0,1}`. Correct decryption requires `|E| < q/4 = 832`.

- **Worst-case bound.** `|E| ≤ 2N + 1`. For `N = 27` that is **55 < 832 → decryption
  never fails** (matches the module's 100-trial self-test, 0 errors, and 3000-trial
  check here, 0 errors). For `N = 729` the worst case is **1459 > 832**, so a
  decryption failure is *not structurally impossible* and must be bounded
  probabilistically.
- **Measured behaviour (`N = 729`, `q = 3329`).** Over 5000 encrypt/decrypt trials
  the noise is zero-mean with **σ ≈ 25.4** and observed **max |E| = 95** — i.e. the
  `q/4 = 832` threshold sits **≈ 32σ** away. Per-bit failure probability is thus
  cryptographically negligible (a Gaussian tail at 32σ is far below 2⁻¹⁰⁰);
  amortised over the 256-bit KEM it remains negligible. (`N = 27`: σ ≈ 5.2, max 17,
  threshold ≈ 160σ.)
- **Audit deliverable.** A *rigorous* sub-Gaussian or exact-convolution decryption-
  failure-probability (DFP) bound — not just the empirical σ above — should be
  produced for `N = 729`, since the worst-case bound exceeds the threshold. The
  empirical margin is large enough that this is expected to pass comfortably.

### 4.4 Security assumptions and findings

**Assumption L1 (LWE / SVP).** IND-CPA security of `encryptBit`/the KEM reduces to
decision-LWE with ternary secret and noise over `Z_q`, dimension `N`, which reduces
(worst-case) to `GapSVP`/`BDD` in `N`-dimensional lattices — believed hard for
classical *and* quantum adversaries (immune to Shor). This is the standard,
well-studied basis and is the scheme's genuine strength.

**Claim to verify — the 2¹⁶⁸ figure.** The source asserts "Core-SVP hardness
exceeds 2¹⁶⁸ quantum gates (NIST PQC Category 3+)" for `N = 729, q = 3329`. This
figure is **not derived from a lattice-estimator run in this repo.** The Core-SVP
estimate depends on `N`, `q`, the ternary secret/noise, and the number of LWE
samples exposed by `pk` (here `N` samples). **Audit deliverable:** reproduce the
estimate with the Albrecht *et al.* lattice estimator and confirm (or correct) the
category claim; treat 2¹⁶⁸ as *unverified in-repo* until then.

**Finding M1 — ternary sampler has a small modulo bias.** `sampleTernary` maps a
uniform byte `b∈[0,255]` via `b % 3`, but 256 is not divisible by 3: residues
distribute **86 / 85 / 85**, so `P(−1) ≈ 0.3363`, `P(0) ≈ 0.3329`, `P(+1) ≈ 0.3308`
(verified empirically over 200k samples) — a ≈0.3% excess toward `−1`. This is a
minor bias in an `η = 1` distribution and is unlikely to matter for SVP hardness at
these margins, but it is a **statistical non-uniformity a reviewer will flag**;
rejection sampling (discard `b ≥ 255`) removes it at negligible cost and should be
adopted.

**Finding M2 — the KEM is IND-CPA, NOT IND-CCA2.** `decapsulate` decrypts and
re-hashes; it performs **no Fujisaki–Okamoto re-encryption/consistency check**.
Kyber achieves IND-CCA2 precisely by adding FO on top of an IND-CPA core; this KEM
omits it. Consequences: the KEM is malleable, and reuse of a receiver KEM public key
against an adversary who can submit chosen ciphertexts and observe decapsulation is
**not** covered by the security argument. `seal.js` layers AES-256-GCM (AEAD) over
the HKDF-derived key, which authenticates the *symmetric payload* — but it does not
turn the *KEM* into a CCA-secure one. **Audit deliverable / recommendation:** either
apply an FO transform to reach IND-CCA2, or document and enforce single-use KEM
public keys with the CPA limitation made explicit at the seal API.

### 4.5 Summary (Cubic-LWE)

| # | Statement | Type | Status |
|---|-----------|------|--------|
| L1 | IND-CPA ⇐ decision-LWE (ternary) ⇐ worst-case SVP/BDD; quantum-safe | Reduction | Standard LWE (§4.4) |
| L2 | `N = 729, q = 3329` ⇒ decryption failure negligible | Assumption | Empirically σ≈25.4, ≈32σ margin; rigorous DFP bound is an audit deliverable (§4.3) |
| L3 | Core-SVP ≥ 2¹⁶⁸ quantum (NIST Cat 3+) | Claim | **Unverified in-repo** — reproduce via lattice estimator (§4.4) |
| M1 | Ternary sampler modulo bias (86/85/85) | Finding | Real, minor; fix with rejection sampling (§4.4) |
| M2 | KEM is IND-CPA only (no FO transform) | Finding | Real; add FO for CCA2 or enforce single-use pk (§4.4) |
| L4 | `seal.js` fails closed below `N = 729` for value | Enforced | Implemented (`MIN_SEAL_N`) (§4.2) |

---

## 5. Cubic-SIG — geometric-vector Schnorr signature

### 5.1 Construction

Cubic-SIG is Schnorr over **secp256k1** (group order `n = SECP256K1_N`, base point
`G`, curve coefficient `a = 0`). Let `H_c` be the challenge hash (§5.2), reducing
into `F_n`. Scalars live mod `n`; points via `ecAdd`/`ecMul` with `a = 0`.

- **`keyGen`:** `sk ← U(F_n)` (32 random bytes mod `n`); `pk = [sk]G`.
- **`sign(m, sk, pk, ctx)`:** require `ctx.coordinates.length ≥ 3` and a non-zero
  plane normal (collinear ⇒ throw; a spatial binding needs a real plane).
  Sample nonce `k ← U(F_n)`, set `R = [k]G`, `e = H_c(R, pk, m, ctx)`,
  `s = k + e·sk (mod n)`. Output `(R, s, e)`.
- **`verify(m, (R,s), pk, ctx):`** recompute `e = H_c(R, pk, m, ctx)`; accept iff
  `[s]G = R + [e]·pk`. `verifyDetail` exposes both points and `e` for proof cards.

### 5.2 EUF-CMA under ECDLP in the ROM

**Claim.** Cubic-SIG is existentially unforgeable under adaptive chosen-message
attack (EUF-CMA), assuming ECDLP is hard on secp256k1 and `H_c` is a random
oracle.

**Argument (standard Schnorr, no novelty in the group).** Cubic-SIG is the
Fiat–Shamir transform of the Schnorr identification protocol on secp256k1. The
context `ctx` and message `m` are inputs to the random oracle `H_c` only; the
group law, keys, `R`, and the verification equation `[s]G = R + [e]pk` are exactly
Schnorr's. Therefore the classical Pointcheval–Stern **forking-lemma** reduction
applies verbatim: a forger producing a valid `(R, s, e)` can be rewound at the
random-oracle query for `e` to yield two accepting transcripts `(R, s, e)`,
`(R, s', e')` with `e ≠ e'`, from which `sk = (s − s')·(e − e')⁻¹ (mod n)` — an
ECDLP solution for `pk`. Concrete security is the standard forking-lemma loss
(quadratic in the number of RO queries). **No property of the cubic geometry is
used in this reduction**, which is exactly why the geometry cannot *weaken* the
base unforgeability: `ctx` is additional domain-separating RO input.

**Two caveats an auditor must weigh:**
1. **Nonce quality is critical and standard.** `k` must be uniform and secret; the
   implementation samples 32 fresh random bytes per signature. Any bias or reuse of
   `k` leaks `sk` (the classic ECDSA/Schnorr nonce failure). Deterministic-nonce
   (RFC 6979-style) hardening is not implemented and is a reasonable audit
   recommendation.
2. **`e` is transmitted but recomputed.** `verify` ignores the transmitted `e` and
   recomputes it from `(R, pk, m, ctx)`, so a forger cannot substitute `e`; the
   serialized `e` is advisory only.

### 5.3 Spatial non-transferability — analysed, NOT proven

`H_c` (`challengeHash`) binds the domain tag `xmbl/xid/cubic-sig/v1`, `R`, `pk`,
the message, **the plane normal `n` of the first three coordinates**, then the raw
coordinates and cube address, reduced mod `n`. Because `n` (and the coordinates)
enter the challenge, a signature valid in one 3-point plane recomputes a *different*
`e` under a different plane and fails verification — the tested "cross-cube replay
rejected" property.

**This is a heuristic domain-separation property, not a reduction.** It says:
*given* EUF-CMA (§5.2), a signature for context `ctx₁` is not a valid signature for
`ctx₂ ≠ ctx₁` because the verifier computes a different challenge — i.e. contexts
are separated, exactly as distinct messages are. It does **not** establish any
hardness *about geometry* (e.g., it is not a claim that binding to a plane adds
cryptographic strength beyond domain separation). The honest statement: **spatial
binding = message/domain binding on the tuple `(normal, coordinates, cubeAddress)`;
its value is non-transferability by construction, and its security is precisely
that of the challenge being collision-resistant over these inputs.** The audit is
asked to confirm there is no context-collision (two meaningfully-different cubes
producing the same `(normal, coords, addr)` digest) that would enable replay.

### 5.4 Quantum status

**Broken by Shor.** secp256k1 ECDLP falls to a quantum adversary; Cubic-SIG is
CLASSICAL-ONLY and is labelled as such in-source. Post-quantum signing is MAYO
(`mayo.wasm`); PQ confidentiality is Cubic-LWE (§4).

---

## 6. Summary of assumptions and open questions for the reviewer

| # | Statement | Type | Status |
|---|-----------|------|--------|
| A1 | Coordinates are public/low-entropy; security must not depend on their secrecy | Assumption | By design (§2.1) |
| A2 | Hashed `(a,b)` are indistinguishable from uniform in `F_p²` (RO model) | Assumption | Conjectured; audit target (§2.2) |
| A3 | Emitted curves are non-singular (`Δ ≠ 0`) | Enforced | Implemented + tested (§2.3) |
| O1 | Derived curves' group order / subgroup / weak-curve screening | **Open** | **NOT implemented; blocks any DL-hardness reliance on derived curves** (§2.4) |
| O2 | Adversarial biasing of input coordinates (grinding) is bounded | Open | Ledger-consensus assumption, not cryptographic (§2.5) |
| S1 | Cubic-SIG EUF-CMA under ECDLP + ROM | Reduction | Standard Schnorr/forking-lemma (§5.2) |
| S2 | Nonce `k` uniform & unique per signature | Assumption | Random sampling; RFC-6979 hardening not implemented (§5.2) |
| S3 | Spatial non-transferability | Heuristic | Domain separation, not a hardness claim (§5.3) |
| Q1 | All secp256k1 primitives broken by Shor | Fact | Classical-only; PQ path is MAYO / Cubic-LWE (§5.4) |

Nothing in this document asserts that the novel constructions are secure. It
states precisely what must be attacked (A2, O1, O2, S3) and what is inherited from
well-studied cryptography (S1). Reliance on any construction here awaits the signed
external report closing the matching ⛔ AUDIT gate in `MAINNET-GATES.md`.
