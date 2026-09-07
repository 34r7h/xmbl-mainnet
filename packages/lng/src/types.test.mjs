// Type-layer tests: checked-integer + fixed-point ~decimal runtime, and the static checker.
import { run } from './lng.js';
import { check } from './typecheck.js';
function exec(src) { let b = ''; run(src, { write: s => (b += s) }); return b; }
function reverts(src) { try { exec(src); return false; } catch { return true; } }

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('ok   ' + name); } else { fail++; console.log('FAIL ' + name); } };
const eqOut = (name, src, want) => { let g; try { g = exec(src); } catch (e) { g = 'ERR:' + e.message; } ok(name + (g === want ? '' : ` (want ${JSON.stringify(want)} got ${JSON.stringify(g)})`), g === want); };

// ---- runtime: checked integers ----
eqOut('u256 add', "`a ~u256 100; `b ~u256 55; ~p (`a + `b)", '155\n');
eqOut('u256 add type', "`a ~u256 100; ~p (`a + 1) ~is", '~u256\n');
eqOut('i256 negative', "`a ~i256 5; ~p (`a - 10)", '-5\n');
eqOut('u256 mul', "`a ~u256 12; ~p (`a * 12)", '144\n');
eqOut('int div truncates', "`a ~u256 7; ~p (`a / 2)", '3\n');
ok('u8 overflow reverts', reverts("`a ~u8 200; ~p (`a + 100)"));
ok('u256 underflow reverts', reverts("`a ~u256 0; ~p (`a - 1)"));
ok('div by zero reverts', reverts("`a ~u256 1; ~p (`a / 0)"));
ok('signed/unsigned mix reverts', reverts("`a ~u256 1; `b ~i256 1; ~p (`a + `b)"));

// ---- runtime: fixed-point decimal ----
eqOut('decimal add', "`p ~decimal 1.5; `q ~decimal 0.25; ~p (`p + `q)", '1.75\n');
eqOut('decimal mul', "`p ~decimal 1.5; `q ~decimal 0.25; ~p (`p * `q)", '0.375\n');
eqOut('decimal div', "`p ~decimal 1; `q ~decimal 4; ~p (`p / `q)", '0.25\n');
eqOut('decimal type', "`p ~decimal 2; ~p `p ~is", '~decimal\n');
ok('mix decimal+int reverts', reverts("`d ~decimal 1.5; `i ~u256 2; ~p (`d + `i)"));

// ---- runtime: coercion + other types ----
eqOut('coerce string→u256', "~p ('420' ~is ~u256)", '420\n');
eqOut('coerce type', "~p ('420' ~is ~u256) ~is", '~u256\n');
eqOut('coerce int→decimal', "`a ~u256 3; ~p (`a ~is ~decimal) + 0.5", '3.5\n');
eqOut('address type', "`x ~address '0x1111111111111111111111111111111111111111'; ~p `x ~is", '~address\n');
ok('bad address reverts', reverts("`x ~address '0xnope'"));
eqOut('typed param coerces', "`add(`a ~u256, `b ~u256) {`a + `b}; ~p `add(10, 20)", '30\n');

// ---- static type-checker ----
const nDiag = (src) => check(src).length;
ok('checker: clean typed program → 0', nDiag("`a ~u256 100\n`b ~u256 55\n~p (`a + `b)") === 0);
ok('checker: constant overflow → ≥1', nDiag("`x ~u8 300") >= 1);
ok('checker: fractional into int → ≥1', nDiag("`x ~u256 1.5") >= 1);
ok('checker: mix decimal+int → ≥1', nDiag("`d ~decimal 1.5\n`i ~u256 2\n~p (`d + `i)") >= 1);
ok('checker: bitwise on decimal → ≥1', nDiag("`d ~decimal 1.5\n~p (`d b& 2)") >= 1);
ok('checker: float in int arithmetic → ≥1', nDiag("`a ~u256 10\n~p (`a + 1.5)") >= 1);
ok('checker: core examples clean', nDiag("`add(`a, `b) {`a + `b}\n~p `add(10, 20)") === 0);

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
