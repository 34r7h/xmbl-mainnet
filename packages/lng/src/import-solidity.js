/*
 * Solidity → LNG importer (the reverse of transpile-evm.js).
 *
 * transpile-evm.js lowers LNG to Solidity; this lifts a Solidity contract BACK to LNG source,
 * so an existing EVM contract can be brought onto XMBL as a native cube-placed contract. The
 * two directions round-trip on the subset LNG represents:
 *
 *     LNG --transpile--> Solidity --importSolidity--> LNG   (same behavior)
 *     Solidity --importSolidity--> LNG --compile--> WASM     (runs on XMBL)
 *
 * Supported (the LNG-representable subset — what the EVM backend emits, plus common hand-written
 * Solidity in that shape): a `contract` with typed state vars (public/private, optional init),
 * `event` declarations, and `function`s whose bodies use local declarations, assignment,
 * `if/else`, a canonical counted `for`, `return`, `emit`, `require(cond[, "msg"])`, and integer/
 * comparison/logical/bitwise expressions. Types map uintN↔uN, intN↔iN, bool/address/bytes/string,
 * and `mapping(address=>uint256)`↔`map`.
 *
 * NOT supported (raised as an explicit error, never silently mistranslated): inheritance,
 * modifiers, structs, inline assembly, low-level calls, storage pointers, and any type with no
 * LNG equivalent. An importer that quietly dropped these would be the theatrical kind — this one
 * refuses them by name so the failure is visible.
 *
 * API:  import { importSolidity } from '@xmbl/lng';  // importSolidity(solSource) -> lngSource
 */

// Solidity token → LNG operator (inverse of transpile-evm's OP table).
const BIN = {
  '!=': '!==', '<=': '!>', '>=': '!<', '&&': '&', '||': '|',
  '&': 'b&', '|': 'b|', '^': 'b^', '<<': 'b<', '>>': 'b>',
  '==': '==', '>': '>', '<': '<', '+': '+', '-': '-', '*': '*', '/': '/', '%': '%',
};
// Precedence for the Solidity operators we accept (higher binds tighter). Mirrors Solidity.
const PREC = {
  '||': 2, '&&': 3, '|': 4, '^': 5, '&': 6,
  '==': 7, '!=': 7, '<': 8, '>': 8, '<=': 8, '>=': 8,
  '<<': 9, '>>': 9, '+': 10, '-': 10, '*': 11, '/': 11, '%': 11,
};

function solTypeToLng(t) {
  const s = t.replace(/\s+/g, '');
  if (/^uint\d*$/.test(s)) return s === 'uint' ? 'u256' : 'u' + s.slice(4);
  if (/^int\d*$/.test(s)) return s === 'int' ? 'i256' : 'i' + s.slice(3);
  if (s === 'bool') return 'bool';
  if (s === 'address' || s === 'addresspayable') return 'address';
  if (/^bytes\d*$/.test(s)) return 'bytes';
  if (s === 'string') return 'string';
  if (/^mapping\(/.test(s)) return 'map';
  throw new Error(`import: no LNG type for Solidity type '${t}'`);
}
const INT_TYPE = (lng) => /^[ui]\d+$/.test(lng);

// ---------------- tokenizer ----------------
function lex(src) {
  const toks = [];
  let i = 0, line = 1;
  const two = ['==', '!=', '<=', '>=', '&&', '||', '<<', '>>', '=>', '++', '--'];
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '"' || c === "'") { const q = c; i++; let s = ''; while (i < src.length && src[i] !== q) { if (src[i] === '\\') { s += src[i + 1]; i += 2; } else s += src[i++]; } i++; toks.push({ t: 'str', v: s, line }); continue; }
    if (/[0-9]/.test(c)) { let n = ''; if (c === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X')) { n = '0x'; i += 2; while (i < src.length && /[0-9a-fA-F_]/.test(src[i])) n += src[i++]; toks.push({ t: 'num', v: BigInt(n.replace(/_/g, '')).toString(), line }); continue; } while (i < src.length && /[0-9_]/.test(src[i])) n += src[i++]; toks.push({ t: 'num', v: n.replace(/_/g, ''), line }); continue; }
    if (/[A-Za-z_$]/.test(c)) { let w = ''; while (i < src.length && /[A-Za-z0-9_$]/.test(src[i])) w += src[i++]; toks.push({ t: 'word', v: w, line }); continue; }
    const t2 = src.substr(i, 2);
    if (two.includes(t2)) { toks.push({ t: 'op', v: t2, line }); i += 2; continue; }
    toks.push({ t: 'op', v: c, line }); i++;
  }
  toks.push({ t: 'eof', v: null, line });
  return toks;
}

// ---------------- parser ----------------
export function importSolidity(src) {
  const toks = lex(src);
  let p = 0;
  const peek = (o = 0) => toks[p + o];
  const next = () => toks[p++];
  const isW = (v) => peek().t === 'word' && peek().v === v;
  const isOp = (v) => peek().t === 'op' && peek().v === v;
  const err = (m) => new Error(`import (line ${peek().line}): ${m}`);
  const eatOp = (v) => { if (!isOp(v)) throw err(`expected '${v}', got '${peek().v}'`); return next(); };
  const eatWord = () => { if (peek().t !== 'word') throw err(`expected identifier, got '${peek().v}'`); return next().v; };

  const REFUSE = { library: 1, interface: 1, struct: 1, modifier: 1, using: 1, assembly: 1, abstract: 1 };
  const contracts = [];
  while (peek().t !== 'eof') {
    if (isW('pragma') || isW('import')) { while (peek().t !== 'eof' && !isOp(';')) next(); if (isOp(';')) next(); continue; }
    if (peek().t === 'word' && REFUSE[peek().v]) throw err(`unsupported Solidity construct '${peek().v}' — has no LNG equivalent`);
    if (isW('contract')) { contracts.push(parseContract()); continue; }
    next(); // skip anything else at top level
  }
  if (!contracts.length) throw err('no contract found to import');
  return contracts.map(emitContract).join('\n\n');

  function parseContract() {
    eatWord(); // 'contract'
    const name = eatWord();
    if (isW('is')) throw err('contract inheritance (is ...) is not supported');
    eatOp('{');
    const fields = [], events = [], methods = [];
    while (!isOp('}') && peek().t !== 'eof') {
      if (peek().t === 'word' && REFUSE[peek().v]) throw err(`unsupported member '${peek().v}'`);
      if (isW('event')) { events.push(parseEvent()); continue; }
      if (isW('function') || isW('constructor')) { methods.push(parseFunction()); continue; }
      if (isW('mapping') || isTypeStart()) { fields.push(parseStateVar()); continue; }
      if (isW('modifier')) throw err('function modifiers are not supported');
      throw err(`unexpected contract member starting at '${peek().v}'`);
    }
    eatOp('}');
    return { name, fields, events, methods };
  }

  function isTypeStart() {
    if (peek().t !== 'word') return false;
    const v = peek().v;
    return /^(uint|int|bool|address|bytes|string)/.test(v);
  }

  // uint256[ public|private|internal ] name [ = expr ] ;
  function parseStateVar() {
    const type = parseType();
    let vis = 'private';
    while (peek().t === 'word' && ['public', 'private', 'internal', 'constant', 'immutable'].includes(peek().v)) {
      const k = next().v; if (k === 'public') vis = 'public'; else if (k === 'private' || k === 'internal') vis = 'private';
    }
    const name = eatWord();
    let init = null;
    if (isOp('=')) { next(); init = parseExpr(0); }
    eatOp(';');
    return { name, type: solTypeToLng(type), vis, init };
  }

  function parseType() {
    if (isW('mapping')) { // mapping(K => V) — consume the whole thing
      let depth = 0, s = 'mapping';
      next(); if (!isOp('(')) throw err('malformed mapping'); depth++; next(); s += '(';
      while (depth > 0 && peek().t !== 'eof') { if (isOp('(')) depth++; if (isOp(')')) depth--; s += peek().v; next(); }
      return s;
    }
    let t = eatWord();
    if (isW('payable')) { t += ' payable'; next(); }
    if (isOp('[')) { next(); if (!isOp(']')) throw err('sized/array types are not supported'); next(); throw err('array types are not supported'); }
    return t;
  }

  function parseEvent() {
    eatWord(); // event
    const name = eatWord();
    const params = parseParams(true);
    eatOp(';');
    return { name, params };
  }

  function parseFunction() {
    const kw = next().v; // function | constructor
    const name = kw === 'constructor' ? 'init' : eatWord();
    const params = parseParams(false);
    // modifiers/visibility/mutability/returns
    let returns = false;
    while (!isOp('{') && !isOp(';')) {
      if (isW('returns')) { next(); eatOp('('); returns = true; while (!isOp(')')) next(); eatOp(')'); continue; }
      if (peek().t === 'word' && ['public', 'external', 'internal', 'private', 'view', 'pure', 'payable', 'virtual', 'override'].includes(peek().v)) { next(); continue; }
      if (peek().t === 'word') throw err(`function modifier '${peek().v}' is not supported`);
      throw err(`unexpected token '${peek().v}' in function header`);
    }
    if (isOp(';')) { next(); return { name, params, returns, body: [] }; } // no body (abstract) → empty
    const body = parseBlock();
    return { name, params, returns, body };
  }

  function parseParams(isEvent) {
    eatOp('(');
    const out = [];
    while (!isOp(')')) {
      const type = parseType();
      // data location + indexed
      while (peek().t === 'word' && ['memory', 'storage', 'calldata', 'indexed'].includes(peek().v)) next();
      let name = '';
      if (peek().t === 'word') name = next().v;
      out.push({ name: name || `_a${out.length}`, type: solTypeToLng(type) });
      if (isOp(',')) next();
    }
    eatOp(')');
    return out;
  }

  function parseBlock() {
    eatOp('{');
    const stmts = [];
    while (!isOp('}') && peek().t !== 'eof') stmts.push(parseStmt());
    eatOp('}');
    return stmts;
  }

  function parseStmt() {
    if (isOp('{')) return { k: 'block', body: parseBlock() };
    if (isW('if')) return parseIf();
    if (isW('for')) return parseFor();
    if (isW('while')) throw err('while loops are not supported (use a counted for)');
    if (isW('return')) { next(); let v = null; if (!isOp(';')) v = parseExpr(0); eatOp(';'); return { k: 'return', value: v }; }
    if (isW('emit')) { next(); const name = eatWord(); const args = parseArgs(); eatOp(';'); return { k: 'emit', name, args }; }
    if (isW('require')) { next(); eatOp('('); const cond = parseExpr(0); let msg = null; if (isOp(',')) { next(); if (peek().t === 'str') msg = next().v; else parseExpr(0); } eatOp(')'); eatOp(';'); return { k: 'require', cond, msg }; }
    if (isW('revert')) { next(); if (isOp('(')) { parseArgs(); } eatOp(';'); return { k: 'require', cond: { k: 'num', v: '0' }, msg: 'revert' }; }
    if (isW('unchecked')) { next(); return { k: 'block', body: parseBlock() }; }
    // local declaration: <type> name [= expr];
    if (isTypeStart() || isW('mapping')) {
      const type = parseType();
      while (peek().t === 'word' && ['memory', 'storage', 'calldata'].includes(peek().v)) next();
      const name = eatWord();
      let v = null; if (isOp('=')) { next(); v = parseExpr(0); }
      eatOp(';');
      return { k: 'decl', name, type: solTypeToLng(type), value: v };
    }
    // assignment / expression / ++ / --
    const target = parseExpr(0);
    if (peek().t === 'op' && ['=', '+=', '-=', '*=', '/=', '%='].includes(peek().v)) {
      const op = next().v; const rhs = parseExpr(0); eatOp(';');
      const value = op === '=' ? rhs : { k: 'bin', op: op[0], left: target, right: rhs };
      return { k: 'assign', target, value };
    }
    if (isOp('++') || isOp('--')) { const op = next().v[0]; eatOp(';'); return { k: 'assign', target, value: { k: 'bin', op, left: target, right: { k: 'num', v: '1' } } }; }
    eatOp(';');
    return { k: 'expr', expr: target };
  }

  function parseIf() {
    eatWord(); eatOp('('); const cond = parseExpr(0); eatOp(')');
    const then = isOp('{') ? parseBlock() : [parseStmt()];
    let els = null;
    if (isW('else')) { next(); els = isW('if') ? [parseIf()] : (isOp('{') ? parseBlock() : [parseStmt()]); }
    return { k: 'if', cond, then, els };
  }

  // Only the canonical `for (uintN i = A; i <= B; i++)` maps to LNG's counted for.
  function parseFor() {
    eatWord(); eatOp('(');
    if (isTypeStart()) parseType();
    const varName = eatWord();
    eatOp('='); const start = parseExpr(0); eatOp(';');
    const cVar = eatWord();
    if (cVar !== varName) throw err('for-loop condition must test the loop variable');
    let end;
    if (isOp('<=')) { next(); end = parseExpr(0); }
    else if (isOp('<')) { next(); end = { k: 'bin', op: '-', left: parseExpr(0), right: { k: 'num', v: '1' } }; }
    else throw err('only `i <= N` / `i < N` counted for-loops are supported');
    eatOp(';');
    // step must be i++ or ++i or i += 1
    const s2 = eatWord(); if (s2 !== varName) throw err('for-loop step must advance the loop variable');
    if (!(isOp('++'))) { if (isOp('+=')) { next(); const st = parseExpr(0); if (!(st.k === 'num' && st.v === '1')) throw err('only a step of 1 is supported'); } else throw err('only i++ / i += 1 steps are supported'); }
    else next();
    eatOp(')');
    const body = isOp('{') ? parseBlock() : [parseStmt()];
    return { k: 'for', varName, start, end, body };
  }

  function parseArgs() {
    eatOp('(');
    const args = [];
    while (!isOp(')')) { args.push(parseExpr(0)); if (isOp(',')) next(); }
    eatOp(')');
    return args;
  }

  // precedence-climbing expression parser
  function parseExpr(minPrec) {
    let left = parseUnary();
    for (;;) {
      const t = peek();
      if (t.t === 'op' && t.v === '?') { // ternary
        next(); const a = parseExpr(0); eatOp(':'); const b = parseExpr(0); left = { k: 'tern', cond: left, then: a, els: b }; continue;
      }
      if (t.t !== 'op' || !(t.v in PREC)) break;
      const prec = PREC[t.v];
      if (prec < minPrec) break;
      next();
      const right = parseExpr(prec + 1);
      left = { k: 'bin', op: t.v, left, right };
    }
    return left;
  }

  function parseUnary() {
    if (isOp('!')) { next(); return { k: 'un', op: '!', e: parseUnary() }; }
    if (isOp('-')) { next(); return { k: 'un', op: '-', e: parseUnary() }; }
    if (isOp('~')) { next(); return { k: 'un', op: '~', e: parseUnary() }; }
    if (isOp('+')) { next(); return parseUnary(); }
    return parsePostfix();
  }

  function parsePostfix() {
    let e = parsePrimary();
    for (;;) {
      if (isOp('.')) { next(); const name = eatWord(); e = { k: 'member', obj: e, name }; continue; }
      if (isOp('[')) { next(); const idx = parseExpr(0); eatOp(']'); e = { k: 'index', obj: e, index: idx }; continue; }
      if (isOp('(')) { const args = parseArgs(); e = { k: 'call', callee: e, args }; continue; }
      break;
    }
    return e;
  }

  function parsePrimary() {
    const t = peek();
    if (t.t === 'num') { next(); return { k: 'num', v: t.v }; }
    if (t.t === 'str') { next(); return { k: 'str', v: t.v }; }
    if (isOp('(')) { next(); const e = parseExpr(0); eatOp(')'); return { k: 'group', e }; }
    if (t.t === 'word') {
      const w = next().v;
      if (w === 'true') return { k: 'bool', v: true };
      if (w === 'false') return { k: 'bool', v: false };
      return { k: 'ref', name: w };
    }
    throw err(`unexpected token '${t.v}' in expression`);
  }
}

// ---------------- LNG emitter ----------------
function emitContract(c) {
  const L = [`~contract \`${c.name} {`];
  const pub = c.fields.filter((f) => f.vis === 'public');
  const priv = c.fields.filter((f) => f.vis !== 'public');
  if (pub.length || priv.length) {
    L.push('  ~state {');
    if (pub.length) L.push('    ~public { ' + pub.map(emitField).join('  ') + ' }');
    if (priv.length) L.push('    ~private { ' + priv.map(emitField).join('  ') + ' }');
    L.push('  }');
  }
  for (const ev of c.events) L.push(`  ~event \`${ev.name}(${ev.params.map((p) => '`' + p.name + ' ~' + p.type).join(', ')})`);
  for (const m of c.methods) L.push(emitMethod(m));
  L.push('}');
  return L.join('\n');
}

function emitField(f) {
  // A field must carry an initial value for the LNG state block; default per type when Solidity omitted it.
  const init = f.init != null ? emitExpr(f.init) : defaultInit(f.type);
  return '`' + f.name + ' ~' + f.type + ' ' + init;
}
function defaultInit(type) {
  if (INT_TYPE(type)) return '0';
  if (type === 'bool') return '~f';
  if (type === 'address') return "'0x0000000000000000000000000000000000000000'";
  if (type === 'bytes') return "'0x'";
  if (type === 'string') return "''";
  if (type === 'map') return '0';
  return '0';
}

function emitMethod(m) {
  const params = m.params.map((p) => '`' + p.name + ' ~' + p.type).join(', ');
  return `  ~on \`${m.name}(${params}) {\n${emitStmts(m.body, 2)}\n  }`;
}

const pad = (d) => '  '.repeat(d);

// Emit a statement list. `require(cond, msg)` lowers to a NEGATED guard whose revert is in the
// THEN block: `!(cond) ? { ~e 'msg' }`. This is load-bearing for correctness — an LNG ternary
// executes its then-branch (a real block) but its else-branch parses as an unexecuted `anonfn`
// closure, so putting the revert in the else (the old fold) meant a failed precondition did NOTHING
// in the interpreter. With the revert in the then-branch it fires on failure, aborting the call
// exactly as the WASM backend's `unreachable` trap does — at ANY nesting depth, no fold needed, so
// statements after the require are ordinary siblings and the two backends agree.
function emitStmts(stmts, d) {
  return stmts.map((s) => emitStmt(s, d)).join('\n');
}
function emitRequire(s, d) {
  const msg = s.msg ? `'${String(s.msg).replace(/'/g, "\\'")}'` : "'require failed'";
  return `${pad(d)}!(${emitExpr(s.cond)}) ? { ~e ${msg} }`;
}

function emitStmt(s, d) {
  switch (s.k) {
    case 'decl': return `${pad(d)}\`${s.name} ~${s.type} ${s.value != null ? emitExpr(s.value) : defaultInit(s.type)}`;
    case 'assign': return `${pad(d)}${emitLValue(s.target)} = ${emitExpr(s.value)}`;
    case 'return': return `${pad(d)}return ${s.value ? emitExpr(s.value) : '~n'}`;
    case 'emit': return `${pad(d)}~emit \`${s.name}(${s.args.map(emitExpr).join(', ')})`;
    case 'expr': return `${pad(d)}${emitExpr(s.expr)}`;
    case 'block': return emitStmts(s.body, d);
    case 'if': {
      const then = `{\n${emitStmts(s.then, d + 1)}\n${pad(d)}}`;
      const els = s.els ? ` | {\n${emitStmts(s.els, d + 1)}\n${pad(d)}}` : '';
      return `${pad(d)}${emitExpr(s.cond)} ? ${then}${els}`;
    }
    case 'for': return `${pad(d)}~for \`${s.varName} ${emitExpr(s.start)} ${emitExpr(s.end)} {\n${emitStmts(s.body, d + 1)}\n${pad(d)}}`;
    case 'require': return emitRequire(s, d);
    default: throw new Error(`import: cannot emit statement '${s.k}'`);
  }
}

function emitLValue(n) {
  if (n.k === 'ref') return '`' + n.name;
  if (n.k === 'index') return emitLValue(n.obj) + '[' + emitExpr(n.index) + ']';
  if (n.k === 'member') return emitLValue(n.obj) + '.' + n.name;
  return emitExpr(n);
}

function emitExpr(n) {
  switch (n.k) {
    case 'num': return n.v;
    case 'str': return `'${String(n.v).replace(/'/g, "\\'")}'`;
    case 'bool': return n.v ? '~t' : '~f';
    case 'ref': {
      if (n.name === 'msg') return '`msg';
      return '`' + n.name;
    }
    case 'group': return '(' + emitExpr(n.e) + ')';
    case 'member': {
      // msg.sender → the LNG caller convention (`caller`). msg.value is REFUSED, not aliased to
      // `caller: LNG/XCL has no payable-ether concept, so silently mapping msg.value to the caller
      // address would neuter a `require(msg.value >= price)` guard into an always-true comparison of
      // an address against a number. An importer that quietly did that is the theatrical kind — this
      // one names the gap so the contract fails to import instead of importing wrong.
      if (n.obj.k === 'ref' && n.obj.name === 'msg') {
        if (n.name === 'sender') return '`caller';
        throw new Error(`import: msg.${n.name} has no LNG/XCL equivalent (payable-ether semantics are not modelled) — refusing to mistranslate it`);
      }
      // Other EVM-only globals have no XMBL analogue and MUST be refused by name, never passed
      // through to surface later as an opaque backend error or, worse, silently read as 0/null.
      // `block.*` and `tx.*` are also non-deterministic (the determinism gate would reject them),
      // `.balance` needs an ether model XMBL does not have.
      if (n.obj.k === 'ref' && (n.obj.name === 'block' || n.obj.name === 'tx'))
        throw new Error(`import: ${n.obj.name}.${n.name} has no LNG/XCL equivalent (EVM-only / non-deterministic) — refusing to mistranslate it`);
      if (n.name === 'balance')
        throw new Error('import: .balance has no LNG/XCL equivalent (XMBL models no native ether balance) — refusing to mistranslate it');
      return emitExpr(n.obj) + '.' + n.name;
    }
    case 'index': return emitExpr(n.obj) + '[' + emitExpr(n.index) + ']';
    case 'un': return (n.op === '~' ? 'b~' : n.op) + emitExpr(n.e);
    case 'bin': {
      const op = BIN[n.op];
      if (!op) throw new Error(`import: operator '${n.op}' has no LNG form`);
      return emitExpr(n.left) + ' ' + op + ' ' + emitExpr(n.right);
    }
    case 'tern': return emitExpr(n.cond) + ' ? ' + emitExpr(n.then) + ' | ' + emitExpr(n.els);
    case 'call': {
      // type-cast forms like uint256(x) / address(x) → LNG `~is` coercion; other calls pass through.
      if (n.callee.k === 'ref' && (/^(u?int\d*|address|bytes\d*|bool)$/.test(n.callee.name))) {
        return emitExpr(n.args[0]) + ' ~is ~' + solTypeToLng(n.callee.name);
      }
      // EVM-only value/low-level ops and global builtins have no XMBL analogue — refuse by name so an
      // ether transfer or gas/hash builtin fails the import loudly instead of compiling to something
      // that does not mean what the Solidity did.
      if (n.callee.k === 'member' && ['transfer', 'send', 'call', 'delegatecall', 'staticcall'].includes(n.callee.name))
        throw new Error(`import: low-level/value call .${n.callee.name}() has no LNG/XCL equivalent (XMBL has no native ether transfer or raw call) — refusing to mistranslate it`);
      if (n.callee.k === 'ref' && ['gasleft', 'selfdestruct', 'suicide', 'keccak256', 'sha256', 'ripemd160', 'ecrecover', 'blockhash'].includes(n.callee.name))
        throw new Error(`import: EVM builtin ${n.callee.name}() has no LNG/XCL equivalent — refusing to mistranslate it`);
      return emitExpr(n.callee) + '(' + n.args.map(emitExpr).join(', ') + ')';
    }
    default: throw new Error(`import: cannot emit expression '${n.k}'`);
  }
}
