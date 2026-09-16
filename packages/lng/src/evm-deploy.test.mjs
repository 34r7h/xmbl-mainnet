// The EVM backend's output is DEPLOYED and EXECUTED — in-process, on every run, in the hard gate.
//
// Before this suite the Solidity the transpiler emits was only structurally asserted (and compiled when a
// `solcjs` happened to be on PATH — a check that cannot fail in CI is not a gate). Here the SAME LNG source
// goes down all three roads and must compute the SAME answers:
//   interpreter  — the reference tree-walker (`run`);
//   WASM         — `compile` → WebAssembly.instantiate, no imports (the XCL mainnet-safe default);
//   EVM          — `transpile` → solc (in-process solcjs, pinned dev dependency) → bytecode DEPLOYED into an
//                  in-process EVM (@ethereumjs/evm, the JS reference EVM) → called through the real ABI.
// A revert must be a revert on all three: the interpreter throws, the WASM traps, the EVM returns a REVERT
// with the reason string. Nothing here reaches a public chain: that is a product step, not a readiness one;
// what this closes is "not deployed" — the emitted Solidity is a contract that runs, not a document.
import solc from 'solc';
import { createEVM } from '@ethereumjs/evm';
import { createAddressFromString, hexToBytes, bytesToHex } from '@ethereumjs/util';
import { run, compile, transpile } from '../index.js';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('ok   ' + name); } else { fail++; console.log('FAIL ' + name); } };

const COUNTER = `~contract \`Counter {
  ~state { ~public { \`count ~u256 0 } }
  ~event \`Bumped()
  ~on \`inc(\`n ~u256) { \`count = \`count + \`n; ~emit \`Bumped(); return \`count }
  ~on \`sumTo(\`n ~u256) { \`acc ~u256 0; ~for \`i 1 \`n { \`acc = \`acc + \`i }; return \`acc }
  ~on \`classify(\`x ~u256) { return \`x !> 10 ? 1 | 2 }
}`;
const GUARD = `~contract \`Guard {
  ~state { ~public { \`v ~u256 0 } }
  ~on \`set(\`x ~u256) { !(\`x !> 100) ? { ~e 'too big' } \`v = \`x; return \`v }
}`;
const VAULT = `~contract \`Vault {
  ~state { ~public { \`rate ~decimal 1.05  \`count ~u256 0 } }
  ~on \`withdraw(\`amount ~u256) { \`amount !> 100 ? {\`count = \`count + 1} | {\`count = \`count + 2}; return \`count }
}`;

// ── solc: LNG → Solidity → bytecode + selectors, in-process, always ──
function compileSol(name, lngSrc) {
  const sol = transpile(lngSrc);
  const input = { language: 'Solidity', sources: { [name + '.sol']: { content: sol } },
    settings: { optimizer: { enabled: false }, outputSelection: { '*': { '*': ['evm.bytecode.object', 'evm.methodIdentifiers'] } } } };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors || []).filter((e) => e.severity === 'error').map((e) => e.formattedMessage);
  if (errors.length) throw new Error(`solc: ${errors.join('\n')}`);
  const c = out.contracts[name + '.sol'][name];
  return { sol, bytecode: c.evm.bytecode.object, selectors: c.evm.methodIdentifiers };
}

// ── EVM: deploy the bytecode, call it through the ABI ──
const CALLER = createAddressFromString('0x1111111111111111111111111111111111111111');
const GAS = 30_000_000n;
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
async function deploy(evm, bytecode) {
  const r = await evm.runCall({ caller: CALLER, data: hexToBytes('0x' + bytecode), gasLimit: GAS });
  if (r.execResult.exceptionError) throw new Error('deploy failed: ' + r.execResult.exceptionError.error);
  return r.createdAddress;
}
async function call(evm, to, selectors, sig, ...args) {
  const data = hexToBytes('0x' + selectors[sig] + args.map(word).join(''));
  const r = await evm.runCall({ caller: CALLER, to, data, gasLimit: GAS });
  const err = r.execResult.exceptionError;
  if (err) {
    // Error(string) — selector 0x08c379a0, then abi-encoded string: offset, length, bytes
    const ret = bytesToHex(r.execResult.returnValue);
    let reason = null;
    if (ret.startsWith('0x08c379a0')) { const len = Number(BigInt('0x' + ret.slice(2 + 8 + 64, 2 + 8 + 128))); reason = Buffer.from(ret.slice(2 + 8 + 128, 2 + 8 + 128 + len * 2), 'hex').toString('utf8'); }
    return { reverted: true, error: err.error, reason, gas: r.execResult.executionGasUsed };
  }
  return { reverted: false, value: BigInt(bytesToHex(r.execResult.returnValue)), gas: r.execResult.executionGasUsed };
}

// ── WASM: the XCL harness (as compile-wasm.test.mjs) ──
const MASK = (1n << 256n) - 1n;
function wasmHarness(src) {
  const bytes = compile(src);
  const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), {});
  const mem = new DataView(inst.exports.memory.buffer);
  const rd = (p) => { let v = 0n; for (let i = 0; i < 4; i++) v |= mem.getBigUint64(p + i * 8, true) << BigInt(i * 64); return v; };
  const wr = (p, v) => { v &= MASK; for (let i = 0; i < 4; i++) mem.setBigUint64(p + i * 8, (v >> BigInt(i * 64)) & ((1n << 64n) - 1n), true); };
  const callW = (name, ...args) => { const ps = args.map((a) => { const p = inst.exports.__alloc(); wr(p, BigInt(a)); return p; }); return rd(inst.exports[name](...ps)); };
  const traps = (name, ...args) => { try { callW(name, ...args); return false; } catch { return true; } };
  return { call: callW, traps };
}

// ── interpreter ──
function interp(src, script) { let out = ''; run(src + '\n' + script, { write: (s) => (out += s) }); return out.trim().split('\n').map((x) => BigInt(x)); }

// ═══ 1. the transpiler's Solidity COMPILES — always, in-process (no PATH lottery) ═══
let counter, guard, vault;
try { counter = compileSol('Counter', COUNTER); ok(`Counter transpiles and solc ${solc.version().split('+')[0]} compiles it (${counter.bytecode.length / 2} bytes)`, counter.bytecode.length > 0); }
catch (e) { ok('Counter compiles (' + e.message + ')', false); }
try { guard = compileSol('Guard', GUARD); ok('Guard (revert guard) compiles', guard.bytecode.length > 0); } catch (e) { ok('Guard compiles (' + e.message + ')', false); }
try { vault = compileSol('Vault', VAULT); ok('Vault (~decimal state + ternary) compiles', vault.bytecode.length > 0); } catch (e) { ok('Vault compiles (' + e.message + ')', false); }
ok('selectors are the real ABI (inc(uint256), sumTo(uint256), classify(uint256))', !!(counter && counter.selectors['inc(uint256)'] && counter.selectors['sumTo(uint256)'] && counter.selectors['classify(uint256)']));

// ═══ 2. DEPLOYED and EXECUTED in an EVM; the SAME answers as the interpreter and the WASM ═══
const evm = await createEVM();
if (counter) {
  const addr = await deploy(evm, counter.bytecode);
  ok('Counter deploys (created address ' + addr.toString().slice(0, 10) + '…)', addr !== undefined);
  const S = counter.selectors;
  const e = [];
  for (const [sig, a] of [['inc(uint256)', 5n], ['inc(uint256)', 3n], ['sumTo(uint256)', 10n], ['classify(uint256)', 4n], ['classify(uint256)', 20n]]) {
    const r = await call(evm, addr, S, sig, a); e.push(r.reverted ? -1n : r.value);
  }
  ok('EVM: inc(5)=5, inc(3)=8 (storage persists), sumTo(10)=55, classify(4)=1, classify(20)=2 → ' + e.join(','), e.join(',') === '5,8,55,1,2');
  const W = wasmHarness(COUNTER);
  const w = [W.call('inc', 5n), W.call('inc', 3n), W.call('sumTo', 10n), W.call('classify', 4n), W.call('classify', 20n)];
  const i = interp(COUNTER, "`c ~deploy `Counter()\n~p `c.inc(5)\n~p `c.inc(3)\n~p `c.sumTo(10)\n~p `c.classify(4)\n~p `c.classify(20)");
  ok('three-way parity: interpreter == WASM == EVM for the same 5 calls', i.join(',') === w.join(',') && w.join(',') === e.join(','));
  const big = await call(evm, addr, S, 'inc(uint256)', (1n << 200n));
  ok('EVM carries the full 256-bit width: inc(2^200) → 2^200 + 8', !big.reverted && big.value === (1n << 200n) + 8n);
  const ov = await call(evm, addr, S, 'inc(uint256)', MASK);
  ok('EVM overflow reverts (solidity ^0.8 checked arithmetic), as WASM traps and the interpreter reverts', ov.reverted && W.traps('inc', MASK));
}

// ═══ 3. a revert is a revert everywhere ═══
if (guard) {
  const addr = await deploy(evm, guard.bytecode);
  const S = guard.selectors;
  const okSet = await call(evm, addr, S, 'set(uint256)', 42n);
  const bad = await call(evm, addr, S, 'set(uint256)', 101n);
  ok('EVM: set(42) → 42', !okSet.reverted && okSet.value === 42n);
  ok('EVM: set(101) REVERTS with the LNG reason ("too big")', bad.reverted && bad.error === 'revert' && bad.reason === 'too big');
  const W = wasmHarness(GUARD);
  ok('WASM: set(42) → 42, set(101) traps', W.call('set', 42n) === 42n && W.traps('set', 101n));
  let threw = null; try { run(GUARD + "\n`g ~deploy `Guard()\n`g.set(101)", { write() {} }); } catch (err) { threw = err.message; }
  ok('interpreter: set(101) reverts with the same reason', threw !== null && /too big/.test(threw));
  const after = await call(evm, addr, S, 'set(uint256)', 7n);
  ok('EVM state after the revert is intact: set(7) → 7', !after.reverted && after.value === 7n);
}

// ═══ 4. ~decimal state lands as fixed-point 1e18 on the EVM ═══
if (vault) {
  const addr = await deploy(evm, vault.bytecode);
  const S = vault.selectors;
  const r = await call(evm, addr, S, 'rate()');
  ok('EVM: rate() == 1.05e18 (fixed-point, no floats on-chain)', !r.reverted && r.value === 1_050_000_000_000_000_000n);
  const w1 = await call(evm, addr, S, 'withdraw(uint256)', 50n), w2 = await call(evm, addr, S, 'withdraw(uint256)', 500n);
  ok('EVM: withdraw(50) → count 1, withdraw(500) → count 3 (ternary → if/else)', w1.value === 1n && w2.value === 3n);
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
