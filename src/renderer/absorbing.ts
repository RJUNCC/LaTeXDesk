// Absorbing Markov chain analysis with exact rational arithmetic.
// Canonical form P = [Q R; 0 I]: N = (I - Q)^-1, B = N R (absorption probabilities), t = N 1 (expected steps).

const gcd = (a: bigint, b: bigint): bigint => {
  if (a < 0n) a = -a
  if (b < 0n) b = -b
  while (b) [a, b] = [b, a % b]
  return a
}

export class Frac {
  readonly n: bigint
  readonly d: bigint

  constructor(n: bigint, d: bigint = 1n) {
    if (d === 0n) throw new Error('division by zero')
    if (d < 0n) (n = -n), (d = -d)
    const g = gcd(n, d) || 1n
    this.n = n / g
    this.d = d / g
  }

  /** From a float, recognising simple fractions (0.333333 -> 1/3) before falling back to the exact decimal. */
  static from(x: number): Frac {
    if (Number.isInteger(x)) return new Frac(BigInt(x))
    // continued-fraction approximation with a small denominator
    let [h0, h1, k0, k1] = [0, 1, 1, 0]
    let v = x
    for (let i = 0; i < 20; i++) {
      const a = Math.floor(v)
      ;[h0, h1] = [h1, a * h1 + h0]
      ;[k0, k1] = [k1, a * k1 + k0]
      if (k1 > 1000) break
      if (Math.abs(x - h1 / k1) < 1e-9) return new Frac(BigInt(h1), BigInt(k1))
      if (v - a < 1e-12) break
      v = 1 / (v - a)
    }
    const s = x.toFixed(10).replace(/0+$/, '')
    const [int, frac = ''] = s.split('.')
    return new Frac(BigInt(int + frac), 10n ** BigInt(frac.length))
  }

  add(o: Frac) { return new Frac(this.n * o.d + o.n * this.d, this.d * o.d) }
  sub(o: Frac) { return new Frac(this.n * o.d - o.n * this.d, this.d * o.d) }
  mul(o: Frac) { return new Frac(this.n * o.n, this.d * o.d) }
  div(o: Frac) { return new Frac(this.n * o.d, this.d * o.n) }
  isZero() { return this.n === 0n }
  toNumber() { return Number(this.n) / Number(this.d) }
  toString() { return this.d === 1n ? String(this.n) : `${this.n}/${this.d}` }

  /** Decimal approximation, trimmed: 0.4375, 0.3333 */
  decimal(places = 4) { return String(+this.toNumber().toFixed(places)) }

  /** LaTeX: integers as-is, readable fractions as \tfrac, anything unwieldy as a decimal. */
  toLatex() {
    if (this.d === 1n) return String(this.n)
    if (this.d <= 9999n) return `${this.n < 0n ? '-' : ''}\\tfrac{${this.n < 0n ? -this.n : this.n}}{${this.d}}`
    return this.decimal()
  }
}

const ZERO = new Frac(0n)
const ONE = new Frac(1n)

export const isAbsorbingRow = (P: number[][], i: number) => Math.abs(P[i][i] - 1) < 1e-9

export type Analysis =
  | { ok: true; transient: number[]; absorbing: number[]; Q: Frac[][]; R: Frac[][]; N: Frac[][]; B: Frac[][]; t: Frac[] }
  | { ok: false; reason: string; stuck?: number[] }

/** Gauss-Jordan inverse; returns null if singular. */
function invert(M: Frac[][]): Frac[][] | null {
  const n = M.length
  const A = M.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? ONE : ZERO))])
  for (let col = 0; col < n; col++) {
    const pivot = A.findIndex((row, r) => r >= col && !row[col].isZero())
    if (pivot < 0) return null
    ;[A[col], A[pivot]] = [A[pivot], A[col]]
    const p = A[col][col]
    A[col] = A[col].map(v => v.div(p))
    for (let r = 0; r < n; r++) {
      if (r === col || A[r][col].isZero()) continue
      const f = A[r][col]
      A[r] = A[r].map((v, k) => v.sub(f.mul(A[col][k])))
    }
  }
  return A.map(row => row.slice(n))
}

const matMul = (A: Frac[][], B: Frac[][]) =>
  A.map(row => B[0].map((_, j) => row.reduce((s, v, k) => s.add(v.mul(B[k][j])), ZERO)))

export function analyze(P: number[][]): Analysis {
  const absorbing = P.map((_, i) => i).filter(i => isAbsorbingRow(P, i))
  const transient = P.map((_, i) => i).filter(i => !isAbsorbingRow(P, i))
  if (!absorbing.length) return { ok: false, reason: 'Mark at least one absorbing state (P(i→i) = 1) to compute absorption probabilities.' }
  if (!transient.length) return { ok: false, reason: 'Every state is absorbing, so there is nothing to compute.' }

  // every transient state must be able to reach some absorbing state, otherwise I - Q is singular
  const reaches = new Set(absorbing)
  for (let changed = true; changed; ) {
    changed = false
    for (const i of transient)
      if (!reaches.has(i) && P[i].some((p, j) => p > 0 && reaches.has(j))) {
        reaches.add(i)
        changed = true
      }
  }
  const stuck = transient.filter(i => !reaches.has(i))
  if (stuck.length) return { ok: false, reason: 'never reach an absorbing state, so absorption probabilities are undefined.', stuck }

  const F = P.map(row => row.map(Frac.from))
  const Q = transient.map(i => transient.map(j => F[i][j]))
  const R = transient.map(i => absorbing.map(j => F[i][j]))
  const IminusQ = Q.map((row, a) => row.map((v, b) => (a === b ? ONE : ZERO).sub(v)))
  const N = invert(IminusQ)
  if (!N) return { ok: false, reason: 'I − Q is singular; check the transition probabilities.' }
  return { ok: true, transient, absorbing, Q, R, N, B: matMul(N, R), t: N.map(row => row.reduce((s, v) => s.add(v), ZERO)) }
}

// ---------- LaTeX ----------

/**
 * A bracketed matrix drawn with TikZ, with row and column labels and optional dividing rules
 * (after column `vSplit` and row `hSplit`). Needs \usetikzlibrary{matrix,calc}.
 */
export function labeledMatrix(rows: string[], cols: string[], cells: string[][], vSplit = 0, hSplit = 0) {
  const lines = [
    '\\begin{tikzpicture}[baseline=(m.center)]',
    '  \\matrix (m) [matrix of math nodes, left delimiter={[}, right delimiter={]},',
    '               nodes={minimum width=2.4em, minimum height=1.4em, anchor=center}] {',
    ...cells.map(r => '    ' + r.join(' & ') + ' \\\\'),
    '  };',
  ]
  if (vSplit > 0 && vSplit < cols.length) {
    lines.push(
      `  \\coordinate (vx) at ($(m-1-${vSplit}.east)!0.5!(m-1-${vSplit + 1}.west)$);`,
      '  \\draw (vx |- m.north) -- (vx |- m.south);'
    )
  }
  if (hSplit > 0 && hSplit < rows.length) {
    lines.push(
      `  \\coordinate (hy) at ($(m-${hSplit}-1.south)!0.5!(m-${hSplit + 1}-1.north)$);`,
      '  \\draw (hy -| m.west) -- (hy -| m.east);'
    )
  }
  // one \node per label (labels may contain commas, which \foreach would split);
  // labels are state names in TeX math (e.g. \geq 10), so typeset them in math mode
  const math = (l: string) => (l.includes('$') ? l : `$${l}$`)
  cols.forEach((l, j) => lines.push(`  \\node[above=2pt, font=\\footnotesize] at (m-1-${j + 1} |- m.north) {${math(l)}};`))
  rows.forEach((l, i) => lines.push(`  \\node[left=10pt, font=\\footnotesize] at (m-${i + 1}-1 -| m.west) {${math(l)}};`))
  lines.push('\\end{tikzpicture}')
  return lines.join('\n')
}

const indent = (s: string, pad = '  ') => s.replace(/^/gm, pad)

/** P reordered into canonical form, with the Q | R / 0 | I split drawn in. */
export function canonicalLatex(P: number[][], labels: string[], a: Extract<Analysis, { ok: true }>, fmt: (p: number) => string) {
  const order = [...a.transient, ...a.absorbing]
  const lbl = order.map(i => labels[i])
  const cells = order.map(i => order.map(j => fmt(P[i][j])))
  return [
    '\\begin{equation}',
    `  % canonical form: transient states (${a.transient.map(i => labels[i]).join(', ')}) first, then absorbing (${a.absorbing.map(i => labels[i]).join(', ')})`,
    '  P = ',
    indent(labeledMatrix(lbl, lbl, cells, a.transient.length, a.transient.length)),
    '\\end{equation}',
  ].join('\n')
}

/** N = (I-Q)^-1, B = NR and t = N1 as labelled matrices. */
export function absorptionLatex(labels: string[], a: Extract<Analysis, { ok: true }>) {
  const tl = a.transient.map(i => labels[i])
  const al = a.absorbing.map(i => labels[i])
  const eq = (lhs: string, body: string) => ['\\begin{equation}', `  ${lhs} = `, indent(body), '\\end{equation}'].join('\n')
  return [
    eq('N = (I - Q)^{-1}', labeledMatrix(tl, tl, a.N.map(r => r.map(v => v.toLatex())))),
    eq('B = NR', labeledMatrix(tl, al, a.B.map(r => r.map(v => v.toLatex())))),
    eq('t = N\\mathbf{1}', labeledMatrix(tl, ['\\text{steps}'], a.t.map(v => [v.toLatex()]))),
  ].join('\n')
}
