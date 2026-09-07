/*
 * LNG static type-checker (best-effort).
 *
 * A pass over the AST that catches type errors WITHOUT running the program — the
 * front-line for the on-chain determinism guarantees (decision 2). It reports:
 *   - a fractional / float literal used to initialize an integer type
 *   - a compile-time-constant integer that overflows its declared type
 *   - mixing ~decimal with an integer type in one arithmetic expression
 *   - bitwise operators applied to non-integer operands
 *   - a float (fractional) literal inside integer arithmetic
 *
 * It is intentionally conservative: anything it cannot prove is treated as
 * 'unknown' and left to the runtime's checked arithmetic. Returns a list of
 * { line, message } diagnostics.
 *
 * API:    import { check, checkDeterminism, assertDeterministic } from '@xmbl/lng';
 */
import { lex, parse, INT_WIDTHS, isTypeName, intRange } from './lng.js';
const isInt = (t) => typeof t === 'string' && (t in INT_WIDTHS);

function check(src) {
  const ast = parse(lex(src));
  const diags = [];
  const err = (line, message) => diags.push({ line: line || 0, message });

  // Fold an expression to a constant BigInt when possible (integers only).
  function fold(n, env) {
    if (!n) return null;
    if (n.kind === 'num') return n.fractional ? null : BigInt(n.value);
    if (n.kind === 'group') return fold(n.expr, env);
    if (n.kind === 'unary' && n.op === '-') { const x = fold(n.operand, env); return x == null ? null : -x; }
    if (n.kind === 'binary') {
      const a = fold(n.left, env), b = fold(n.right, env);
      if (a == null || b == null) return null;
      switch (n.op) {
        case '+': return a + b; case '-': return a - b; case '*': return a * b;
        case '/': return b === 0n ? null : a / b; case '%': return b === 0n ? null : a % b;
      }
    }
    return null;
  }

  // Infer a coarse type descriptor for an expression.
  function infer(n, env) {
    switch (n.kind) {
      case 'num': return n.fractional ? 'number' : 'intlit';
      case 'str': return 'string';
      case 'bool': return 'bool';
      case 'null': return 'null';
      case 'typeval': return 'type';
      case 'ref': return env[n.name] || 'unknown';
      case 'group': return infer(n.expr, env);
      case 'array': return 'array';
      case 'object': return 'object';
      case 'anonfn': return 'function';
      case 'is': return n.typeArg ? n.typeArg : 'string';
      case 'unary': return n.op === '!' ? 'bool' : infer(n.operand, env);
      case 'ternary': { const a = infer(n.thenB, env), b = infer(n.elseB || n.thenB, env); return a === b ? a : 'unknown'; }
      case 'binary': {
        if (['==', '!==', '>', '<', '!>', '!<', '&', '|'].includes(n.op)) return 'bool';
        return combine(n, env);
      }
      default: return 'unknown';
    }
  }

  function combine(n, env) {
    const lt = infer(n.left, env), rt = infer(n.right, env);
    const bitwise = n.op.startsWith('b');
    // string concat
    if (n.op === '+' && (lt === 'string' || rt === 'string')) return 'string';
    // decimal / int mix
    const lInt = isInt(lt), rInt = isInt(rt);
    if ((lt === 'decimal' && rInt) || (rt === 'decimal' && lInt)) { err(lineOf(n), `mixes ~decimal with an integer type (${lInt ? lt : rt}); coerce explicitly with ~is`); return 'unknown'; }
    if (bitwise && (lt === 'decimal' || rt === 'decimal' || lt === 'number' || rt === 'number')) err(lineOf(n), `bitwise ${n.op} requires integer operands`);
    // float literal in integer arithmetic
    if ((lInt && rt === 'number') || (rInt && lt === 'number')) err(lineOf(n), `float used in integer arithmetic; on-chain code must stay integer / ~decimal`);
    if (lt === 'decimal' || rt === 'decimal') return 'decimal';
    if (lInt && rInt) { if (INT_WIDTHS[lt][0] !== INT_WIDTHS[rt][0]) err(lineOf(n), `mixes signed and unsigned integers (${lt}, ${rt})`); return INT_WIDTHS[lt][1] >= INT_WIDTHS[rt][1] ? lt : rt; }
    if (lInt) return lt; if (rInt) return rt;
    if (lt === 'intlit' && rt === 'intlit') return 'intlit';
    if (lt === 'number' || rt === 'number') return 'number';
    return 'unknown';
  }
  function lineOf(n) { return (n.left && n.left.line) || (n.right && n.right.line) || 0; }

  // Check a typed declaration's initializer.
  function checkDecl(name, type, valueNode, line, env) {
    if (!isTypeName(type)) { err(line, `unknown type ~${type}`); return; }
    if (type in INT_WIDTHS) {
      // fractional literal?
      if (isDeepFractional(valueNode)) { err(line, `\`${name} ~${type} initialized with a fractional value — ${type} is an integer type`); }
      else {
        const c = fold(valueNode, env);
        if (c != null) { const [lo, hi] = intRange(...INT_WIDTHS[type]); if (c < lo || c > hi) err(line, `\`${name} ~${type} = ${c} overflows [${lo}, ${hi}]`); }
        const vt = infer(valueNode, env);
        if (vt === 'decimal') err(line, `\`${name} ~${type} initialized from ~decimal without coercion`);
      }
    }
  }
  function isDeepFractional(n) {
    if (!n) return false;
    if (n.kind === 'num') return n.fractional;
    if (n.kind === 'group') return isDeepFractional(n.expr);
    if (n.kind === 'unary') return isDeepFractional(n.operand);
    return false;
  }

  function walk(nodes, env) {
    for (const n of nodes) walkNode(n, env);
  }
  function walkNode(n, env) {
    switch (n.kind) {
      case 'assign':
        walkExpr(n.value, env);
        if (n.declType) { checkDecl(n.name, n.declType, n.value, n.line, env); env[n.name] = n.declType; }
        else env[n.name] = infer(n.value, env);
        break;
      case 'fndef': {
        const child = Object.create(env);
        for (const p of n.params) child[p.name] = p.type || 'unknown';
        walkNode(n.body, child);
        env[n.name] = 'function';
        break;
      }
      case 'block': { const child = Object.create(env); walk(n.body, child); break; }
      case 'exprstmt': walkExpr(n.expr, env); break;
      case 'forin': { walkExpr(n.coll, env); const child = Object.create(env); if (n.asVar) child[n.asVar] = 'unknown'; walkNode(n.body, child); break; }
      case 'countedfor': { walkExpr(n.start, env); walkExpr(n.end, env); const child = Object.create(env); child[n.varName] = 'intlit'; walkNode(n.body, child); break; }
      default: walkExpr(n, env);
    }
  }
  function walkExpr(n, env) {
    if (!n || typeof n !== 'object') return;
    if (n.kind === 'binary') { infer(n, env); walkExpr(n.left, env); walkExpr(n.right, env); return; }
    if (n.kind === 'block') { walkNode(n, env); return; }
    for (const k of ['arg', 'value', 'expr', 'operand', 'cond', 'thenB', 'elseB', 'obj', 'coll', 'callee', 'left', 'right', 'index', 'start', 'end', 'body']) if (n[k]) walkExpr(n[k], env);
    for (const k of ['elements', 'args']) if (Array.isArray(n[k])) n[k].forEach(x => walkExpr(x, env));
    if (Array.isArray(n.props)) n.props.forEach(([, v]) => walkExpr(v, env));
  }

  walk(ast.body, Object.create(null));
  return diags;
}

// ----------------------------------------------------------------------------
// Determinism gate
// ----------------------------------------------------------------------------
// On-chain code (inside a ~contract) must be a pure function of its inputs and state,
// or validators diverge and consensus breaks. This walks ONLY contract bodies and
// rejects the non-deterministic constructs: IEEE floats (~number / fractional literals),
// on-chain stdout (~p), and references to impure stdlib roots (clock/random/network/
// filesystem/AI). The xmbl.* stdlib is deterministic and allowed.
const IMPURE_ROOTS = new Set(['time', 'clock', 'now', 'rand', 'random', 'net', 'http', 'tcp', 'udp', 'fs', 'file', 'ai', 'nn']);

function checkDeterminism(src) {
  const ast = parse(lex(src));
  const diags = [];
  const err = (line, message) => diags.push({ line: line || 0, message });

  function rootOf(n) { while (n && (n.kind === 'member' || n.kind === 'memberexpr' || n.kind === 'index' || n.kind === 'call')) n = n.obj || n.callee; return n && n.kind === 'ref' ? n.name : null; }

  // dec = "decimal context": a fractional literal is exact fixed-point there (~decimal),
  // not an IEEE float, so it is deterministic and allowed.
  function scanExpr(n, dec) {
    if (!n || typeof n !== 'object') return;
    if (n.kind === 'num' && n.fractional && !dec) err(n.line, `float literal ${n.value} is non-deterministic on-chain — use an integer or ~decimal`);
    if (n.kind === 'print') err(0, `~p (stdout) is not available on-chain — emit an event instead`);
    if (n.kind === 'is' && n.typeArg === 'decimal') dec = true;
    if (n.kind === 'call') { const r = rootOf(n.callee); if (r && IMPURE_ROOTS.has(r)) err(0, `\`${r} is a non-deterministic (off-chain-only) stdlib and cannot run on-chain`); }
    if ((n.kind === 'member' || n.kind === 'memberexpr') && n.obj && n.obj.kind === 'ref' && IMPURE_ROOTS.has(n.obj.name)) err(0, `\`${n.obj.name} is a non-deterministic (off-chain-only) stdlib and cannot run on-chain`);
    for (const k of ['arg', 'value', 'expr', 'operand', 'cond', 'thenB', 'elseB', 'obj', 'coll', 'callee', 'left', 'right', 'index', 'start', 'end', 'body']) if (n[k]) scanExpr(n[k], dec);
    for (const k of ['elements', 'args', 'body']) if (Array.isArray(n[k])) n[k].forEach(x => scanExpr(x, dec));
    if (Array.isArray(n.props)) n.props.forEach(([, v]) => scanExpr(v, dec));
  }
  function scanStmts(nodes) { for (const s of nodes) scanStmt(s); }
  function scanStmt(s) {
    if (!s) return;
    if (s.kind === 'assign') { if (s.declType === 'number') err(s.line, `\`${s.name} ~number (float) is non-deterministic on-chain — use a checked integer or ~decimal`); scanExpr(s.value, s.declType === 'decimal'); return; }
    if (s.kind === 'block') return scanStmts(s.body);
    if (s.kind === 'countedfor') { scanExpr(s.start); scanExpr(s.end); return scanStmts(s.body.body); }
    if (s.kind === 'forin') { scanExpr(s.coll); return scanStmt(s.body); }
    scanExpr(s);
  }

  for (const c of ast.body.filter(n => n.kind === 'contract')) {
    for (const f of c.fields) { if (f.type === 'number') err(0, `state field \`${f.name} ~number (float) is non-deterministic on-chain`); if (f.init) scanExpr(f.init, f.type === 'decimal'); }
    for (const m of c.methods) { for (const p of m.params) if (p.type === 'number') err(0, `param \`${p.name} ~number (float) is non-deterministic on-chain`); scanStmts(m.body.body); }
    for (const h of c.hooks) scanStmts(h.body.body);
  }
  return diags;
}

// Throw if on-chain code is non-deterministic — the compile gate the backends call.
function assertDeterministic(src, backend) {
  const d = checkDeterminism(src);
  if (d.length) throw new Error(`${backend || 'compile'} refused — non-deterministic on-chain code:\n` + d.map(x => `  ${x.line ? 'line ' + x.line + ': ' : ''}${x.message}`).join('\n'));
}

export { check, checkDeterminism, assertDeterministic };