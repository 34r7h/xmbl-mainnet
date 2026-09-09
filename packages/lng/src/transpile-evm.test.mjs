// EVM backend tests: LNG → Solidity transpiler (decision 1, source-level).
// Structural assertions on the emitted Solidity; plus an actual solcjs compile when available.
import { transpile } from './transpile-evm.js';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('ok   ' + name); } else { fail++; console.log('FAIL ' + name); } };
const has = (name, sol, sub) => ok(name + (sol.includes(sub) ? '' : ` (missing: ${sub})`), sol.includes(sub));

const LENDER = `
~contract \`Lender {
  ~state { ~public { \`total ~u256 0 } ~private { \`risk ~u256 0 } }
  ~event \`Deposited(\`who ~address, \`amount ~u256)
  ~perm \`deposit ~rules 'consensus_approved'
  ~on \`deposit(\`who ~address, \`amount ~u256) { \`total = \`total + \`amount; ~emit \`Deposited(\`who, \`amount); return \`total }
}`;
const sol = transpile(LENDER);
has('pragma emitted', sol, 'pragma solidity');
has('contract name', sol, 'contract Lender {');
has('public uint256 state + init', sol, 'uint256 public total = 0;');
has('private state', sol, 'uint256 private risk = 0;');
has('event', sol, 'event Deposited(address who, uint256 amount);');
has('function signature + returns', sol, 'function deposit(address who, uint256 amount) public returns (uint256) {');
has('permission require', sol, 'require(_mods[who][keccak256(abi.encodePacked("rules", ":", "consensus_approved"))], "unauthorized: deposit");');
has('assignment lowered', sol, 'total = total + amount;');
has('emit lowered', sol, 'emit Deposited(who, amount);');
has('return lowered', sol, 'return total;');

const VAULT = `
~contract \`Vault {
  ~state { ~public { \`rate ~decimal 1.05  \`count ~u256 0 } }
  ~on \`withdraw(\`amount ~u256) { \`amount !> 100 ? {\`count = \`count + 1} | {\`count = \`count + 2} }
  ~on \`sum(\`n ~u256) { \`acc ~u256 0; ~for \`i 1 \`n { \`acc = \`acc + \`i }; return \`acc }
}`;
const v = transpile(VAULT);
has('decimal literal scaled 1e18', v, 'rate = 1050000000000000000;');
has('ternary → if/else', v, 'if (amount <= 100) {');
has('ternary else branch', v, '} else {');
has('counted for → for loop', v, 'for (uint256 i = 1; i <= n; i++) {');
has('typed local', v, 'uint256 acc = 0;');

// Comparison-operator mapping
const OPS = transpile("~contract `C { ~on `f(`a ~u256, `b ~u256) { return `a !== `b ? 1 | 0 } }");
has('!== → !=', OPS, 'a != b');

// Overload → selector mangling: same-named methods become name__<arity>
const OV = transpile("~contract `Calc { ~on `apply(`a ~u256) { return `a } ~on `apply(`a ~u256, `b ~u256) { return `a + `b } }");
has('overload mangling: apply__1', OV, 'function apply__1(uint256 a)');
has('overload mangling: apply__2', OV, 'function apply__2(uint256 a, uint256 b)');
ok('non-overloaded name is NOT mangled', !transpile("~contract `C { ~on `once(`a ~u256) { return `a } }").includes('once__'));

// `~e` (revert) must become Solidity revert(...), never a silently-dropped comment — otherwise a
// guarded LNG contract transpiles to one that does NOT revert where the LNG did.
{
  const sol = transpile("~contract `G { ~state{~public{`v ~u256 0}} ~on `s(`x ~u256){ !(`x !> 100) ? { ~e 'too big' } `v = `x } }");
  has('`~e transpiles to revert("msg")', sol, 'revert("too big")');
  ok('`~e is NOT dropped to a comment', !sol.includes('unsupported statement'));
}

// Real compile with solcjs when present.
let solc = null;
try { execSync('which solcjs', { stdio: 'ignore' }); solc = 'solcjs'; } catch { }
if (solc) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lngsol-'));
  let compiled = 0;
  for (const [name, src] of [['Lender', LENDER], ['Vault', VAULT]]) {
    const f = path.join(dir, name + '.sol');
    fs.writeFileSync(f, transpile(src));
    try { execSync(`${solc} --bin --base-path ${dir} -o ${dir} ${f}`, { stdio: 'ignore' }); if (fs.readdirSync(dir).some(x => x.startsWith(name) && x.endsWith('.bin'))) compiled++; } catch { }
  }
  ok('solcjs compiles Lender + Vault to bytecode', compiled === 2);
} else {
  console.log('skip solcjs compile (solcjs not installed)');
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
