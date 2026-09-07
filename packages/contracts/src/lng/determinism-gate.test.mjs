// Determinism-gate tests: on-chain code must be a pure function of inputs+state.
// Both backends call assertDeterministic and refuse non-deterministic contracts.
import { checkDeterminism } from './typecheck.js';
import { transpile } from './transpile-evm.js';
import { compile } from './compile-wasm.js';
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('ok   ' + name); } else { fail++; console.log('FAIL ' + name); } };
const nDiag = (src) => checkDeterminism(src).length;
const refused = (fn) => { try { fn(); return false; } catch { return true; } };

// clean contract passes
ok('clean integer contract → 0 diagnostics', nDiag("~contract `Ok { ~state { ~public { `n ~u256 0 } } ~on `add(`a ~u256) { `n = `n + `a; return `n } }") === 0);
ok('~decimal fixed-point is allowed (not a float)', nDiag("~contract `D { ~state { ~public { `r ~decimal 1.05 } } ~on `f() { return 1 } }") === 0);

// violations
ok('float field flagged', nDiag("~contract `B { ~state { ~public { `x ~number 1.5 } } ~on `f() { return `x } }") >= 1);
ok('stray float literal flagged', nDiag("~contract `B { ~on `f(`a ~u256) { return `a + 1.5 } }") >= 1);
ok('on-chain ~p flagged', nDiag("~contract `B { ~on `f() { ~p 1; return 1 } }") >= 1);
ok('impure stdlib (time) flagged', nDiag("~contract `B { ~on `f() { return `time.now() } }") >= 1);
ok('impure stdlib (rand) flagged', nDiag("~contract `B { ~on `f() { return `rand.next() } }") >= 1);
ok('impure in signal hook flagged', nDiag("~contract `B { ~onsignal(`s) { ~p `s } }") >= 1);

// backends actually refuse
ok('EVM transpile refuses float field', refused(() => transpile("~contract `B { ~state { ~public { `x ~number 1.5 } } ~on `f() { return `x } }")));
ok('WASM compile refuses impure stdlib', refused(() => compile("~contract `B { ~on `f() { return `time.now() } }")));
ok('EVM transpile accepts clean contract', !refused(() => transpile("~contract `Ok { ~on `add(`a ~u256, `b ~u256) { return `a + `b } }")));
ok('WASM compile accepts clean contract', !refused(() => compile("~contract `Ok { ~on `add(`a ~u256, `b ~u256) { return `a + `b } }")));

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
