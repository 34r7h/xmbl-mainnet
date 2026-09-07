/*
 * LNG → Solidity transpiler (EVM backend, decision 1: source-level first).
 *
 * Lowers LNG `~contract` blocks to Solidity source that `solc` compiles — the
 * "stay EVM/Solidity compatible" guarantee. The XMBL-native pieces that have no EVM
 * equivalent (cube coordinates, Cubic-SIG/MAYO/LWE, coordinator signals) are XCL-only
 * and are NOT emitted here; the caller (the LNG `who`/caller parameter) maps to the
 * mod-grant model, which on a live deployment is keyed by msg.sender.
 *
 * API:    import { transpile } from '@xmbl/lng';  // transpile(src) -> Solidity string
 */
import { lex, parse, INT_WIDTHS } from './lng.js';
import { assertDeterministic } from './typecheck.js';
function solType(t) {
  if (!t) return 'uint256';
  if (t in INT_WIDTHS) { const [s, b] = INT_WIDTHS[t]; return (s ? 'int' : 'uint') + b; }
  switch (t) {
    case 'bool': case 'boolean': return 'bool';
    case 'address': return 'address';
    case 'bytes': return 'bytes';
    case 'string': return 'string';
    case 'decimal': return 'uint256'; // fixed-point 1e18, represented as uint256
    case 'map': return 'mapping(address => uint256)';
    case 'number': return 'uint256';
    default: return 'uint256';
  }
}
const needsMemory = (t) => t === 'string' || t === 'bytes';
const OP = { '!==': '!=', '!>': '<=', '!<': '>=', '&': '&&', '|': '||', 'b&': '&', 'b|': '|', 'b^': '^', 'b<': '<<', 'b>': '>>' };

function transpile(src) {
  assertDeterministic(src, 'EVM transpile');
  const ast = parse(lex(src));
  const contracts = ast.body.filter(n => n.kind === 'contract');
  if (!contracts.length) throw new Error('no ~contract found to transpile');
  const out = ['// SPDX-License-Identifier: MIT', 'pragma solidity ^0.8.20;', ''];
  for (const c of contracts) out.push(emitContract(c));
  return out.join('\n');
}

function emitContract(c) {
  const types = {};                       // name → lng type (fields + current method params)
  for (const f of c.fields) types[f.name] = f.type;
  const L = [`contract ${c.name} {`];

  // state
  for (const f of c.fields) {
    const vis = f.vis === 'public' ? ' public' : ' private';
    const st = solType(f.type);
    if (f.type === 'map') L.push(`    ${st}${vis} ${f.name};`);
    else if (f.init != null && isLiteral(f.init)) L.push(`    ${st}${vis} ${f.name} = ${f.type === 'decimal' && f.init.kind === 'num' ? decLit(f.init.value) : emitExpr(f.init, types)};`);
    else L.push(`    ${st}${vis} ${f.name};`);
  }
  // events
  for (const ev of c.events) L.push(`    event ${ev.name}(${ev.params.map(p => solType(p.type) + ' ' + p.name).join(', ')});`);
  // mod-grant model (only if the contract gates anything)
  if (c.perms.length) {
    L.push('    mapping(address => mapping(bytes32 => bool)) private _mods;');
    L.push('    function grantMod(address who, string memory kind, string memory payload) public {');
    L.push('        _mods[who][keccak256(abi.encodePacked(kind, ":", payload))] = true;');
    L.push('    }');
  }
  // Overload-selector mangling: LNG dispatches overloads by arity, but the EVM ABI keys
  // functions by their selector (keccak of name+types) and rejects two with the same
  // signature. Any method name used more than once is mangled to `name__<arity>` so each
  // overload gets a distinct, unambiguous external selector; unique names are left alone.
  const nameCount = {};
  for (const m of c.methods) nameCount[m.name] = (nameCount[m.name] || 0) + 1;
  const solName = (m) => nameCount[m.name] > 1 ? `${m.name}__${m.params.length}` : m.name;

  // methods
  for (const m of c.methods) L.push(emitMethod(c, m, types, solName(m)));
  L.push('}');
  return L.join('\n');
}

function emitMethod(c, m, outerTypes, name) {
  name = name || m.name;
  const types = Object.assign({}, outerTypes);
  for (const p of m.params) types[p.name] = p.type;
  const params = m.params.map(p => solType(p.type) + (needsMemory(p.type) ? ' memory' : '') + ' ' + p.name).join(', ');
  const ret = inferReturn(m, types);
  const sig = `    function ${name}(${params}) public${ret ? ` returns (${ret})` : ''} {`;
  const body = [];
  // permission gates → require against the caller (first param), mapped to _mods
  for (const perm of c.perms.filter(p => p.method === m.name)) {
    const caller = m.params[0] ? m.params[0].name : 'msg.sender';
    const payload = perm.payload && perm.payload.kind === 'str' ? perm.payload.value : '';
    body.push(`        require(_mods[${caller}][keccak256(abi.encodePacked("${perm.kind}", ":", "${payload}"))], "unauthorized: ${name}");`);
  }
  for (const s of m.body.body) body.push(emitStmt(s, types, 2));
  return sig + '\n' + body.join('\n') + '\n    }';
}

function inferReturn(m, types) {
  let t = null, has = false;
  const ret = (s) => s.kind === 'return' ? s : (s.kind === 'exprstmt' && s.expr && s.expr.kind === 'return' ? s.expr : null);
  const scan = (nodes) => { for (const s of nodes) { const r = ret(s); if (r) { has = true; if (r.value) t = t || typeOf(r.value, types); } if (s.kind === 'block') scan(s.body); if (s.kind === 'countedfor' && s.body) scan(s.body.body); } };
  scan(m.body.body);
  return t ? solType(t) : (has ? 'uint256' : '');
}
// A ~decimal literal → its 1e18-scaled integer (Solidity has no fixed-point type).
function decLit(v) {
  const s = String(v); const neg = s[0] === '-'; const t = neg ? s.slice(1) : s;
  const [ip = '0', fp = ''] = t.split('.'); const frac = (fp + '0'.repeat(18)).slice(0, 18);
  return (neg ? '-' : '') + (BigInt(ip) * (10n ** 18n) + BigInt(frac || '0')).toString();
}
function typeOf(n, types) {
  if (!n) return null;
  if (n.kind === 'ref') return types[n.name] || null;
  if (n.kind === 'is' && n.typeArg) return n.typeArg;
  if (n.kind === 'num') return 'u256';
  if (n.kind === 'group') return typeOf(n.expr, types);
  if (n.kind === 'binary') return typeOf(n.left, types) || typeOf(n.right, types) || 'u256';
  if (n.kind === 'member') return null;
  return null;
}

const pad = (d) => '    '.repeat(d);
function emitStmt(n, types, d) {
  switch (n.kind) {
    case 'assign': {
      if (n.declType) { types[n.name] = n.declType; const rhs = n.declType === 'decimal' && n.value.kind === 'num' ? decLit(n.value.value) : emitExpr(n.value, types); return `${pad(d)}${solType(n.declType)}${needsMemory(n.declType) ? ' memory' : ''} ${n.name} = ${rhs};`; }
      return `${pad(d)}${n.name} = ${emitExpr(n.value, types)};`;
    }
    case 'return': return `${pad(d)}return ${emitExpr(n.value, types)};`;
    case 'exprstmt': {
      const e = n.expr;
      if (e.kind === 'return') return `${pad(d)}return ${e.value ? emitExpr(e.value, types) : ''};`;
      if (e.kind === 'ternary') return emitIfElse(e, types, d);
      if (e.kind === 'emit') return `${pad(d)}emit ${e.name}(${e.args.map(a => emitExpr(a, types)).join(', ')});`;
      if (e.kind === 'print') return `${pad(d)}// ~p (no on-chain stdout): ${e.arg ? emitExpr(e.arg, types) : ''}`;
      return `${pad(d)}${emitExpr(e, types)};`;
    }
    case 'countedfor': return `${pad(d)}for (uint256 ${n.varName} = ${emitExpr(n.start, types)}; ${n.varName} <= ${emitExpr(n.end, types)}; ${n.varName}++) {\n${n.body.body.map(s => emitStmt(s, types, d + 1)).join('\n')}\n${pad(d)}}`;
    case 'block': return n.body.map(s => emitStmt(s, types, d)).join('\n');
    default: return `${pad(d)}// unsupported statement: ${n.kind}`;
  }
}
const blockBody = (n) => (n.kind === 'block' || n.kind === 'anonfn') ? (n.body.body || n.body) : null;
function branchStmts(n, types, d) {
  const b = blockBody(n);
  if (b) return b.map(s => emitStmt(s, types, d + 1)).join('\n');
  return `${pad(d + 1)}${emitExpr(n, types)};`;
}
function emitIfElse(t, types, d) {
  let s = `${pad(d)}if (${emitExpr(t.cond, types)}) {\n${branchStmts(t.thenB, types, d)}\n${pad(d)}}`;
  if (t.elseB) {
    if (t.elseB.kind === 'ternary') s += ` else ${emitIfElse(t.elseB, types, d).trimStart()}`;
    else s += ` else {\n${branchStmts(t.elseB, types, d)}\n${pad(d)}}`;
  }
  return s;
}
function isLiteral(n) { return n && (n.kind === 'num' || n.kind === 'str' || n.kind === 'bool'); }
function emitExpr(n, types) {
  if (!n) return '';
  switch (n.kind) {
    case 'num': return String(n.value);
    case 'str': return JSON.stringify(n.value);
    case 'bool': return n.value ? 'true' : 'false';
    case 'null': return '0';
    case 'ref': return n.name;
    case 'group': return '(' + emitExpr(n.expr, types) + ')';
    case 'member': return emitExpr(n.obj, types) + '.' + n.name;
    case 'index': return emitExpr(n.obj, types) + '[' + emitExpr(n.index, types) + ']';
    case 'unary': return (n.op === 'b~' ? '~' : n.op) + emitExpr(n.operand, types);
    case 'binary': return emitExpr(n.left, types) + ' ' + (OP[n.op] || n.op) + ' ' + emitExpr(n.right, types);
    case 'ternary': return emitExpr(n.cond, types) + ' ? ' + emitExpr(n.thenB, types) + ' : ' + (n.elseB ? emitExpr(n.elseB, types) : '0');
    case 'is': if (n.typeArg) return solType(n.typeArg) + '(' + emitExpr(n.value, types) + ')'; throw new Error('~is type-introspection has no EVM equivalent');
    case 'call': return emitExpr(n.callee, types) + '(' + n.args.map(a => emitExpr(a, types)).join(', ') + ')';
    default: throw new Error('cannot transpile expression: ' + n.kind);
  }
}

export { transpile };