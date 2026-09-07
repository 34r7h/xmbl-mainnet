// Contract-model tests: contract/state/entrypoint/event/permission/caller + agentic hooks.
import { run } from './lng.js';
function exec(src) { let b = ''; run(src, { write: s => (b += s) }); return b; }
function reverts(src) { try { exec(src); return false; } catch { return true; } }

const LENDER = `
~contract \`Lender {
  ~state { ~public { \`total ~u256 0 } ~private { \`risk ~u256 0 } }
  ~event \`Deposited(\`who ~address, \`amount ~u256)
  ~perm \`deposit ~rules 'consensus_approved'
  ~on \`deposit(\`who ~address, \`amount ~u256) { \`total = \`total + \`amount; ~emit \`Deposited(\`who, \`amount); return \`total }
  ~onsignal(\`sig) { ~p ('sig: ' + \`sig) }
}
\`me ~address '0x1111111111111111111111111111111111111111'
~grant \`me ~rules 'consensus_approved'
\`bank ~deploy \`Lender()
`;

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('ok   ' + name); } else { fail++; console.log('FAIL ' + name); } };
const eqOut = (name, src, want) => { let g; try { g = exec(src); } catch (e) { g = 'ERR:' + e.message; } ok(name + (g === want ? '' : ` (want ${JSON.stringify(want)} got ${JSON.stringify(g)})`), g === want); };

eqOut('entrypoint accumulates state', LENDER + "~p `bank.deposit(`me, 500)\n~p `bank.deposit(`me, 250)", '500\n750\n');
eqOut('public state read', LENDER + "`bank.deposit(`me, 500)\n~p `bank.total", '500\n');
eqOut('private state read', LENDER + "~p `bank.risk", '0\n');
eqOut('instance type name', LENDER + "~p `bank ~is", '~Lender\n');
eqOut('events emitted', LENDER + "`bank.deposit(`me, 1)\n`bank.deposit(`me, 2)\n~p ~events `bank", "('Deposited', 'Deposited')\n");
eqOut('agentic signal hook', LENDER + "~signal `bank 'PAUSE'", 'sig: PAUSE\n');
eqOut('typed param coercion in method', LENDER + "`bank.deposit(`me, '40')\n~p `bank.total ~is", '~u256\n');

ok('unauthorized caller reverts', reverts(`
~contract \`Vault { ~state { ~public { \`b ~u256 0 } } ~perm \`put ~rules 'ok'
  ~on \`put(\`who ~address, \`n ~u256) { \`b = \`b + \`n } }
\`evil ~address '0x2222222222222222222222222222222222222222'
\`v ~deploy \`Vault()
\`v.put(\`evil, 5)`));

ok('authorized caller allowed', !reverts(`
~contract \`Vault { ~state { ~public { \`b ~u256 0 } } ~perm \`put ~rules 'ok'
  ~on \`put(\`who ~address, \`n ~u256) { \`b = \`b + \`n } }
\`good ~address '0x3333333333333333333333333333333333333333'
~grant \`good ~rules 'ok'
\`v ~deploy \`Vault()
\`v.put(\`good, 5)`));

ok('overflow inside method reverts', reverts(`
~contract \`Small { ~state { ~public { \`b ~u8 0 } }
  ~on \`add(\`n ~u256) { \`b = \`b + \`n } }
\`s ~deploy \`Small()
\`s.add(999)`));

eqOut('field default zero', "~contract `C { ~state { ~public { `x ~u256 } } }\n`c ~deploy `C()\n~p `c.x", '0\n');
eqOut('field init expression', "~contract `C { ~state { ~public { `x ~u256 (10 + 5) } } }\n`c ~deploy `C()\n~p `c.x", '15\n');

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
