// Milestone-1 conformance tests for the LNG interpreter.
// Runs each program in-process and asserts exact stdout.
import { run } from './lng.js';
function exec(src) {
  let buf = '';
  run(src, { write: s => (buf += s) });
  return buf;
}

const cases = [
  ['hello',   "~p 'Hello, World!'", 'Hello, World!\n'],
  ['sum',     "`a (1,2,3,4,5)\n`s 0\n`a ~for ~as `x { `s = `s + `x }\n~p `s", '15\n'],
  ['arith',   "~p (10 + 20)\n~p (10 * 20)", '30\n200\n'],
  ['compare', "~p (10 < 20)\n~p (10 !> 20)\n~p (10 !< 20)\n~p (10 == 10)\n~p (10 !== 3)",
              '~t\n~t\n~f\n~t\n~t\n'],
  ['logic',   "~p ~t & ~f\n~p ~t | ~f\n~p !~t", '~f\n~t\n~f\n'],
  ['bitwise', "~p (12 b& 25)\n~p (12 b| 25)", '8\n29\n'],
  ['strcat',  "~p ('Hello, ' + 'World')", 'Hello, World\n'],
  ['object',  "`o (`name 'Alice', `age 21)\n~p `o.name\n~p `o.{'n' + 'ame'}", 'Alice\nAlice\n'],
  ['array-idx',"`a (10, 20, 30)\n~p `a.1\n~p `a.0", '20\n10\n'],
  ['fn',      "`add(`a, `b) {`a + `b}\n~p `add(10, 20)", '30\n'],
  ['overload',"`f(`a) {`a}\n`f(`a, `b) {`a + `b}\n~p `f(7)\n~p `f(7, 8)", '7\n15\n'],
  ['fn-class',"`pt(`x, `y) {(`x `x, `y `y)}\n`p `pt(3, 4)\n~p `p.x\n~p `p.y", '3\n4\n'],
  ['ternary', "`v 10\n`v == 10 ? {~p 'ten'} | {~p 'no'}", 'ten\n'],
  ['ternary-chain', "`g 72\n`g !< 90 ? {~p 'A'} | `g !< 70 ? {~p 'B'} | {~p 'C'}", 'B\n'],
  ['counted-for', "`f(`n) {`r 1\n~for `i 2 `n { `r = `r * `i }\nreturn `r}\n~p `f(5)", '120\n'],
  ['auto-pass', "`a (1, 2, 3)\n`a ~for {~p}", '1\n2\n3\n'],
  ['typeof',  "~p '420' ~is\n`n 5\n~p `n ~is\n~p ~t ~is", '~string\n~number\n~boolean\n'],
  ['coerce',  "~p ('420' ~is ~number) + 1", '421\n'],
  ['exit',    "~p 'a'\n~exit\n~p 'b'", 'a\n'],
];

let pass = 0, fail = 0;
for (const [name, src, want] of cases) {
  let got;
  try { got = exec(src); }
  catch (e) { got = 'ERROR: ' + e.message + '\n'; }
  if (got === want) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name}\n  want: ${JSON.stringify(want)}\n  got:  ${JSON.stringify(got)}`); }
}
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
