// Deterministic algebra checking for proofs: LaTeX maths → mathjs expressions, then every =, <, ≤, >, ≥
// link is evaluated at random points. Sampling can refute a step but never prove it, so results say
// "checked numerically", and anything that can't be converted is "unknown", never a false failure.
import { all, create, EvalFunction, MathNode } from 'mathjs'

const math = create(all)

// finite sums/products: __sum(i, from, to, term), evaluated with the index bound in a child scope
const series = (op: 'sum' | 'prod') =>
  Object.assign(
    (args: MathNode[], _m: unknown, scope: Map<string, unknown> | Record<string, unknown>) => {
      const name = (args[0] as unknown as { name: string }).name
      const lo = args[1].compile().evaluate(scope)
      const hi = args[2].compile().evaluate(scope)
      const body = args[3].compile()
      if (!Number.isInteger(lo) || !Number.isInteger(hi) || hi - lo > 5000) throw new Error('sum bounds must be integers')
      const inner = new Map(scope instanceof Map ? scope : Object.entries(scope))
      let acc = op === 'sum' ? 0 : 1
      for (let v = lo; v <= hi; v++) {
        inner.set(name, v)
        const x = body.evaluate(inner)
        acc = op === 'sum' ? acc + x : acc * x
      }
      return acc
    },
    { rawArgs: true }
  )
math.import({ __sum: series('sum'), __prod: series('prod') }, { override: true })

class Unsupported extends Error {}

const FUNCS: Record<string, string> = {
  sin: 'sin', cos: 'cos', tan: 'tan', sec: 'sec', csc: 'csc', cot: 'cot',
  arcsin: 'asin', arccos: 'acos', arctan: 'atan', sinh: 'sinh', cosh: 'cosh', tanh: 'tanh',
  ln: 'log', log: 'log', exp: 'exp',
}
const GREEK = new Set(
  'alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi rho varrho sigma tau upsilon phi varphi chi psi omega Gamma Delta Theta Lambda Xi Sigma Upsilon Phi Psi Omega'.split(' ')
)
const SKIP = new Set(['left', 'right', 'bigl', 'bigr', 'Bigl', 'Bigr', 'big', 'Big', 'bigg', 'Bigg', 'biggl', 'biggr', 'displaystyle', 'textstyle', 'limits', 'nolimits', 'quad', 'qquad'])
const STYLE = new Set(['mathrm', 'mathit', 'mathbf', 'boldsymbol', 'mathnormal'])
const CONSTANTS = new Set(['pi', 'e'])

/** Readable names for counterexamples: converted symbol → how it was written. */
const display = new Map<string, string>()

/** Builds a mathjs expression, writing out the multiplication LaTeX leaves implicit. */
class Out {
  parts: string[] = []
  last: 'operand' | 'op' = 'op'
  absDepth = 0
  private times() {
    if (this.last === 'operand') this.parts.push('*')
  }
  operand(s: string) {
    this.times()
    this.parts.push(s)
    this.last = 'operand'
  }
  func(name: string) {
    this.times()
    this.parts.push(name)
    this.last = 'op'
  }
  open() {
    this.times()
    this.parts.push('(')
    this.last = 'op'
  }
  close() {
    this.parts.push(')')
    this.last = 'operand'
  }
  op(s: string) {
    this.parts.push(s)
    this.last = 'op'
  }
  postfix(s: string) {
    this.parts.push(s)
    this.last = 'operand'
  }
  toString() {
    return this.parts.join(' ')
  }
}

/** The balanced {…}, (…) or […] group starting at s[i]; returns its inside and the index after it. */
function group(s: string, i: number): [string, number] {
  const open = s[i]
  const close = open === '{' ? '}' : open === '(' ? ')' : ']'
  let depth = 0
  for (let j = i; j < s.length; j++) {
    if (s[j] === '\\') {
      j++
      continue
    }
    if (s[j] === open) depth++
    else if (s[j] === close && --depth === 0) return [s.slice(i + 1, j), j + 1]
  }
  throw new Unsupported('unbalanced brackets')
}

const skipWs = (s: string, i: number) => {
  while (i < s.length && /\s/.test(s[i])) i++
  return i
}

/** One argument: {group}, a single character, or a single \command. */
function arg(s: string, i: number): [string, number] {
  i = skipWs(s, i)
  if (s[i] === '{') return group(s, i)
  if (s[i] === '\\') {
    const m = /^\\([a-zA-Z]+|.)/.exec(s.slice(i))!
    return [m[0], i + m[0].length]
  }
  if (i >= s.length) throw new Unsupported('missing argument')
  return [s[i], i + 1]
}

const ident = (sub: string) =>
  sub.replace(/\\([a-zA-Z]+)/g, '$1').replace(/\+/g, 'p').replace(/-/g, 'm').replace(/[^A-Za-z0-9]/g, '')

/** The extent of a sum's term: up to the next + or − (or relation) at the same nesting level. */
function termEnd(s: string, i: number) {
  let depth = 0
  let j = skipWs(s, i)
  const start = j
  for (; j < s.length; j++) {
    const c = s[j]
    if (c === '\\') {
      const m = /^\\([a-zA-Z]+|.)/.exec(s.slice(j))!
      if (m[1] === '{') depth++
      else if (m[1] === '}') depth--
      j += m[0].length - 1
      continue
    }
    if ('{(['.includes(c)) depth++
    else if ('})]'.includes(c)) {
      if (depth === 0) break
      depth--
    } else if (depth === 0 && j > start && (c === '+' || c === '-')) break
  }
  return j
}

function convertInto(s: string, out: Out) {
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (/\s|&|~/.test(c)) {
      i++
      continue
    }
    if (/[0-9.]/.test(c)) {
      const m = /^\d*\.?\d+/.exec(s.slice(i))
      if (!m) throw new Unsupported(`stray "${c}"`)
      out.operand(m[0])
      i += m[0].length
      continue
    }
    if (/[A-Za-z]/.test(c)) {
      let name = c
      i++
      if (s[i] === '_') {
        const [sub, next] = arg(s, i + 1)
        name = `${c}_${ident(sub)}`
        display.set(name, `${c}_{${sub}}`)
        i = next
      }
      if (s[i] === "'") throw new Unsupported('derivatives')
      out.operand(name)
      continue
    }
    if (c === '{' || c === '(' || c === '[') {
      const [inner, next] = group(s, i)
      out.open()
      convertInto(inner, out)
      out.close()
      i = next
      continue
    }
    if (c === ')' || c === ']' || c === '}') throw new Unsupported('unbalanced brackets')
    if ('+-*/'.includes(c)) {
      out.op(c)
      i++
      continue
    }
    if (c === '^') {
      out.op('^')
      const [p, next] = arg(s, i + 1)
      out.open()
      convertInto(p, out)
      out.close()
      i = next
      continue
    }
    if (c === '!') {
      out.postfix('!')
      i++
      continue
    }
    if (c === '|') {
      if (out.last === 'operand' && out.absDepth > 0) (out.close(), out.absDepth--)
      else (out.func('abs'), out.open(), out.absDepth++)
      i++
      continue
    }
    if (c === '\\') {
      const m = /^\\([a-zA-Z]+|.)/.exec(s.slice(i))!
      const cmd = m[1]
      i += m[0].length
      if (cmd === '{') out.open()
      else if (cmd === '}') out.close()
      else if (',;:! '.includes(cmd) && cmd.length === 1) continue
      else if (SKIP.has(cmd)) {
        if (/^(left|right)$/.test(cmd) && s[skipWs(s, i)] === '.') i = skipWs(s, i) + 1
      } else if (cmd === 'lvert' || cmd === 'lVert') (out.func('abs'), out.open())
      else if (cmd === 'rvert' || cmd === 'rVert') out.close()
      else if (/^[dtc]?frac$/.test(cmd)) {
        const [num, a] = arg(s, i)
        const [den, b] = arg(s, a)
        out.open()
        out.open()
        convertInto(num, out)
        out.close()
        out.op('/')
        out.open()
        convertInto(den, out)
        out.close()
        out.close()
        i = b
      } else if (cmd === 'sqrt') {
        let root: string | null = null
        let j = skipWs(s, i)
        if (s[j] === '[') [root, j] = group(s, j)
        const [x, next] = arg(s, j)
        if (root) {
          out.open()
          out.open()
          convertInto(x, out)
          out.close()
          out.op('^')
          out.open()
          out.operand('1')
          out.op('/')
          out.open()
          convertInto(root, out)
          out.close()
          out.close()
          out.close()
        } else {
          out.func('sqrt')
          out.open()
          convertInto(x, out)
          out.close()
        }
        i = next
      } else if (cmd === 'cdot' || cmd === 'times' || cmd === 'ast') out.op('*')
      else if (cmd === 'div') out.op('/')
      else if (cmd === 'pi') out.operand('pi')
      else if (GREEK.has(cmd)) {
        out.operand(`gr_${cmd}`)
        display.set(`gr_${cmd}`, `\\${cmd}`)
      } else if (STYLE.has(cmd)) {
        const [x, next] = arg(s, i)
        convertInto(x, out)
        i = next
      } else if (cmd === 'binom' || cmd === 'dbinom' || cmd === 'tbinom') {
        const [n, a] = arg(s, i)
        const [k, b] = arg(s, a)
        out.func('combinations')
        out.open()
        convertInto(n, out)
        out.op(',')
        convertInto(k, out)
        out.close()
        i = b
      } else if (cmd === 'sum' || cmd === 'prod') {
        let j = skipWs(s, i)
        let lower = ''
        let upper = ''
        for (let pass = 0; pass < 2; pass++) {
          j = skipWs(s, j)
          if (s[j] === '_') [lower, j] = arg(s, j + 1)
          else if (s[j] === '^') [upper, j] = arg(s, j + 1)
        }
        const bound = /^\s*([a-zA-Z])\s*=\s*(.+)$/.exec(lower)
        if (!bound || !upper) throw new Unsupported('sums need an index range like \\sum_{i=1}^{n}')
        const end = termEnd(s, j)
        out.func(cmd === 'sum' ? '__sum' : '__prod')
        out.open()
        out.operand(bound[1])
        out.op(',')
        convertInto(bound[2], out)
        out.op(',')
        convertInto(upper, out)
        out.op(',')
        out.open()
        convertInto(s.slice(j, end), out)
        out.close()
        out.close()
        i = end
      } else if (FUNCS[cmd]) {
        let j = skipWs(s, i)
        let power: string | null = null
        let base: string | null = null
        for (let pass = 0; pass < 2; pass++) {
          j = skipWs(s, j)
          if (s[j] === '^') [power, j] = arg(s, j + 1)
          else if (s[j] === '_' && cmd === 'log') [base, j] = arg(s, j + 1)
        }
        if (power?.trim() === '-1') throw new Unsupported('inverse function notation')
        j = skipWs(s, j)
        let x: string
        if (s.startsWith('\\left', j)) j = skipWs(s, j + 5)
        if (s[j] === '(' || s[j] === '{' || s[j] === '[') [x, j] = group(s, j)
        else {
          // \sin 2x, \sin x, \sin \theta: an optional number then one symbol
          const m = /^(\d*\.?\d*)\s*(\\[a-zA-Z]+|[A-Za-z](_(\{[^}]*\}|.))?)/.exec(s.slice(j))
          if (!m) throw new Unsupported('function argument')
          x = m[0]
          j += m[0].length
        }
        if (s.startsWith('\\right', j)) j += 6
        if (power) out.open()
        out.func(FUNCS[cmd])
        out.open()
        convertInto(x, out)
        if (base) (out.op(','), convertInto(base, out))
        out.close()
        if (power) {
          out.close()
          out.op('^')
          out.open()
          convertInto(power, out)
          out.close()
        }
        i = j
      } else throw new Unsupported(`\\${cmd}`)
      continue
    }
    throw new Unsupported(`"${c}"`)
  }
}

/** LaTeX maths → a mathjs expression string, or null when it uses something this checker can't evaluate. */
export function latexToExpr(tex: string): string | null {
  try {
    const out = new Out()
    convertInto(tex, out)
    if (out.absDepth) return null
    const expr = out.toString()
    if (!expr.trim()) return null
    math.parse(expr)
    return expr
  } catch {
    return null
  }
}

// ---------- splitting steps into statements and relations ----------

type Rel = '=' | '<' | '>' | '<=' | '>='
const REL_CMDS: Record<string, Rel | 'other' | 'then'> = {
  le: '<=', leq: '<=', leqslant: '<=', ge: '>=', geq: '>=', geqslant: '>=', lt: '<', gt: '>',
  ne: 'other', neq: 'other', equiv: 'other', approx: 'other', sim: 'other', simeq: 'other', cong: 'other', propto: 'other',
  in: 'other', notin: 'other', subset: 'other', subseteq: 'other', mid: 'other', nmid: 'other', to: 'other', mapsto: 'other',
  implies: 'then', Rightarrow: 'then', Longrightarrow: 'then', iff: 'then', Leftrightarrow: 'then', therefore: 'then',
}

/** Strip what isn't maths: labels, tags, \text{…} remarks, alignment marks, trailing punctuation. */
function cleanMath(s: string) {
  let out = s.replace(/\\(label|tag)\*?\{[^}]*\}|\\(nonumber|notag)\b/g, ' ')
  // \text{…}-style remarks, with any spacing before them
  for (;;) {
    const m = /(\\q?quad\s*|,\s*)?\\(text|textrm|textit|mbox|intertext)\s*\{/.exec(out)
    if (!m) break
    const [, end] = group(out, m.index + m[0].length - 1)
    out = out.slice(0, m.index) + ' ' + out.slice(end)
  }
  return out.replace(/&/g, ' ').replace(/[\s.,;:]+$/, '').trim()
}

type Statement = { parts: string[]; rels: (Rel | 'other')[] }

/** Split at top-level relations; "A \implies B" becomes two statements. */
function statements(tex: string): Statement[] {
  const s = cleanMath(tex)
  const out: Statement[] = []
  let cur: Statement = { parts: [], rels: [] }
  let depth = 0
  let start = 0
  const cut = (end: number, rel: Rel | 'other' | 'then' | null, skip: number) => {
    cur.parts.push(s.slice(start, end).trim())
    if (rel === 'then' || rel === null) {
      if (cur.parts.length > 1 || rel === null) out.push(cur)
      cur = { parts: [], rels: [] }
    } else cur.rels.push(rel)
    start = end + skip
  }
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '\\') {
      const m = /^\\([a-zA-Z]+|.)/.exec(s.slice(i))!
      if (depth === 0 && REL_CMDS[m[1]]) (cut(i, REL_CMDS[m[1]], m[0].length), (i += m[0].length - 1))
      else i += m[0].length - 1
      continue
    }
    if ('{(['.includes(c)) depth++
    else if ('})]'.includes(c)) depth--
    else if (depth === 0 && (c === '=' || c === '<' || c === '>')) {
      if (s[i + 1] === '=') (cut(i, c === '<' ? '<=' : c === '>' ? '>=' : '=', 2), i++)
      else cut(i, c as Rel, 1)
    } else if (depth === 0 && c === ':' && s[i + 1] === '=') {
      cut(i, '=', 2)
      i++
    }
  }
  cut(s.length, null, 0)
  return out.filter(st => st.rels.length > 0 && st.parts.every(Boolean))
}

/** The maths in a step: delimited math in prose, or the whole claim when it is a bare formula. */
export function mathOf(claim: string): string[] {
  const segs: string[] = []
  const env = /\\begin\{(equation|align|gather|multline|eqnarray|flalign)\*?\}([\s\S]*?)\\end\{\1\*?\}/g
  const delimited = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\$([^$]+)\$|\\\(([\s\S]+?)\\\)/g
  let rest = claim.replace(env, (_m, _e, body: string) => (segs.push(...lines(body)), ' '))
  rest = rest.replace(delimited, (_m, a, b, c, d) => (segs.push(...lines(a ?? b ?? c ?? d)), ' '))
  if (!segs.length) {
    // a bare formula, not a sentence (words of 3+ letters that aren't commands mean prose)
    const formula = claim.replace(/\\(text|textrm|textit|mbox)\s*\{[^}]*\}/g, ' ')
    if (/[=<>]|\\(le|ge|leq|geq|lt|gt)\b/.test(formula) && !/[A-Za-z]{3,}/.test(formula.replace(/\\[a-zA-Z]+/g, ''))) segs.push(...lines(claim))
  }
  return segs
}

/** Display lines of an align: a line starting with a relation continues the previous chain. */
function lines(body: string) {
  const out: string[] = []
  for (const raw of body.split(/\\\\(?:\[[^\]]*\])?/)) {
    const l = raw.replace(/&/g, ' ').trim()
    if (!l) continue
    if (out.length && /^(=|<|>|\\(le|leq|ge|geq|lt|gt|leqslant|geqslant)\b)/.test(l)) out[out.length - 1] += ' ' + l
    else out.push(l)
  }
  return out
}

// ---------- numeric checking ----------

export type AlgebraStatus = 'ok' | 'fail' | 'warn' | 'unknown' | 'none'
export type AlgebraResult = { status: AlgebraStatus; note: string; samples?: number }
export type StepKindForAlgebra = 'assume' | 'derive' | 'case' | 'base' | 'inductive' | 'conclude'

type Compiled = { expr: string; code: EvalFunction; vars: string[] }
type Ctx = { defs: { name: string; c: Compiled }[]; eqConds: { l: Compiled; r: Compiled }[]; ineqConds: { l: Compiled; r: Compiled; rel: Rel }[]; constrained: Set<string> }

const INTEGER_NAMES = /^[ijklmnNKM](_|$)/

function compile(expr: string): Compiled {
  const node = math.parse(expr)
  const vars = new Set<string>()
  const bound = new Set<string>()
  node.traverse((n: MathNode, path: string, parent: MathNode | null) => {
    if ((n as unknown as { isFunctionNode?: boolean }).isFunctionNode && /^__(sum|prod)$/.test((n as unknown as { fn: { name: string } }).fn.name))
      bound.add((n as unknown as { args: { name: string }[] }).args[0].name)
    if ((n as unknown as { isSymbolNode?: boolean }).isSymbolNode && !(path === 'fn' && (parent as unknown as { isFunctionNode?: boolean })?.isFunctionNode))
      vars.add((n as unknown as { name: string }).name)
  })
  return { expr, code: node.compile(), vars: [...vars].filter(v => !bound.has(v) && !CONSTANTS.has(v)) }
}

/** Deterministic random numbers, so a check gives the same answer every time. */
function rng(seed: string) {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619)
  return () => {
    h = (h + 0x6d2b79f5) | 0
    let t = Math.imul(h ^ (h >>> 15), 1 | h)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const close = (a: number, b: number) => Math.abs(a - b) <= 1e-7 * Math.max(1, Math.abs(a), Math.abs(b))
const holds = (l: number, r: number, rel: Rel) =>
  rel === '=' ? close(l, r) : rel === '<' ? l < r || close(l, r) : rel === '>' ? l > r || close(l, r) : rel === '<=' ? l <= r || close(l, r) : l >= r || close(l, r)

const SAMPLES = 20

/** Evaluate l rel r at random points (respecting known definitions and inequality assumptions). */
function sampleLink(l: Compiled, r: Compiled, rel: Rel, ctx: Ctx, seed: string) {
  const rand = rng(seed)
  const defined = new Set(ctx.defs.map(d => d.name))
  const vars = new Set([...l.vars, ...r.vars])
  // variables used by the definitions these expressions depend on must be sampled too
  for (const d of [...ctx.defs].reverse()) if (vars.has(d.name)) d.c.vars.forEach(v => vars.add(v))
  for (const c of ctx.ineqConds) if ([...c.l.vars, ...c.r.vars].some(v => vars.has(v))) [...c.l.vars, ...c.r.vars].forEach(v => vars.add(v))
  const free = [...vars].filter(v => !defined.has(v))
  let valid = 0
  for (let attempt = 0; attempt < 400 && valid < SAMPLES; attempt++) {
    const scope = new Map<string, number>()
    for (const v of free) {
      const x = rand()
      scope.set(v, INTEGER_NAMES.test(v) ? 1 + Math.floor(x * 9) : attempt % 2 ? 0.2 + x * 2.8 : -3 + x * 6)
    }
    try {
      for (const d of ctx.defs) {
        const v = num(d.c.code.evaluate(scope))
        if (v == null) throw new Error()
        scope.set(d.name, v)
      }
      if (ctx.ineqConds.some(c => !holds(num(c.l.code.evaluate(scope)) ?? NaN, num(c.r.code.evaluate(scope)) ?? NaN, c.rel))) continue
      const lv = num(l.code.evaluate(scope))
      const rv = num(r.code.evaluate(scope))
      if (lv == null || rv == null) continue
      valid++
      if (!holds(lv, rv, rel)) return { ok: false as const, scope, lv, rv, valid }
    } catch {}
  }
  return { ok: true as const, valid }
}

const fmt = (x: number) => (Number.isInteger(x) ? String(x) : x.toPrecision(4).replace(/\.?0+$/, ''))
const nameOf = (v: string) => display.get(v) ?? v
const relText: Record<Rel, string> = { '=': '=', '<': '<', '>': '>', '<=': '≤', '>=': '≥' }

function counterexample(scope: Map<string, number>, vars: string[], lv: number, rv: number) {
  const shown = vars.filter(v => scope.has(v)).map(v => `${nameOf(v)} = ${fmt(scope.get(v)!)}`)
  return `${shown.length ? `at ${shown.join(', ')}: ` : ''}left side = ${fmt(lv)}, right side = ${fmt(rv)}`
}

/**
 * Check the algebra of a proof's steps in order. Single-symbol equations ("n = 2k+1") become definitions used
 * by later steps; equations and inequalities that are assumed become conditions (inequalities restrict sampling).
 */
export function checkAlgebra(steps: { text: string; kind: StepKindForAlgebra }[]): AlgebraResult[] {
  const ctx: Ctx = { defs: [], eqConds: [], ineqConds: [], constrained: new Set() }
  return steps.map(step => checkStep(step.text, step.kind, ctx))
}

function checkStep(text: string, kind: StepKindForAlgebra, ctx: Ctx): AlgebraResult {
  const stmts = mathOf(text).flatMap(statements)
  if (!stmts.length) return { status: 'none', note: '' }
  const verdicts: { status: AlgebraStatus; note: string }[] = []
  const assumed = kind === 'assume' || kind === 'case'
  for (const st of stmts) {
    if (st.rels.includes('other')) {
      verdicts.push({ status: 'unknown', note: 'uses a relation that can’t be checked numerically' })
      continue
    }
    const exprs = st.parts.map(latexToExpr)
    let compiled: (Compiled | null)[]
    try {
      compiled = exprs.map(e => (e ? compile(e) : null))
    } catch {
      verdicts.push({ status: 'unknown', note: 'couldn’t read this maths' })
      continue
    }
    const rels = st.rels as Rel[]
    // a definition: one side is a single symbol ("n = 2k + 1", "S_{k+1} = …"). A symbol already defined is
    // re-defined only when one value is a specific instance (base case "n = 1", then "n = k + 1");
    // otherwise the equation is a claim about it and is checked below.
    if (rels.length === 1 && rels[0] === '=' && compiled[0] && compiled[1]) {
      const isSym = (k: number) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(compiled[k]!.expr.trim()) && !CONSTANTS.has(compiled[k]!.expr.trim())
      const prior = (k: number) => ctx.defs.find(d => d.name === compiled[k]!.expr.trim())
      const sym = [0, 1].find(k => isSym(k) && !compiled[1 - k]!.vars.includes(compiled[k]!.expr.trim()) && (!prior(k) || !prior(k)!.c.vars.length || !compiled[1 - k]!.vars.length))
      if (sym != null) {
        const name = compiled[sym]!.expr.trim()
        const value = compiled[1 - sym]!
        ctx.defs = ctx.defs.filter(d => d.name !== name)
        ctx.defs.push({ name, c: value })
        // check earlier equations only when this pins them down completely (not "a = 2k" against "√2 = a/b")
        const determined = (v: string) => {
          const d = ctx.defs.find(x => x.name === v)
          return !!d && d.c.vars.every(w => ctx.defs.some(x => x.name === w))
        }
        const conds = ctx.eqConds.filter(c => [...c.l.vars, ...c.r.vars].includes(name) && [...c.l.vars, ...c.r.vars].every(determined))
        for (const c of conds) {
          const res = sampleLink(c.l, c.r, '=', ctx, text)
          if (!res.ok) {
            verdicts.push({ status: 'fail', note: `${nameOf(name)} = ${st.parts[1 - sym]} doesn’t satisfy the earlier equation ${c.l.expr} = ${c.r.expr} (${counterexample(res.scope, [...c.l.vars, ...c.r.vars], res.lv, res.rv)})` })
          } else verdicts.push({ status: 'ok', note: `consistent with the earlier equation` })
        }
        if (!conds.length) verdicts.push({ status: 'none', note: '' })
        continue
      }
    }
    if (assumed) {
      // assumptions are conditions, not claims to verify
      for (let k = 0; k < rels.length; k++) {
        const l = compiled[k]
        const r = compiled[k + 1]
        if (!l || !r) continue
        if (rels[k] !== '=') ctx.ineqConds.push({ l, r, rel: rels[k] })
        else {
          // an assumed equation that holds for all values (e.g. an inductive hypothesis that is in fact true)
          // constrains nothing; only a genuine condition ("2x + 3 = 7") does
          const res = sampleLink(l, r, '=', ctx, `${l.expr}=${r.expr}`)
          if (!(res.ok && res.valid >= 6)) (ctx.eqConds.push({ l, r }), [...l.vars, ...r.vars].forEach(v => ctx.constrained.add(v)))
        }
      }
      verdicts.push({ status: 'none', note: '' })
      continue
    }
    for (let k = 0; k < rels.length; k++) {
      const l = compiled[k]
      const r = compiled[k + 1]
      const linkText = `${st.parts[k]} ${relText[rels[k]]} ${st.parts[k + 1]}`
      if (!l || !r) {
        verdicts.push({ status: 'unknown', note: `can’t evaluate ${linkText}` })
        continue
      }
      const res = sampleLink(l, r, rels[k], ctx, linkText)
      if (res.ok) {
        verdicts.push(res.valid < 6 ? { status: 'unknown', note: `couldn’t evaluate ${linkText} at enough points` } : { status: 'ok', note: '' })
        continue
      }
      const vars = [...new Set([...l.vars, ...r.vars])]
      const dependsOnConditions = vars.some(v => ctx.constrained.has(v))
      if (rels[k] === '=') {
        if (dependsOnConditions) {
          // an equation that holds only under earlier equations: can't be confirmed by sampling
          if (rels.length === 1) (ctx.eqConds.push({ l, r }), vars.forEach(v => ctx.constrained.add(v)))
          verdicts.push({ status: 'unknown', note: `${linkText} isn’t an identity; it depends on earlier equations` })
        } else verdicts.push({ status: 'fail', note: `${linkText} is false: ${counterexample(res.scope, vars, res.lv, res.rv)}` })
      } else if (!vars.length) verdicts.push({ status: 'fail', note: `${linkText} is false (${fmt(res.lv)} vs ${fmt(res.rv)})` })
      else verdicts.push({ status: 'warn', note: `${linkText} fails ${counterexample(res.scope, vars, res.lv, res.rv)}; fine only if your assumptions rule that out` })
    }
  }
  const pick = (s: AlgebraStatus) => verdicts.find(v => v.status === s)
  const worst = pick('fail') ?? pick('warn')
  if (worst) return worst
  if (pick('ok')) return { status: 'ok', note: `Algebra holds at ${SAMPLES} random points` }
  const unknown = pick('unknown')
  return unknown ?? { status: 'none', note: '' }
}
