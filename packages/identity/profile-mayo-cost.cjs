// WHERE DOES MAYO SPEND ITS TIME? — the measurement MAINNET-CLOSEOUT B9 is specified against.
//
// B9 says MAYO's cost "sits in expanding the public matrices from the key seed". That is an assertion
// until somebody times it, and the whole design question (which step do cube coordinates enter, and what
// does that save) is decided by the answer. So this times mayo_expand_pk / mayo_expand_sk against the full
// NIST-API verify and sign — in WASM under node, the runtime that actually runs them on a node.
//
// It needs an INSTRUMENTED build, because the shipped artifact exports only the five NIST entry points.
// profile-mayo-cost.sh produces one in a temp directory from the SAME sources, defines and includes as
// build-mayo-cube-wasm.sh, plus the two expand_* exports. The committed artifact is never touched.
//
// Usage:  ./profile-mayo-cost.sh          (builds, then runs this)
//         node profile-mayo-cost.cjs <path/to/prof.cjs> [iterations]
const path = process.argv[2];
if (!path) { console.error('usage: node profile-mayo-cost.cjs <path/to/prof.cjs> [iterations]'); process.exit(2); }
const N = Math.max(1, Number(process.argv[3] || 300));

// MAYO_1 sizes (include/mayo.h) — the parameter set this artifact is compiled for.
const CPK = 1420, CSK = 24, SIG = 454, P1 = 120159, P2 = 24336, P3 = 1404, SEED = 16;

(async () => {
  const M = await require(path)();
  const fn = (name, args) => M.cwrap(`pqmayo_MAYO_1_opt_${name}`, 'number', args);
  const keypair = fn('crypto_sign_keypair', ['number', 'number']);
  const sign = fn('crypto_sign_signature', ['number', 'number', 'number', 'number', 'number']);
  const verify = fn('crypto_sign_verify', ['number', 'number', 'number', 'number', 'number']);
  const expandPk = fn('mayo_expand_pk', ['number', 'number', 'number']);
  const expandSk = fn('mayo_expand_sk', ['number', 'number', 'number']);

  const cpk = M._malloc(CPK), csk = M._malloc(CSK), sig = M._malloc(SIG), siglen = M._malloc(8), msg = M._malloc(64);
  const epk = M._malloc(P1 + P2 + P3 + 4096), esk = M._malloc(P1 + P2 + 4096);
  for (let i = 0; i < 64; i++) M.HEAPU8[msg + i] = i;
  if (keypair(cpk, csk) !== 0) throw new Error('keypair failed');
  if (sign(sig, siglen, msg, 64, csk) !== 0) throw new Error('sign failed');
  if (verify(sig, SIG, msg, 64, cpk) !== 0) throw new Error('verify failed — the instrumented build is not equivalent');

  const time = (n, f) => { const t = process.hrtime.bigint(); for (let i = 0; i < n; i++) f(); return Number(process.hrtime.bigint() - t) / 1e6 / n; };
  for (let i = 0; i < 20; i++) { expandPk(0, cpk, epk); verify(sig, SIG, msg, 64, cpk); }   // warm
  const tExpandPk = time(N, () => expandPk(0, cpk, epk));
  const tExpandSk = time(N, () => expandSk(0, csk, esk));
  const tVerify = time(N, () => verify(sig, SIG, msg, 64, cpk));
  const tSign = time(N, () => sign(sig, siglen, msg, 64, csk));
  const tKeypair = time(Math.max(10, N / 10), () => keypair(cpk, csk));

  const f = (x) => x.toFixed(3).padStart(8);
  console.log(`MAYO_1 opt — WASM under node ${process.version}, ${N} iterations, ms/op\n`);
  console.log(`  expand_pk        ${f(tExpandPk)}`);
  console.log(`  expand_sk        ${f(tExpandSk)}`);
  console.log(`  verify  (total)  ${f(tVerify)}`);
  console.log(`  sign    (total)  ${f(tSign)}`);
  console.log(`  keypair          ${f(tKeypair)}`);
  console.log(`\n  expand_pk / verify = ${(100 * tExpandPk / tVerify).toFixed(1)}%   → the rest of verify is ${f(tVerify - tExpandPk)} ms`);
  console.log(`  expand_sk / sign   = ${(100 * tExpandSk / tSign).toFixed(1)}%   → the rest of sign   is ${f(tSign - tExpandSk)} ms`);
  console.log(`\n  P1+P2 = ${P1 + P2} bytes expanded from a ${SEED}-byte seed on EVERY verify (cpk ${CPK} B, sig ${SIG} B).`);
  console.log(`  A verify that received an ALREADY-expanded key would cost ${f(tVerify - tExpandPk)} ms — ${(tVerify / (tVerify - tExpandPk)).toFixed(1)}× less,`);
  console.log(`  at ${((P1 + P2 + P3) / 1024).toFixed(0)} KiB of cache per signer. That is a call-pattern question, not a cryptographic one.`);
})();
