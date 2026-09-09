/*
 * LNG reference interpreter (milestone 1).
 *
 * A tree-walking interpreter that makes core LNG programs actually run:
 * `-identifiers, ~-system commands/types, '...' strings, numbers, the full
 * operator set, JSON-like objects/arrays (insertion-ordered, per decision 3),
 * member access, overloaded functions (dispatch by arity), chainable ternary,
 * ~for/~as loops (collection + counted), ~is typeof/coercion, ~p, ~exit, ~e.
 *
 * This interpreter is the SEMANTICS REFERENCE for the language. Numbers use JS
 * doubles here (off-chain semantics); the on-chain lowering will replace them
 * with checked fixed-width integers + a fixed-point ~decimal type (see
 * docs/xmbl-port-requirements.md decision 2). Object iteration is insertion
 * order (decision 3).
 *
 * API (this is the ESM package build — no CLI):
 *   import { run, lex, parse } from '@xmbl/lng';
 *   run(src, { write: s => process.stdout.write(s) });
 */

// ----------------------------------------------------------------------------
// Values
// ----------------------------------------------------------------------------
class LObject {           // insertion-ordered key/value map (decision 3)
  constructor() { this.keys = []; this.map = new Map(); }
  set(k, v) { if (!this.map.has(k)) this.keys.push(k); this.map.set(k, v); }
  get(k) { return this.map.get(k); }
  has(k) { return this.map.has(k); }
  entries() { return this.keys.map(k => [k, this.map.get(k)]); }
}
class LFunction {         // overload set: several definitions sharing a name
  constructor() { this.overloads = []; } // {params:[str], body:Node, closure:Scope}
  add(o) { this.overloads.push(o); }
}
const NULL = Symbol('~n');
class LError { constructor(msg) { this.message = msg; } }
class ExitSignal { constructor(value) { this.value = value; } }
class ReturnSignal { constructor(value) { this.value = value; } }

// --- Typed on-chain values (decision 2: checked integers + fixed-point decimal) ---
// Integers are exact BigInt bounded by (signed, bits); decimals are fixed-point
// BigInt scaled by 10^SCALE. These are the deterministic numeric types the EVM and
// XCL backends lower to; plain JS numbers remain the off-chain float type.
const DEC_SCALE = 18n;
const DEC_ONE = 10n ** DEC_SCALE;
class LInt {
  constructor(v, signed, bits) { this.v = BigInt(v); this.signed = signed; this.bits = bits; }
  get typeName() { return '~' + (this.signed ? 'i' : 'u') + this.bits; }
}
class LDecimal { // v is the value * 10^18
  constructor(scaled) { this.v = BigInt(scaled); }
  get typeName() { return '~decimal'; }
}
class LTyped { constructor(t, value) { this.t = t; this.value = value; } } // address / bytes

// --- Contract model (decision 4: contract/state/entrypoint/perm as first-class syntax) ---
class LContractDef {
  constructor(name) { this.name = name; this.fields = []; this.methods = new Map(); this.events = new Map(); this.perms = []; this.hooks = new Map(); }
}
class LInstance {
  constructor(def, state) { this.def = def; this.state = state; this.events = []; }
}
class LBoundMethod { constructor(inst, method) { this.inst = inst; this.method = method; } }
class LNative { constructor(name, fn) { this.name = name; this.fn = fn; } } // built-in stdlib fn
const INT_WIDTHS = { u8: [false, 8], u16: [false, 16], u32: [false, 32], u64: [false, 64], u128: [false, 128], u256: [false, 256], i8: [true, 8], i16: [true, 16], i32: [true, 32], i64: [true, 64], i128: [true, 128], i256: [true, 256] };
function intRange(signed, bits) {
  const b = BigInt(bits);
  return signed ? [-(2n ** (b - 1n)), 2n ** (b - 1n) - 1n] : [0n, 2n ** b - 1n];
}
function fitInt(v, signed, bits) {
  const [lo, hi] = intRange(signed, bits);
  if (v < lo || v > hi) throw new LRevert(`${signed ? 'i' : 'u'}${bits} overflow: ${v} out of [${lo}, ${hi}]`);
  return new LInt(v, signed, bits);
}
class LRevert extends Error {} // a checked-arithmetic / type violation that aborts execution

// ----------------------------------------------------------------------------
// Lexer
// ----------------------------------------------------------------------------
const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /[A-Za-z0-9_]/;
const BIT_SYMS = { '&': 'b&', '|': 'b|', '^': 'b^', '~': 'b~', '<': 'b<', '>': 'b>' };

function lex(src) {
  const toks = [];
  let i = 0, line = 1;
  const push = (type, value, extra) => toks.push(Object.assign({ type, value, line }, extra));
  let lastSignificant = null; // track for `(` spaceBefore
  let sawSpace = false;
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') { pushNewline(); i++; line++; sawSpace = true; continue; }
    if (c === ';') { pushNewline(); i++; sawSpace = true; continue; } // ';' = explicit statement separator (one-liners)
    if (c === ' ' || c === '\t' || c === '\r') { i++; sawSpace = true; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }

    // string
    if (c === "'") {
      i++; let s = '';
      while (i < src.length && src[i] !== "'") {
        if (src[i] === '\\') {
          const n = src[i + 1];
          s += n === 'n' ? '\n' : n === 't' ? '\t' : n === '\\' ? '\\' : n === "'" ? "'" : n;
          i += 2;
        } else s += src[i++];
      }
      i++; // closing quote
      emit('str', s); continue;
    }
    // number
    if (/[0-9]/.test(c)) {
      let n = '';
      while (i < src.length && /[0-9.]/.test(src[i])) n += src[i++];
      emit('num', parseFloat(n)); continue;
    }
    // backtick identifier
    if (c === '`') {
      i++; let name = '';
      while (i < src.length && NAME_CHAR.test(src[i])) name += src[i++];
      emit('id', name); continue;
    }
    // bitwise ops (b&, b|, b^, b~, b<, b>) — check before ~ sysname and words
    if (c === 'b' && BIT_SYMS[src[i + 1]]) { const v = BIT_SYMS[src[i + 1]]; i += 2; emit('op', v); continue; }
    // system name (~name); ~ alone is not valid
    if (c === '~') {
      i++; let name = '';
      while (i < src.length && NAME_CHAR.test(src[i])) name += src[i++];
      if (!name) throw err('bare ~ is not a valid token');
      emit('sys', name); continue;
    }
    // bare word (keywords: return)
    if (NAME_START.test(c)) {
      let w = '';
      while (i < src.length && NAME_CHAR.test(src[i])) w += src[i++];
      if (w === 'return') { emit('return', w); continue; }
      emit('word', w); continue; // bare word: legal only as a member name after '.'
    }
    // multi/single-char operators & punctuation
    if (c === '(') { emit('lparen', '(', { space: sawSpace }); i++; continue; }
    if (c === ')') { emit('rparen', ')'); i++; continue; }
    if (c === '{') { emit('lbrace', '{'); i++; continue; }
    if (c === '}') { emit('rbrace', '}'); i++; continue; }
    if (c === '[') { emit('lbrack', '['); i++; continue; }
    if (c === ']') { emit('rbrack', ']'); i++; continue; }
    if (c === ',') { emit('comma', ','); i++; continue; }
    if (c === '.') { emit('dot', '.'); i++; continue; }
    if (c === '?') { emit('op', '?'); i++; continue; }

    // == != !== ! !> !< > < >= etc
    const two = src.substr(i, 2), three = src.substr(i, 3);
    if (three === '!==') { emit('op', '!=='); i += 3; continue; }
    if (two === '==') { emit('op', '=='); i += 2; continue; }
    if (two === '!>') { emit('op', '!>'); i += 2; continue; }
    if (two === '!<') { emit('op', '!<'); i += 2; continue; }
    if (c === '>') { emit('op', '>'); i++; continue; }
    if (c === '<') { emit('op', '<'); i++; continue; }
    if (c === '=') { emit('op', '='); i++; continue; }
    if (c === '+' || c === '-' || c === '*' || c === '/' || c === '%') { emit('op', c); i++; continue; }
    if (c === '&') { emit('op', '&'); i++; continue; }
    if (c === '|') { emit('op', '|'); i++; continue; }
    if (c === '!') { emit('op', '!'); i++; continue; }
    throw err(`unexpected character '${c}'`);
  }
  push('eof', null);
  return toks;

  function emit(type, value, extra) { push(type, value, extra); lastSignificant = type; sawSpace = false; }
  function pushNewline() {
    if (toks.length && toks[toks.length - 1].type !== 'newline') push('newline', '\\n');
  }
  function err(m) { return new Error(`Lex error (line ${line}): ${m}`); }
}

// ----------------------------------------------------------------------------
// Parser  → AST
// ----------------------------------------------------------------------------
// Precedence for binary operators (higher binds tighter).
const BINPREC = {
  '|': 2, '&': 3,
  '==': 4, '!==': 4, '>': 4, '<': 4, '!>': 4, '!<': 4,
  'b&': 5, 'b|': 5, 'b^': 5, 'b<': 5, 'b>': 5,
  '+': 6, '-': 6,
  '*': 7, '/': 7, '%': 7,
};

function parse(toks) {
  let p = 0;
  const peek = (o = 0) => toks[p + o];
  const next = () => toks[p++];
  const at = t => peek().type === t;
  const atOp = v => peek().type === 'op' && peek().value === v;
  const eat = (type, v) => {
    const t = peek();
    if (t.type !== type || (v !== undefined && t.value !== v)) throw perr(`expected ${v || type}, got '${t.value}' (${t.type})`);
    return next();
  };
  const skipNL = () => { while (at('newline')) next(); };
  const perr = m => new Error(`Parse error (line ${peek().line}): ${m}`);

  function parseProgram() {
    const stmts = [];
    skipNL();
    while (!at('eof')) { stmts.push(parseStatement()); skipNL(); }
    return { kind: 'program', body: stmts };
  }

  // A statement is either an assignment / function def, or an expression.
  function parseStatement() {
    // contract definition
    if (at('sys') && peek().value === 'contract') return parseContract();
    // counted for:  ~for `i start end { block }
    if (at('sys') && peek().value === 'for' && peek(1).type === 'id') {
      return parseCountedFor();
    }
    if (at('id')) {
      const nt = peek(1);
      // function definition:  `name(...) { ... }   ( '(' immediately after id )
      if (nt.type === 'lparen' && nt.space === false) {
        // could be a def (params then block) or a call expression; decide by scanning
        if (looksLikeFnDef()) return parseFnDef();
      }
      const ln = peek().line;
      // explicit assignment `name = expr
      if (nt.type === 'op' && nt.value === '=') {
        const name = next().value; next(); // '='
        return { kind: 'assign', name, line: ln, value: parseExpression() };
      }
      // typed assignment `name ~TYPE value   (declares a checked-integer / decimal / etc.)
      if (nt.type === 'sys' && isTypeName(nt.value) && startsValueStrict(peek(2))) {
        const name = next().value, declType = next().value;
        return { kind: 'assign', name, declType, line: ln, value: parseExpression() };
      }
      // implicit assignment `name <value>   (value token, not an operator / postfix
      // command, and not `name(...) with no space — that is a call, not assignment)
      const isCallParen = nt.type === 'lparen' && nt.space === false;
      if (startsValue(nt) && !isPostfixSys(nt) && !isCallParen) {
        const name = next().value;
        return { kind: 'assign', name, line: ln, value: parseExpression() };
      }
    }
    return { kind: 'exprstmt', expr: parseExpression() };
  }

  function looksLikeFnDef() {
    // scan: id ( paramlist ) {   → definition; params may carry a ~TYPE annotation
    let q = p + 1; // at '('
    if (toks[q].type !== 'lparen') return false;
    q++;
    while (toks[q] && toks[q].type !== 'rparen' && toks[q].type !== 'eof') {
      const t = toks[q];
      const okType = t.type === 'sys' && isTypeName(t.value);
      if (t.type !== 'id' && t.type !== 'comma' && t.type !== 'newline' && !okType) return false;
      q++;
    }
    if (!toks[q] || toks[q].type !== 'rparen') return false;
    q++;
    while (toks[q] && toks[q].type === 'newline') q++;
    return toks[q] && toks[q].type === 'lbrace';
  }

  function parseFnDef() {
    const name = eat('id').value;
    eat('lparen');
    const params = [];
    skipNL();
    while (!at('rparen')) {
      const pname = eat('id').value;
      let ptype = null;
      if (at('sys') && isTypeName(peek().value)) ptype = next().value; // `a ~u256
      params.push({ name: pname, type: ptype });
      skipNL();
      if (at('comma')) { next(); skipNL(); }
    }
    eat('rparen'); skipNL();
    const body = parseBlock();
    return { kind: 'fndef', name, params, body };
  }

  function parseCountedFor() {
    eat('sys', undefined); // 'for'
    const varName = eat('id').value;
    const start = parseBinaryExpr(4); // stop before low-prec; simple bounds
    const end = parseBinaryExpr(4);
    skipNL();
    const body = parseBlock();
    return { kind: 'countedfor', varName, start, end, body };
  }

  function parseBlock() {
    eat('lbrace');
    const stmts = [];
    skipNL();
    while (!at('rbrace') && !at('eof')) { stmts.push(parseStatement()); skipNL(); }
    eat('rbrace');
    return { kind: 'block', body: stmts };
  }

  // ~contract `Name { ~state{...} ~on `m(...){...} ~event `E(...) ~perm `m ~kind 'x' ~onsignal(...){...} }
  function parseContract() {
    eat('sys'); // 'contract'
    const name = eat('id').value;
    skipNL(); eat('lbrace'); skipNL();
    const fields = [], methods = [], events = [], perms = [], hooks = [];
    while (!at('rbrace') && !at('eof')) {
      const kw = eat('sys').value;
      if (kw === 'state') { parseState(fields); }
      else if (kw === 'on') { const mname = eat('id').value; const params = parseParamList(); skipNL(); const body = parseBlock(); methods.push({ name: mname, params, body }); }
      else if (kw === 'event') { const ename = eat('id').value; const params = parseParamList(); events.push({ name: ename, params }); }
      else if (kw === 'perm') { const m = eat('id').value; const kind = at('sys') ? next().value : eat('word').value; const payload = parseExpression(); perms.push({ method: m, kind, payload }); }
      else if (kw === 'onsignal' || kw === 'onorder') { const params = parseParamList(); skipNL(); const body = parseBlock(); hooks.push({ on: kw === 'onsignal' ? 'signal' : 'order', params, body }); }
      else throw perr(`unknown contract member ~${kw}`);
      skipNL();
    }
    eat('rbrace');
    return { kind: 'contract', name, fields, methods, events, perms, hooks };
  }
  function parseState(fields) {
    skipNL(); eat('lbrace'); skipNL();
    while (!at('rbrace') && !at('eof')) {
      const vis = eat('sys').value; // 'public' | 'private'
      skipNL(); eat('lbrace'); skipNL();
      while (!at('rbrace') && !at('eof')) {
        const fname = eat('id').value;
        let ftype = null; if (at('sys') && isTypeName(peek().value)) ftype = next().value;
        let init = null; if (startsValueStrict(peek())) init = parseExpression();
        fields.push({ name: fname, type: ftype, vis, init });
        skipNL();
      }
      eat('rbrace'); skipNL();
    }
    eat('rbrace');
  }
  function parseParamList() {
    eat('lparen'); const params = []; skipNL();
    while (!at('rparen')) {
      const pname = eat('id').value;
      let ptype = null; if (at('sys') && isTypeName(peek().value)) ptype = next().value;
      params.push({ name: pname, type: ptype });
      skipNL(); if (at('comma')) { next(); skipNL(); }
    }
    eat('rparen');
    return params;
  }

  // Expression = ternary
  function parseExpression() { return parseTernary(); }

  function parseTernary() {
    const cond = parseBinaryExpr(0);
    if (atOp('?')) {
      next();
      const thenB = parseBranch();
      let elseB = null;
      if (atOp('|')) { next(); elseB = parseExpression(); } // chainable via recursion
      return { kind: 'ternary', cond, thenB, elseB };
    }
    return cond;
  }

  // then-branch: a block, or an expression that does NOT consume a top-level '|'
  function parseBranch() {
    if (at('lbrace')) return parseBlock();
    return parseBinaryExpr(3); // min prec 3 → excludes '|' (2), so '|' means else
  }

  function parseBinaryExpr(minPrec) {
    let left = parseUnary();
    for (;;) {
      const t = peek();
      if (t.type !== 'op' || !(t.value in BINPREC)) break;
      const prec = BINPREC[t.value];
      if (prec < minPrec || prec === 0) break;
      next();
      const right = parseBinaryExpr(prec + 1);
      left = { kind: 'binary', op: t.value, left, right };
    }
    return left;
  }

  function parseUnary() {
    if (atOp('!')) { next(); return { kind: 'unary', op: '!', operand: parseUnary() }; }
    if (atOp('-')) { next(); return { kind: 'unary', op: '-', operand: parseUnary() }; }
    if (atOp('b~')) { next(); return { kind: 'unary', op: 'b~', operand: parseUnary() }; }
    return parsePostfix();
  }

  // postfix: member access, call, index, and the postfix system commands ~is / ~for
  function parsePostfix() {
    let node = parsePrimary();
    for (;;) {
      if (at('dot')) {
        next();
        if (at('lbrace')) { const e = parseBlock(); node = { kind: 'memberexpr', obj: node, expr: e }; }
        else if (at('num')) { node = { kind: 'member', obj: node, name: String(next().value) }; }
        else if (at('word') || at('id')) { node = { kind: 'member', obj: node, name: next().value }; }
        else { node = { kind: 'member', obj: node, name: eat('word').value }; }
      } else if (at('lbrack')) {
        next(); const idx = parseExpression(); eat('rbrack');
        node = { kind: 'index', obj: node, index: idx };
      } else if (at('lparen') && peek().space === false) {
        node = { kind: 'call', callee: node, args: parseArgs() };
      } else if (at('sys') && peek().value === 'is') {
        next();
        let typeArg = null;
        if (at('sys') && isTypeName(peek().value)) typeArg = next().value;
        node = { kind: 'is', value: node, typeArg };
      } else if (at('sys') && peek().value === 'for') {
        next();
        let asVar = null;
        if (at('sys') && peek().value === 'as') { next(); asVar = eat('id').value; }
        skipNL();
        const body = parseBlock();
        node = { kind: 'forin', coll: node, asVar, body };
      } else break;
    }
    return node;
  }

  function parseArgs() {
    eat('lparen');
    const args = [];
    skipNL();
    while (!at('rparen')) {
      args.push(parseExpression());
      skipNL();
      if (at('comma')) { next(); skipNL(); }
    }
    eat('rparen');
    return args;
  }

  function parsePrimary() {
    const t = peek();
    if (t.type === 'num') { next(); return { kind: 'num', value: t.value, line: t.line, fractional: !Number.isInteger(t.value) }; }
    if (t.type === 'str') { next(); return { kind: 'str', value: t.value }; }
    if (t.type === 'id') { next(); return { kind: 'ref', name: t.value, line: t.line }; }
    if (t.type === 'return') { next(); return { kind: 'return', value: endsExpr() ? null : parseExpression() }; }
    if (t.type === 'lbrace') { return { kind: 'anonfn', body: parseBlock() }; }
    if (t.type === 'lparen') { return parseParen(); }
    if (t.type === 'sys') return parseSys();
    throw perr(`unexpected '${t.value}' (${t.type})`);
  }

  function endsExpr() { const t = peek(); return t.type === 'newline' || t.type === 'rbrace' || t.type === 'eof'; }

  // ( ... )  → object if it contains `key value pairs, else array
  function parseParen() {
    eat('lparen');
    skipNL();
    if (at('rparen')) { next(); return { kind: 'array', elements: [] }; }
    // detect object: first element is  `id <value...>  where the value is a real
    // value start (not a postfix command like ~is / ~for, not an operator)
    const isObject = at('id') && startsValueStrict(peek(1));
    if (isObject) {
      const props = [];
      while (!at('rparen')) {
        const key = eat('id').value;
        const val = parseExpression();
        props.push([key, val]);
        skipNL();
        if (at('comma')) { next(); skipNL(); }
      }
      eat('rparen');
      return { kind: 'object', props };
    }
    // array (also handles a single parenthesized expression as 1-elem array-or-group)
    const elements = [];
    while (!at('rparen')) {
      elements.push(parseExpression());
      skipNL();
      if (at('comma')) { next(); skipNL(); }
    }
    eat('rparen');
    if (elements.length === 1) return { kind: 'group', expr: elements[0] };
    return { kind: 'array', elements };
  }

  // strict value-start: a token that can BEGIN a value (used to tell an object's
  // `key value pair from a postfix expression like `v ~is / `v ~for).
  function startsValueStrict(t) {
    if (t.type === 'num' || t.type === 'str' || t.type === 'id' ||
        t.type === 'lparen' || t.type === 'lbrace' || t.type === 'return') return true;
    if (t.type === 'sys') return t.value === 't' || t.value === 'f' || t.value === 'n' || isTypeName(t.value);
    return false;
  }

  function parseSys() {
    const t = next(); const name = t.value;
    switch (name) {
      case 't': return { kind: 'bool', value: true };
      case 'f': return { kind: 'bool', value: false };
      case 'n': return { kind: 'null' };
      case 'p': return { kind: 'print', arg: endsExpr() ? null : parseExpression() };
      case 'exit': return { kind: 'exit', arg: endsExpr() ? null : parseExpression() };
      case 'e': return { kind: 'error', arg: endsExpr() ? null : parseExpression() };
      case 'deploy': { const cname = eat('id').value; const args = at('lparen') ? parseArgs() : []; return { kind: 'deploy', name: cname, args }; }
      case 'emit': { const ename = eat('id').value; const args = at('lparen') ? parseArgs() : []; return { kind: 'emit', name: ename, args }; }
      case 'grant': { const caller = parseBinaryExpr(4); const kind = at('sys') ? next().value : eat('word').value; const payload = parseExpression(); return { kind: 'grant', caller, modKind: kind, payload }; }
      case 'signal': { const inst = parseBinaryExpr(4); const sig = parseExpression(); return { kind: 'signalcmd', inst, signal: sig }; }
      case 'events': { const inst = parseBinaryExpr(4); return { kind: 'eventscmd', inst }; }
      default:
        if (isTypeName(name)) return { kind: 'typeval', value: name };
        throw perr(`unknown system command '~${name}'`);
    }
  }

  function startsValue(t) {
    return t.type === 'num' || t.type === 'str' || t.type === 'id' ||
      t.type === 'lparen' || t.type === 'lbrace' || t.type === 'sys' || t.type === 'return';
  }
  function isPostfixSys(t) { return t.type === 'sys' && (t.value === 'is' || t.value === 'for'); }

  return parseProgram();
}

const BASE_TYPES = ['string', 'number', 'object', 'array', 'function', 'boolean', 'bool', 'decimal', 'address', 'bytes', 'map'];
function isTypeName(n) { return BASE_TYPES.includes(n) || (n in INT_WIDTHS); }

// ----------------------------------------------------------------------------
// Scope
// ----------------------------------------------------------------------------
class Scope {
  constructor(parent) { this.vars = new Map(); this.types = new Map(); this.parent = parent || null; this.implicit = undefined; }
  get(name) {
    for (let s = this; s; s = s.parent) if (s.vars.has(name)) return s.vars.get(name);
    throw new Error(`Runtime error: undefined identifier \`${name}`);
  }
  has(name) { for (let s = this; s; s = s.parent) if (s.vars.has(name)) return true; return false; }
  define(name, v, type) { this.vars.set(name, v); if (type) this.types.set(name, type); }
  // Reassignment re-coerces to the variable's declared type — so a write to a typed
  // storage field / typed local is bounds-checked, not silently widened.
  assign(name, v) {
    for (let s = this; s; s = s.parent) if (s.vars.has(name)) { s.vars.set(name, s.types.has(name) ? coerce(v, s.types.get(name)) : v); return; }
    this.vars.set(name, v); // define at current scope if new
  }
  getImplicit() { for (let s = this; s; s = s.parent) if (s.implicit !== undefined) return s.implicit; return undefined; }
}

// ----------------------------------------------------------------------------
// Evaluator
// ----------------------------------------------------------------------------
// Per-run contract state: mod grants (address → grants), the executing-instance stack,
// the Verkle-ish state store + coordination log backing the xmbl.* host-import stdlib.
let __grants = new Map();
let __instStack = [];
let __verkle = new Map();
let __coordLog = [];

function evalProgram(ast, out) {
  __grants = new Map();
  __instStack = [];
  __verkle = new Map();
  __coordLog = [];
  const global = new Scope();
  global.define('xmbl', buildStdlib());
  let last;
  try {
    for (const s of ast.body) last = evalNode(s, global, out);
  } catch (e) {
    if (e instanceof ExitSignal) return e.value;
    throw e;
  }
  return last;
}

function evalNode(n, scope, out) {
  switch (n.kind) {
    case 'num': return n.value;
    case 'str': return n.value;
    case 'bool': return n.value;
    case 'null': return NULL;
    case 'typeval': return '~' + n.value;
    case 'ref': return scope.get(n.name);
    case 'group': return evalNode(n.expr, scope, out);

    case 'assign': {
      let v = evalNode(n.value, scope, out);
      if (n.declType) { v = coerce(v, n.declType); scope.define(n.name, v, n.declType); }
      else scope.assign(n.name, v);
      return v;
    }
    case 'exprstmt': return evalNode(n.expr, scope, out);

    case 'array': return n.elements.map(e => evalNode(e, scope, out));
    case 'object': {
      const o = new LObject();
      for (const [k, ve] of n.props) o.set(k, evalNode(ve, scope, out));
      return o;
    }

    case 'fndef': {
      let fn = scope.has(n.name) ? scope.get(n.name) : null;
      if (!(fn instanceof LFunction)) { fn = new LFunction(); scope.define(n.name, fn); }
      fn.add({ params: n.params, body: n.body, closure: scope });
      return fn;
    }
    case 'anonfn': {
      const fn = new LFunction();
      fn.add({ params: [], body: n.body, closure: scope });
      return fn;
    }
    case 'call': {
      const callee = evalNode(n.callee, scope, out);
      const args = n.args.map(a => evalNode(a, scope, out));
      if (callee instanceof LBoundMethod) return callMethod(callee.inst, callee.method, args, out);
      if (callee instanceof LNative) return callee.fn(args, out);
      return callFunction(callee, args, scope, out);
    }

    case 'contract': {
      const def = new LContractDef(n.name);
      def.fields = n.fields;
      for (const m of n.methods) def.methods.set(m.name, m);
      for (const ev of n.events) def.events.set(ev.name, ev);
      def.perms = n.perms;
      for (const h of n.hooks) def.hooks.set(h.on, h);
      def.declScope = scope;
      scope.define(n.name, def);
      return def;
    }
    case 'deploy': {
      const def = scope.get(n.name);
      if (!(def instanceof LContractDef)) throw new Error(`Runtime error: \`${n.name} is not a contract`);
      const state = new Scope(def.declScope || scope);
      for (const f of def.fields) {
        let v = f.init != null ? evalNode(f.init, state, out) : defaultFor(f.type);
        if (f.type) v = coerce(v, f.type);
        state.define(f.name, v, f.type);
      }
      const inst = new LInstance(def, state);
      const args = n.args.map(a => evalNode(a, scope, out));
      if (def.methods.has('init')) callMethod(inst, def.methods.get('init'), args, out);
      return inst;
    }
    case 'emit': {
      const inst = __instStack[__instStack.length - 1];
      if (!inst) throw new Error('Runtime error: ~emit outside a contract method');
      const args = n.args.map(a => evalNode(a, scope, out));
      inst.events.push({ name: n.name, args });
      return NULL;
    }
    case 'grant': {
      const caller = strval(evalNode(n.caller, scope, out));
      const payload = lngStr(evalNode(n.payload, scope, out), false);
      if (!__grants.has(caller)) __grants.set(caller, []);
      __grants.get(caller).push({ kind: n.modKind, payload });
      return NULL;
    }
    case 'signalcmd': {
      const inst = evalNode(n.inst, scope, out);
      const sig = evalNode(n.signal, scope, out);
      if (inst instanceof LInstance && inst.def.hooks.has('signal')) {
        const h = inst.def.hooks.get('signal');
        const child = new Scope(inst.state);
        if (h.params[0]) child.define(h.params[0].name, sig);
        __instStack.push(inst);
        try { evalNode(h.body, child, out); } finally { __instStack.pop(); }
      }
      return NULL;
    }
    case 'eventscmd': {
      const inst = evalNode(n.inst, scope, out);
      return inst instanceof LInstance ? inst.events.map(e => e.name) : [];
    }

    case 'print': {
      const v = n.arg ? evalNode(n.arg, scope, out) : scope.getImplicit();
      out.write(lngStr(v, false) + '\n');
      return v;
    }
    case 'exit': throw new ExitSignal(n.arg ? evalNode(n.arg, scope, out) : NULL);
    // `~e` ABORTS the call — it reverts, it does not evaluate to a discardable value. This is what a
    // require()/revert lowers to, so the throw propagates past every enclosing block exactly as the
    // WASM backend's `unreachable` trap aborts the whole call. (A non-aborting "error value" would let
    // execution continue past a failed precondition — and would disagree with the on-chain backend.)
    case 'error': { const m = n.arg ? evalNode(n.arg, scope, out) : ''; throw new LRevert(typeof m === 'string' ? m : lngStr(m, false)); }
    case 'return': throw new ReturnSignal(n.value ? evalNode(n.value, scope, out) : NULL);

    case 'block': {
      let last = NULL;
      for (const s of n.body) last = evalNode(s, scope, out);
      return last;
    }

    case 'unary': {
      const v = evalNode(n.operand, scope, out);
      if (n.op === '!') return !truthy(v);
      if (n.op === '-') {
        if (v instanceof LInt) return fitInt(-v.v, v.signed, v.bits);
        if (v instanceof LDecimal) return new LDecimal(-v.v);
        return -num(v);
      }
      if (n.op === 'b~') {
        if (v instanceof LInt) return fitInt(-v.v - 1n, v.signed, v.bits);
        return ~num(v);
      }
      break;
    }
    case 'binary': return evalBinary(n.op, n.left, n.right, scope, out);

    case 'ternary': {
      const c = evalNode(n.cond, scope, out);
      const branch = truthy(c) ? n.thenB : n.elseB;
      if (!branch) return NULL;
      // A `{...}` branch is a `block` in then-position but parses as an `anonfn` closure in
      // else-position; both mean "execute this block if taken". Run the anonfn's body rather than
      // returning the unexecuted closure — otherwise an else-block (e.g. an imported if/else) is
      // silently skipped, diverging from the WASM backend, which runs both branches.
      return evalNode(branch.kind === 'anonfn' ? branch.body : branch, scope, out);
    }

    case 'member': {
      const o = evalNode(n.obj, scope, out);
      return memberGet(o, n.name);
    }
    case 'memberexpr': {
      const o = evalNode(n.obj, scope, out);
      const key = evalNode(n.expr, scope, out);
      return memberGet(o, String(key));
    }
    case 'index': {
      const o = evalNode(n.obj, scope, out);
      const idx = evalNode(n.index, scope, out);
      if (Array.isArray(o)) return idx < o.length ? o[idx] : NULL;
      if (typeof o === 'string') return o[idx] ?? '';
      return memberGet(o, String(idx));
    }

    case 'is': {
      const v = evalNode(n.value, scope, out);
      if (!n.typeArg) return typeName(v);
      return coerce(v, n.typeArg);
    }

    case 'forin': {
      const coll = evalNode(n.coll, scope, out);
      const items = iterable(coll);
      let last = NULL;
      for (const item of items) {
        const child = new Scope(scope);
        if (n.asVar) child.define(n.asVar, item);
        else child.implicit = item;
        last = evalNode(n.body, child, out);
      }
      return last;
    }
    case 'countedfor': {
      const start = num(evalNode(n.start, scope, out));
      const end = num(evalNode(n.end, scope, out));
      let last = NULL;
      for (let x = start; x <= end; x++) {
        const child = new Scope(scope);
        child.define(n.varName, x);
        last = evalNode(n.body, child, out);
      }
      return last;
    }
  }
  throw new Error(`Runtime error: cannot evaluate node '${n.kind}'`);
}

function callFunction(fn, args, scope, out) {
  if (!(fn instanceof LFunction)) throw new Error('Runtime error: attempt to call a non-function');
  let ov = fn.overloads.find(o => o.params.length === args.length);
  if (!ov) ov = fn.overloads[fn.overloads.length - 1]; // fallback: last defined
  if (!ov) throw new Error('Runtime error: no matching overload');
  const child = new Scope(ov.closure);
  ov.params.forEach((pp, i) => {
    let a = i < args.length ? args[i] : NULL;
    if (pp.type && a !== NULL) a = coerce(a, pp.type);
    child.define(pp.name, a, pp.type);
  });
  try {
    return evalNode(ov.body, child, out);
  } catch (e) {
    if (e instanceof ReturnSignal) return e.value;
    throw e;
  }
}

// Contract entrypoint call: enforce mod-gated permissions (caller = args[0]), then run
// the method body with the instance's state as scope. Replaces the msg.sender model.
function callMethod(inst, method, args, out) {
  const reqs = inst.def.perms.filter(p => p.method === method.name);
  if (reqs.length) {
    const caller = args.length ? strval(args[0]) : null;
    const grants = (caller && __grants.get(caller)) || [];
    for (const r of reqs) {
      const payload = lngStr(evalNode(r.payload, inst.state, out), false);
      const held = grants.some(g => g.kind === r.kind && g.payload === payload);
      if (!held) throw new LRevert(`unauthorized: \`${method.name} requires mod ${r.kind} '${payload}'`);
    }
  }
  const child = new Scope(inst.state);
  method.params.forEach((pp, i) => { let a = i < args.length ? args[i] : NULL; if (pp.type && a !== NULL) a = coerce(a, pp.type); child.define(pp.name, a, pp.type); });
  __instStack.push(inst);
  try { return evalNode(method.body, child, out); }
  catch (e) { if (e instanceof ReturnSignal) return e.value; throw e; }
  finally { __instStack.pop(); }
}
function defaultFor(type) {
  if (!type) return NULL;
  if (type in INT_WIDTHS) { const [s, b] = INT_WIDTHS[type]; return new LInt(0n, s, b); }
  switch (type) {
    case 'decimal': return new LDecimal(0n);
    case 'bool': case 'boolean': return false;
    case 'map': case 'object': return new LObject();
    case 'array': return [];
    case 'string': return '';
    case 'number': return 0;
    default: return NULL;
  }
}

// ----------------------------------------------------------------------------
// Crypto / geometry stdlib  (`xmbl.*`)
// Decision 4: the geometric + post-quantum primitives are stdlib CALLS, not syntax.
// These are deterministic REFERENCE implementations that pin the semantics; the WASM/XCL
// backend lowers them to the real host imports — xmbl_verkle_get/set, xmbl_cubic_sig_verify,
// xmbl_mayo_verify, xmbl_lwe_decrypt, xmbl_coord_send (see agentic-contracts-proto.md §3.1).
// ----------------------------------------------------------------------------
const MASK64 = 0xFFFFFFFFFFFFFFFFn;
function hashBig(s) { // FNV-1a 64-bit over the value's canonical string
  const str = typeof s === 'string' ? s : lngStr(s, true);
  let h = 1469598103934665603n; const P = 1099511628211n;
  for (let i = 0; i < str.length; i++) { h ^= BigInt(str.charCodeAt(i)); h = (h * P) & MASK64; }
  return h;
}
function modpow(b, e, m) { b %= m; if (b < 0n) b += m; let r = 1n; while (e > 0n) { if (e & 1n) r = (r * b) % m; e >>= 1n; b = (b * b) % m; } return r; }
const SCH_P = 2305843009213693951n; // 2^61 - 1 (Mersenne prime)
const SCH_G = 3n;
const SCH_Q = SCH_P - 1n;
function scalarOf(v) { return (hashBig(strval(v)) % SCH_Q) || 1n; }
function coordStr(c) { // canonical string for a point/coords value
  if (c instanceof LObject) return c.entries().map(([k, v]) => k + ':' + lngStr(v, false)).join(',');
  return lngStr(c, true);
}
function xyz(p) {
  if (p instanceof LObject) return [num(p.get('x')), num(p.get('y')), num(p.get('z'))];
  if (Array.isArray(p)) return [num(p[0]), num(p[1]), num(p[2])];
  return [0, 0, 0];
}
function obj(pairs) { const o = new LObject(); for (const [k, v] of pairs) o.set(k, v); return o; }
function buildStdlib() {
  const geo = obj([
    ['coord', new LNative('geo.coord', (a) => { // (face, position) → (x,y,z), origin at face 1 pos 4
      const face = num(a[0]), pos = num(a[1]); const col = pos % 3, row = Math.floor(pos / 3);
      return obj([['x', col - 1], ['y', 1 - row], ['z', face - 1]]);
    })],
  ]);
  const cubic = obj([
    ['curve', new LNative('cubic.curve', (a) => { // 3 non-collinear points → E: y²=x³+ax+b, non-singular
      const [p1, p2, p3] = [xyz(a[0]), xyz(a[1]), xyz(a[2])];
      const d12 = [p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]];
      const d13 = [p3[0] - p1[0], p3[1] - p1[1], p3[2] - p1[2]];
      const nx = d12[1] * d13[2] - d12[2] * d13[1], ny = d12[2] * d13[0] - d12[0] * d13[2], nz = d12[0] * d13[1] - d12[1] * d13[0];
      let seed = hashBig(`${nx},${ny},${nz},${coordStr(a[0])},${coordStr(a[1])},${coordStr(a[2])}`) % SCH_P;
      let aa = seed % SCH_P, bb = (seed * seed + 7n) % SCH_P, tries = 0;
      while (((4n * aa * aa % SCH_P * aa % SCH_P) + (27n * bb % SCH_P * bb % SCH_P)) % SCH_P === 0n && tries < 8) { seed = (seed + 1n) % SCH_P; aa = seed % SCH_P; bb = (seed * seed + 7n) % SCH_P; tries++; }
      const collinear = nx === 0 && ny === 0 && nz === 0;
      return obj([['nx', nx], ['ny', ny], ['nz', nz], ['a', aa.toString()], ['b', bb.toString()], ['nonSingular', !collinear], ['collinear', collinear]]);
    })],
    ['pk', new LNative('cubic.pk', (a) => modpow(SCH_G, scalarOf(a[0]), SCH_P).toString())],
    ['sign', new LNative('cubic.sign', (a) => { // (msg, sk, coords) → Schnorr sig bound to the plane
      const msg = a[0], sk = a[1], cs = hashBig(coordStr(a[2])) % SCH_Q;
      const x = scalarOf(sk);
      const k = (hashBig(strval(sk) + '|' + strval(msg) + '|' + cs) % SCH_Q) || 1n;
      const R = modpow(SCH_G, k, SCH_P);
      const e = hashBig(R + '|' + strval(msg) + '|' + cs) % SCH_Q;
      const s = (k + e * x) % SCH_Q;
      return obj([['R', R.toString()], ['s', s.toString()], ['cs', cs.toString()]]);
    })],
    ['verify', new LNative('cubic.verify', (a) => { // (msg, sig, pk, coords) → replay from other coords fails
      const msg = a[0], sig = a[1], pk = BigInt(strval(a[2])), cs = hashBig(coordStr(a[3])) % SCH_Q;
      if (!(sig instanceof LObject)) return false;
      if (BigInt(strval(sig.get('cs'))) !== cs) return false; // geometric binding
      const R = BigInt(strval(sig.get('R'))), s = BigInt(strval(sig.get('s')));
      const e = hashBig(R + '|' + strval(msg) + '|' + cs) % SCH_Q;
      return modpow(SCH_G, s, SCH_P) === (R * modpow(pk, e, SCH_P)) % SCH_P;
    })],
  ]);
  const mayo = obj([
    ['pk', new LNative('mayo.pk', (a) => hashBig(strval(a[0])).toString())],
    ['sign', new LNative('mayo.sign', (a) => hashBig(strval(a[0]) + '|' + hashBig(strval(a[1]))).toString())],
    ['verify', new LNative('mayo.verify', (a) => hashBig(strval(a[0]) + '|' + BigInt(strval(a[2]))).toString() === strval(a[1]))],
  ]);
  const lwe = obj([
    ['pk', new LNative('lwe.pk', (a) => hashBig(strval(a[0])).toString())],
    ['encrypt', new LNative('lwe.encrypt', (a) => lweStream(strval(a[0]), BigInt(strval(a[1])), true))],
    ['decrypt', new LNative('lwe.decrypt', (a) => lweStream(strval(a[0]), hashBig(strval(a[1])), false))],
  ]);
  const verkle = obj([
    ['set', new LNative('verkle.set', (a) => { __verkle.set(strval(a[0]), a[1]); return verkleRoot(); })],
    ['get', new LNative('verkle.get', (a) => __verkle.has(strval(a[0])) ? __verkle.get(strval(a[0])) : NULL)],
    ['root', new LNative('verkle.root', () => verkleRoot())],
  ]);
  const coord = obj([
    ['send', new LNative('coord.send', (a) => { __coordLog.push({ dest: strval(a[0]), envelope: a[1] }); return true; })],
    ['log', new LNative('coord.log', () => __coordLog.map(m => m.dest))],
  ]);
  return obj([['geo', geo], ['cubic', cubic], ['mayo', mayo], ['lwe', lwe], ['verkle', verkle], ['coord', coord]]);
}
function verkleRoot() { const parts = [...__verkle.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1).map(([k, v]) => k + '=' + lngStr(v, true)); return '0x' + hashBig(parts.join('|')).toString(16); }
function lweStream(input, keyBig, enc) { // ternary-lattice-flavored stream cipher (reference KEM)
  let st = keyBig || 1n; const nextByte = () => { st = (st * 6364136223846793005n + 1442695040888963407n) & MASK64; return Number((st >> 33n) & 0xFFn); };
  if (enc) { let hex = ''; for (let i = 0; i < input.length; i++) hex += ((input.charCodeAt(i) ^ nextByte()) & 0xFF).toString(16).padStart(2, '0'); return hex; }
  let out = ''; for (let i = 0; i < input.length; i += 2) out += String.fromCharCode((parseInt(input.substr(i, 2), 16) ^ nextByte()) & 0xFF); return out;
}

function evalBinary(op, ln, rn, scope, out) {
  // short-circuit logical
  if (op === '&') return truthy(evalNode(ln, scope, out)) ? truthy(evalNode(rn, scope, out)) : false;
  if (op === '|') { const l = evalNode(ln, scope, out); return truthy(l) ? true : truthy(evalNode(rn, scope, out)); }
  const l = evalNode(ln, scope, out), r = evalNode(rn, scope, out);
  if (op === '+' && (typeof l === 'string' || typeof r === 'string')) return lngStr(l, false) + lngStr(r, false);
  if (isTypedNum(l) || isTypedNum(r)) return typedBinary(op, l, r);
  switch (op) {
    case '+': return (typeof l === 'string' || typeof r === 'string') ? lngStr(l, false) + lngStr(r, false) : num(l) + num(r);
    case '-': return num(l) - num(r);
    case '*': return num(l) * num(r);
    case '/': return num(l) / num(r);
    case '%': return num(l) % num(r);
    case '==': return eq(l, r);
    case '!==': return !eq(l, r);
    case '>': return num(l) > num(r);
    case '<': return num(l) < num(r);
    case '!>': return num(l) <= num(r);
    case '!<': return num(l) >= num(r);
    case 'b&': return num(l) & num(r);
    case 'b|': return num(l) | num(r);
    case 'b^': return num(l) ^ num(r);
    case 'b<': return num(l) << num(r);
    case 'b>': return num(l) >> num(r);
  }
  throw new Error(`Runtime error: unknown operator ${op}`);
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function truthy(v) {
  if (v === true) return true;
  if (v === false) return false;
  if (v === NULL) return false;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v.length > 0;
  if (v instanceof LInt || v instanceof LDecimal) return v.v !== 0n;
  return true;
}
function num(v) {
  if (typeof v === 'number') return v;
  if (v instanceof LInt) return Number(v.v);
  if (v instanceof LDecimal) return Number(v.v) / Number(DEC_ONE);
  if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) return Number(v);
  if (v === true) return 1; if (v === false || v === NULL) return 0;
  throw new Error(`Runtime error: '${lngStr(v, true)}' is not a number`);
}
function eq(l, r) {
  if (isTypedNum(l) || isTypedNum(r)) { try { return toScaled(l) === toScaled(r); } catch { return false; } }
  if (l === NULL || r === NULL) return l === r;
  return l === r;
}

// --- typed numeric helpers ---
function isTypedNum(v) { return v instanceof LInt || v instanceof LDecimal; }
function toBig(v) {
  if (v instanceof LInt) return v.v;
  if (v instanceof LDecimal) { if (v.v % DEC_ONE !== 0n) throw new LRevert('cannot use fractional ~decimal as an integer'); return v.v / DEC_ONE; }
  if (typeof v === 'number') { if (!Number.isInteger(v)) throw new LRevert(`cannot use fractional number ${v} as an integer`); return BigInt(v); }
  if (typeof v === 'string') { const s = v.trim(); if (!/^-?\d+$/.test(s)) throw new LRevert(`'${v}' is not an integer`); return BigInt(s); }
  if (v === true) return 1n; if (v === false || v === NULL) return 0n;
  throw new LRevert('not an integer');
}
function parseDecimalStr(s) {
  s = s.trim();
  const neg = s[0] === '-'; if (neg || s[0] === '+') s = s.slice(1);
  const [ip = '0', fp = ''] = s.split('.');
  if (!/^\d*$/.test(ip) || !/^\d*$/.test(fp)) throw new LRevert(`'${s}' is not a decimal`);
  const frac = (fp + '0'.repeat(18)).slice(0, 18);
  const val = BigInt(ip || '0') * DEC_ONE + BigInt(frac || '0');
  return new LDecimal(neg ? -val : val);
}
function toDecimal(v) {
  if (v instanceof LDecimal) return v;
  if (v instanceof LInt) return new LDecimal(v.v * DEC_ONE);
  if (typeof v === 'number') return parseDecimalStr(String(v));
  if (typeof v === 'string') return parseDecimalStr(v);
  if (v === true) return new LDecimal(DEC_ONE); if (v === false || v === NULL) return new LDecimal(0n);
  throw new LRevert('cannot coerce to ~decimal');
}
function toScaled(v) { // common denominator (×10^18) for cross-type comparison
  if (v instanceof LDecimal) return v.v;
  if (v instanceof LInt) return v.v * DEC_ONE;
  if (typeof v === 'number') return parseDecimalStr(String(v)).v;
  if (v === true) return DEC_ONE; if (v === false || v === NULL) return 0n;
  throw new LRevert('not numeric');
}
function toNum(v) { return num(v); }
function strval(v) { if (v instanceof LTyped) return v.value; if (typeof v === 'string') return v; return lngStr(v, false); }
function formatDecimal(scaled) {
  const neg = scaled < 0n; let a = neg ? -scaled : scaled;
  const ip = a / DEC_ONE; let frac = (a % DEC_ONE).toString().padStart(18, '0').replace(/0+$/, '');
  return (neg ? '-' : '') + ip.toString() + (frac ? '.' + frac : '');
}
function typedBinary(op, l, r) {
  // comparisons work across int/decimal via the ×10^18 common scale
  if (['==', '!==', '>', '<', '!>', '!<'].includes(op)) {
    const a = toScaled(l), b = toScaled(r);
    switch (op) { case '==': return a === b; case '!==': return a !== b; case '>': return a > b; case '<': return a < b; case '!>': return a <= b; case '!<': return a >= b; }
  }
  const decimalMode = l instanceof LDecimal || r instanceof LDecimal;
  if (decimalMode) {
    if (l instanceof LInt || r instanceof LInt) throw new LRevert('cannot mix ~decimal and integer; coerce explicitly with ~is');
    const a = toDecimal(l).v, b = toDecimal(r).v;
    switch (op) {
      case '+': return new LDecimal(a + b);
      case '-': return new LDecimal(a - b);
      case '*': return new LDecimal((a * b) / DEC_ONE);
      case '/': if (b === 0n) throw new LRevert('division by zero'); return new LDecimal((a * DEC_ONE) / b);
      case '%': if (b === 0n) throw new LRevert('division by zero'); return new LDecimal(a % b);
    }
    throw new LRevert(`operator ${op} not valid on ~decimal`);
  }
  // integer mode: pick result type (same signedness required; wider bits wins)
  const li = l instanceof LInt ? l : null, ri = r instanceof LInt ? r : null;
  const ref = li && ri ? (li.signed !== ri.signed ? mixErr() : (li.bits >= ri.bits ? li : ri)) : (li || ri);
  function mixErr() { throw new LRevert('cannot mix signed and unsigned integers; coerce explicitly'); }
  const a = toBig(l), b = toBig(r);
  let res;
  switch (op) {
    case '+': res = a + b; break;
    case '-': res = a - b; break;
    case '*': res = a * b; break;
    case '/': if (b === 0n) throw new LRevert('division by zero'); res = a / b; break;
    case '%': if (b === 0n) throw new LRevert('division by zero'); res = a % b; break;
    case 'b&': res = a & b; break;
    case 'b|': res = a | b; break;
    case 'b^': res = a ^ b; break;
    case 'b<': res = a << b; break;
    case 'b>': res = a >> b; break;
    default: throw new LRevert(`operator ${op} not valid on integers`);
  }
  return fitInt(res, ref.signed, ref.bits);
}
function iterable(v) {
  if (Array.isArray(v)) return v;
  if (v instanceof LObject) return v.entries().map(([, val]) => val);
  if (typeof v === 'string') return v.split('');
  return [v];
}
function memberGet(o, name) {
  if (o instanceof LInstance) {
    if (o.def.methods.has(name)) return new LBoundMethod(o, o.def.methods.get(name));
    if (o.state.vars.has(name)) return o.state.vars.get(name); // own state fields only
    return NULL;
  }
  if (o instanceof LObject) return o.has(name) ? o.get(name) : NULL;
  if (Array.isArray(o)) { const i = Number(name); return Number.isInteger(i) && i < o.length ? o[i] : NULL; }
  return NULL;
}
function typeName(v) {
  if (v === NULL) return '~n';
  if (v === true || v === false) return '~boolean';
  if (v instanceof LInt) return v.typeName;
  if (v instanceof LDecimal) return '~decimal';
  if (v instanceof LTyped) return '~' + v.t;
  if (typeof v === 'number') return '~number';
  if (typeof v === 'string') return '~string';
  if (Array.isArray(v)) return '~array';
  if (v instanceof LObject) return '~object';
  if (v instanceof LInstance) return '~' + v.def.name;
  if (v instanceof LContractDef) return '~contract';
  if (v instanceof LBoundMethod || v instanceof LFunction || v instanceof LNative) return '~function';
  if (v instanceof LError) return '~e';
  return '~n';
}
function coerce(v, type) {
  if (type in INT_WIDTHS) { const [s, b] = INT_WIDTHS[type]; return fitInt(toBig(v), s, b); }
  switch (type) {
    case 'decimal': return toDecimal(v);
    case 'address': { const s = strval(v); if (!/^0x[0-9a-fA-F]{40}$/.test(s)) throw new LRevert(`invalid ~address: '${s}'`); return new LTyped('address', s.toLowerCase()); }
    case 'bytes': { const s = strval(v); if (!/^0x[0-9a-fA-F]*$/.test(s)) throw new LRevert(`invalid ~bytes: '${s}'`); return new LTyped('bytes', s.toLowerCase()); }
    case 'bool': case 'boolean': return truthy(v);
    case 'map': { if (v instanceof LObject) return v; const o = new LObject(); if (Array.isArray(v)) v.forEach((x, i) => o.set(String(i), x)); return o; }
    case 'number': return num(v);
    case 'string': return lngStr(v, false);
    default: return v; // object / array / function keep identity
  }
}
function lngStr(v, quoted) {
  if (v === NULL || v === undefined) return '~n';
  if (v === true) return '~t';
  if (v === false) return '~f';
  if (v instanceof LInt) return v.v.toString();
  if (v instanceof LDecimal) return formatDecimal(v.v);
  if (v instanceof LTyped) return v.value;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return quoted ? `'${v}'` : v;
  if (Array.isArray(v)) return '(' + v.map(x => lngStr(x, true)).join(', ') + ')';
  if (v instanceof LObject) return '(' + v.entries().map(([k, val]) => `\`${k} ${lngStr(val, true)}`).join(', ') + ')';
  if (v instanceof LFunction || v instanceof LBoundMethod || v instanceof LNative) return '~function';
  if (v instanceof LInstance) return `(${v.def.name} instance)`;
  if (v instanceof LContractDef) return `~contract ${v.name}`;
  if (v instanceof LError) return `~e '${v.message}'`;
  return String(v);
}

// ----------------------------------------------------------------------------
// Public API + CLI
// ----------------------------------------------------------------------------
function run(src, out) {
  out = out || process.stdout;
  const ast = parse(lex(src));
  return evalProgram(ast, out);
}

export { run, lex, parse, INT_WIDTHS, isTypeName, intRange, DEC_ONE };