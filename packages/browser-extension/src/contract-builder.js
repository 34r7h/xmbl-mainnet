// MODEL ⇄ SOURCE — the visual builder and the code editor are two editors over ONE thing: the LNG
// source. `parseToModel` derives an editable structural model from the compiler's OWN AST;
// `modelToSource` regenerates source from the model. Lifted verbatim from the miniapp Contract Lab
// (apps/app-builder/miniapp/contract-lab.js), where verify-contract-lab.mjs round-trips every
// sample (source → model → source → compile → identical behavior) so the two never drift. Pure
// functions (no DOM) — Vue renders the model; these only translate.
import { lex, parse } from './contract-runtime.js'

const isNum = (s) => /^\d+$/.test(String(s).trim())
const operandSrc = (s) => { s = String(s == null ? '' : s).trim(); return isNum(s) ? s : '`' + s }
const exprSrc = (e) => (!e || !e.op) ? operandSrc(e ? e.a : '0') : operandSrc(e.a) + ' ' + e.op + ' ' + operandSrc(e.b)
function stmtSrc (s) {
  if (s.t === 'set') return '`' + s.field + ' = ' + exprSrc(s.expr)
  if (s.t === 'local') return '`' + s.name + ' ~' + (s.type || 'u256') + ' ' + exprSrc(s.expr)
  if (s.t === 'return') return 'return ' + exprSrc(s.expr)
  if (s.t === 'emit') return '~emit `' + s.event + '(' + (s.args || []).map(operandSrc).join(', ') + ')'
  if (s.t === 'branch') return exprSrc(s.cond) + ' ? { ' + (s.then || []).map(stmtSrc).join('; ') + ' } | { ' + (s.els || []).map(stmtSrc).join('; ') + ' }'
  if (s.t === 'loop') return '~for `' + s.varName + ' ' + operandSrc(s.start) + ' ' + operandSrc(s.end) + ' { ' + (s.body || []).map(stmtSrc).join('; ') + ' }'
  return ''
}
export function modelToSource (m) {
  const pad = '  '
  const fsrc = (f) => '`' + f.name + ' ~' + (f.type || 'u256') + ' ' + (f.init === '' || f.init == null ? '0' : f.init)
  const out = ['~contract `' + (m.name || 'Contract') + ' {']
  if (m.fields && m.fields.length) {
    out.push(pad + '~state {')
    const pub = m.fields.filter((f) => f.vis !== 'private'), pri = m.fields.filter((f) => f.vis === 'private')
    if (pub.length) out.push(pad + pad + '~public { ' + pub.map(fsrc).join('\n' + pad + pad + '           ') + ' }')
    if (pri.length) out.push(pad + pad + '~private { ' + pri.map(fsrc).join('\n' + pad + pad + '            ') + ' }')
    out.push(pad + '}')
  }
  for (const e of (m.events || [])) out.push(pad + '~event `' + e.name + '(' + (e.params || []).map((p) => '`' + p.name + ' ~' + (p.type || 'u256')).join(', ') + ')')
  for (const mth of (m.methods || [])) {
    const ps = (mth.params || []).map((p) => '`' + p.name + ' ~' + (p.type || 'u256')).join(', ')
    if (mth.advanced && mth.raw != null) { out.push(pad + '~on `' + mth.name + '(' + ps + ') { ' + mth.raw + ' }'); continue }
    out.push(pad + '~on `' + mth.name + '(' + ps + ') {')
    for (const s of (mth.stmts || [])) out.push(pad + pad + stmtSrc(s))
    out.push(pad + '}')
  }
  out.push('}')
  return out.join('\n')
}

// AST → model (best-effort; a method body the structural editor can't represent is kept whole as
// `advanced` with regenerated `raw`, and the visual editor shows it read-only with a code-mode hint).
const astToOperand = (n) => {
  if (!n) return '0'
  if (n.kind === 'group') return astToOperand(n.expr)
  if (n.kind === 'num') return String(n.value)
  if (n.kind === 'ref') return n.name
  throw new Error('non-simple operand')
}
const astToExpr = (n) => {
  if (!n) return { a: '0', op: '', b: '' }
  if (n.kind === 'group') return astToExpr(n.expr)
  if (n.kind === 'binary') return { a: astToOperand(n.left), op: n.op, b: astToOperand(n.right) }
  return { a: astToOperand(n), op: '', b: '' }
}
const asBlockBody = (b) => {
  if (!b) return []
  if (b.kind === 'anonfn') return asBlockBody(b.body)
  if (b.kind === 'block') return b.body
  return [{ kind: 'exprstmt', expr: b }]
}
function nodesToStmts (nodes) {
  return nodes.map((n) => {
    if (n.kind === 'assign' && n.declType) return { t: 'local', name: n.name, type: n.declType, expr: astToExpr(n.value) }
    if (n.kind === 'assign') return { t: 'set', field: n.name, expr: astToExpr(n.value) }
    if (n.kind === 'return') return { t: 'return', expr: astToExpr(n.value) }
    if (n.kind === 'countedfor') return { t: 'loop', varName: n.varName, start: astToOperand(n.start), end: astToOperand(n.end), body: nodesToStmts(n.body.body) }
    if (n.kind === 'exprstmt') {
      const e = n.expr
      if (e.kind === 'emit') return { t: 'emit', event: e.name, args: e.args.map(astToOperand) }
      if (e.kind === 'return') return { t: 'return', expr: astToExpr(e.value) }
      if (e.kind === 'ternary') return { t: 'branch', cond: astToExpr(e.cond), then: nodesToStmts(asBlockBody(e.thenB)), els: nodesToStmts(asBlockBody(e.elseB)) }
    }
    throw new Error('unrepresentable statement: ' + n.kind)
  })
}
// A generic AST→source printer, used only to preserve `advanced` method bodies verbatim.
function astExprSrc (n) {
  if (!n) return ''
  switch (n.kind) {
    case 'num': return String(n.value)
    case 'ref': return '`' + n.name
    case 'group': return '(' + astExprSrc(n.expr) + ')'
    case 'unary': return (n.op || '') + astExprSrc(n.operand)
    case 'binary': return astExprSrc(n.left) + ' ' + n.op + ' ' + astExprSrc(n.right)
    case 'emit': return '~emit `' + n.name + '(' + (n.args || []).map(astExprSrc).join(', ') + ')'
    case 'return': return 'return ' + astExprSrc(n.value)
    case 'ternary': return astExprSrc(n.cond) + ' ? { ' + astStmtSrc(asBlockBody(n.thenB)) + ' } | { ' + astStmtSrc(asBlockBody(n.elseB)) + ' }'
    case 'call': return astExprSrc(n.callee) + '(' + (n.args || []).map(astExprSrc).join(', ') + ')'
    default: return ''
  }
}
function astStmtSrc (nodes) {
  return nodes.map((n) => {
    if (n.kind === 'assign' && n.declType) return '`' + n.name + ' ~' + n.declType + ' ' + astExprSrc(n.value)
    if (n.kind === 'assign') return '`' + n.name + ' = ' + astExprSrc(n.value)
    if (n.kind === 'return') return 'return ' + astExprSrc(n.value)
    if (n.kind === 'countedfor') return '~for `' + n.varName + ' ' + astExprSrc(n.start) + ' ' + astExprSrc(n.end) + ' { ' + astStmtSrc(n.body.body) + ' }'
    if (n.kind === 'exprstmt') return astExprSrc(n.expr)
    return ''
  }).join('; ')
}
export function parseToModel (src) {
  const c = parse(lex(src)).body.find((n) => n.kind === 'contract')
  if (!c) throw new Error('no ~contract found')
  const fields = c.fields.map((f) => ({ name: f.name, type: f.type || 'u256', init: f.init ? astExprSrc(f.init).replace(/^`/, '') : '0', vis: f.vis || 'public' }))
  const events = c.events.map((e) => ({ name: e.name, params: e.params.map((p) => ({ name: p.name, type: p.type || 'u256' })) }))
  const methods = c.methods.map((m) => {
    const params = m.params.map((p) => ({ name: p.name, type: p.type || 'u256' }))
    try { return { name: m.name, params, stmts: nodesToStmts(m.body.body) } }
    catch { return { name: m.name, params, advanced: true, raw: astStmtSrc(m.body.body), stmts: [] } }
  })
  return { name: c.name, fields, events, methods }
}
