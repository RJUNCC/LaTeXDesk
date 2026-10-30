// Markov chain builder: an SVG canvas and a transition matrix kept in sync, emitting a TikZ diagram.
// Absorbing states are detected from P(i→i) = 1 and analysed in canonical form (see absorbing.ts).
import { EditorView } from '@codemirror/view'
import { FormatContext, insertRawBlock } from './format'
import { Analysis, absorptionLatex, analyze, canonicalLatex, isAbsorbingRow } from './absorbing'

type State = { label: string; x: number; y: number }
type Chain = {
  states: State[]
  P: number[][]
  caption: string
  showMatrix: boolean
  showCanonical: boolean
  showAnalysis: boolean
}
type Selection = { kind: 'state'; i: number } | { kind: 'edge'; i: number; j: number } | null
type OkAnalysis = Extract<Analysis, { ok: true }>

const W = 520
const H = 380
const EPS = 1e-9
// state radius on the canvas: smaller when there are many states so they still fit in a row
let R = 22
let MIN_GAP = 2 * R + 6 // closer than this and two states overlap
const sizeFor = (n: number) => {
  R = n <= 8 ? 22 : n <= 12 ? 18 : 14
  MIN_GAP = 2 * R + 6
}
// output scale: 70 px per cm, stretched if needed so states sit at least MIN_CM apart in the PDF
const PX_PER_CM = 70
const MIN_CM = 1.25
const MAX_WIDTH_CM = 12 // wider diagrams are scaled down to the text width

// The inserted block is fenced by these comments so it can be found and re-opened for editing
const START = '% texdesk-markov: '
const END = '% texdesk-markov-end'

const SVG_NS = 'http://www.w3.org/2000/svg'

const exampleChain = (): Chain => ({
  states: [
    { label: 'A', x: 140, y: 110 },
    { label: 'B', x: 380, y: 110 },
    { label: 'C', x: 260, y: 290 },
  ],
  P: [
    [0.5, 0.5, 0],
    [0, 0, 1],
    [0.3, 0, 0.7],
  ],
  caption: 'Markov chain',
  showMatrix: false,
  showCanonical: false,
  showAnalysis: false,
})

const rowSum = (row: number[]) => row.reduce((a, b) => a + b, 0)
const fmt = (p: number) => String(+p.toFixed(4))
const isValidRow = (row: number[]) => Math.abs(rowSum(row) - 1) < EPS

/** Render a state label as TeX: plain text becomes math ($s_1$), anything already containing $ is kept. */
const texLabel = (label: string) => (label.includes('$') ? label : `$${label}$`)

// canvas display only: show common TeX as symbols (\geq 10 -> ≥ 10, s_{1} -> s1)
const SYMBOLS: Record<string, string> = {
  geq: '≥', ge: '≥', leq: '≤', le: '≤', infty: '∞', alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ',
  lambda: 'λ', mu: 'μ', pi: 'π', sigma: 'σ', theta: 'θ', emptyset: '∅', neq: '≠',
}
const prettyLabel = (label: string) =>
  label
    .replace(/\$/g, '')
    .replace(/\\([a-zA-Z]+)\s*/g, (m, name) => (SYMBOLS[name] ? SYMBOLS[name] + ' ' : name))
    .replace(/[{}_^]/g, '')
    .trim()

// ---------- geometry ----------

type Pt = { x: number; y: number }
const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y })
const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y })
const mul = (a: Pt, k: number): Pt => ({ x: a.x * k, y: a.y * k })
const len = (a: Pt) => Math.hypot(a.x, a.y) || 1
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y)
const unit = (a: Pt) => mul(a, 1 / len(a))
const rot = (a: Pt, deg: number): Pt => {
  const r = (deg * Math.PI) / 180
  return { x: a.x * Math.cos(r) - a.y * Math.sin(r), y: a.x * Math.sin(r) + a.y * Math.cos(r) }
}
const distToSegment = (p: Pt, a: Pt, b: Pt) => {
  const ab = sub(b, a)
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / (ab.x ** 2 + ab.y ** 2 || 1)))
  return dist(p, add(a, mul(ab, t)))
}

/** Direction a self-loop should point: away from the middle of the graph. */
function loopDirection(chain: Chain, i: number): Pt {
  const c = chain.states.reduce((acc, s) => add(acc, mul(s, 1 / chain.states.length)), { x: 0, y: 0 })
  const d = sub(chain.states[i], c)
  // a row of states (all on one line) loops upward, clear of the bent edges
  if (Math.abs(d.y) < 1 && chain.states.every(s => Math.abs(s.y - chain.states[i].y) < 1)) return { x: 0, y: -1 }
  // snap to the four directions TikZ supports for loops
  if (Math.abs(d.x) > Math.abs(d.y)) return { x: Math.sign(d.x) || 1, y: 0 }
  return { x: 0, y: d.y > 0 ? 1 : -1 }
}

const TIKZ_LOOP: Record<string, string> = { '0,-1': 'above', '0,1': 'below', '-1,0': 'left', '1,0': 'right' }

/**
 * How much edge i→j bends, in degrees (TikZ `bend left=θ`). Edges bend when the reverse edge
 * exists (so both stay visible) or when the straight line would pass through another state.
 */
function bendAngle(chain: Chain, i: number, j: number) {
  const a = chain.states[i]
  const b = chain.states[j]
  const mutual = chain.P[j][i] > 0
  const blocked = chain.states.some((s, k) => k !== i && k !== j && distToSegment(s, a, b) < R * 1.4)
  if (blocked) return mutual ? 40 : 35
  return mutual ? 20 : 0
}

/** SVG path + label position for edge i→j. */
function edgeGeometry(chain: Chain, i: number, j: number) {
  const a = chain.states[i]
  const b = chain.states[j]
  if (i === j) {
    const d = loopDirection(chain, i)
    const p1 = add(a, mul(rot(d, -30), R))
    const p2 = add(a, mul(rot(d, 30), R))
    const c1 = add(a, mul(rot(d, -40), R * 3))
    const c2 = add(a, mul(rot(d, 40), R * 3))
    return { d: `M${p1.x},${p1.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${p2.x},${p2.y}`, label: add(a, mul(d, R * 2.7)) }
  }
  const angle = bendAngle(chain, i, j)
  const dir = unit(sub(b, a))
  // left normal of the direction of travel (screen coordinates, y down), matching TikZ's "bend left"
  const left = { x: dir.y, y: -dir.x }
  if (!angle) {
    const p1 = add(a, mul(dir, R))
    const p2 = sub(b, mul(dir, R))
    return { d: `M${p1.x},${p1.y} L${p2.x},${p2.y}`, label: add(mul(add(p1, p2), 0.5), mul(left, 12)) }
  }
  const ctrl = add(mul(add(a, b), 0.5), mul(left, dist(a, b) * 0.69 * Math.tan((angle * Math.PI) / 180)))
  const p1 = add(a, mul(unit(sub(ctrl, a)), R))
  const p2 = add(b, mul(unit(sub(ctrl, b)), R))
  const labelPt = add(add(mul(p1, 0.25), mul(ctrl, 0.5)), mul(p2, 0.25))
  return { d: `M${p1.x},${p1.y} Q${ctrl.x},${ctrl.y} ${p2.x},${p2.y}`, label: add(labelPt, mul(left, 10)) }
}

/** Pairs of states drawn on top of each other. */
function overlappingPairs(chain: Chain) {
  const pairs: [number, number][] = []
  chain.states.forEach((a, i) => chain.states.forEach((b, j) => j > i && dist(a, b) < MIN_GAP && pairs.push([i, j])))
  return pairs
}

// ---------- LaTeX output ----------

export type ChainOutput = { latex: string; needsMatrixLib: boolean; needsAmsmath: boolean; needsGraphicx: boolean }

export function chainToLatex(chain: Chain, labelId: string): ChainOutput {
  const n = chain.states.length
  sizeFor(n) // edge bending is judged at canvas scale
  const xs = chain.states.map(s => s.x)
  const ys = chain.states.map(s => s.y)
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)

  // stretch the layout if states are close on the canvas, so circles never overlap in the PDF
  let minDist = Infinity
  chain.states.forEach((a, i) => chain.states.forEach((b, j) => j > i && (minDist = Math.min(minDist, dist(a, b)))))
  const cmPerPx = Math.min(0.03, Math.max(1 / PX_PER_CM, Number.isFinite(minDist) ? MIN_CM / minDist : 0))
  const widthCm = (Math.max(...xs) - minX) * cmPerPx + 2
  const shrink = widthCm > MAX_WIDTH_CM
  const cm = (v: number) => (+(v * cmPerPx).toFixed(2)).toString()

  const nodes = chain.states.map((s, i) => {
    const style = isAbsorbingRow(chain.P, i) ? 'state, accepting' : 'state'
    return `    \\node[${style}] (s${i}) at (${cm(s.x - minX)},${cm(-(s.y - minY))}) {${texLabel(s.label)}};`
  })
  const edges: string[] = []
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      const p = chain.P[i][j]
      if (p <= 0) continue
      let opts = ''
      if (i === j) {
        const d = loopDirection(chain, i)
        opts = `loop ${TIKZ_LOOP[`${d.x},${d.y}`]}`
      } else {
        const angle = bendAngle(chain, i, j)
        if (angle) opts = `bend left=${angle}`
      }
      edges.push(`      (s${i}) edge${opts ? ` [${opts}]` : ''} node {${fmt(p)}} (s${j})`)
    }

  // rounded so the saved comment line stays readable (no 0.20000000000000004)
  const json = JSON.stringify({
    v: 2,
    states: chain.states.map(s => ({ label: s.label, x: Math.round(s.x), y: Math.round(s.y) })),
    P: chain.P.map(r => r.map(p => +p.toFixed(6))),
    caption: chain.caption,
    showMatrix: chain.showMatrix,
    showCanonical: chain.showCanonical,
    showAnalysis: chain.showAnalysis,
  })
  const picture = [
    '  \\begin{tikzpicture}[->, >=stealth, shorten >=1pt, auto, semithick, every state/.style={minimum size=9mm}]',
    ...nodes,
    edges.length ? `    \\path\n${edges.join('\n')};` : '',
    '  \\end{tikzpicture}',
  ].filter(Boolean)
  const lines = [
    START + json,
    '\\begin{figure}[h]',
    '  \\centering',
    ...(shrink ? ['  \\resizebox{\\linewidth}{!}{%', ...picture, '  }'] : picture),
    `  \\caption{${chain.caption.replace(/[{}]/g, '')}}`,
    `  \\label{fig:${labelId}}`,
    '\\end{figure}',
  ]

  if (chain.showMatrix) {
    const rows = chain.P.map(r => '    ' + r.map(fmt).join(' & ')).join(' \\\\\n')
    lines.push(
      '\\begin{equation}',
      `  % rows and columns in state order: ${chain.states.map(s => s.label).join(', ')}`,
      '  P = \\begin{pmatrix}',
      rows,
      '  \\end{pmatrix}',
      `  \\label{eq:${labelId}}`,
      '\\end{equation}'
    )
  }

  const a = analyze(chain.P)
  const labels = chain.states.map(s => s.label)
  if (a.ok && chain.showCanonical) lines.push(canonicalLatex(chain.P, labels, a, fmt))
  if (a.ok && chain.showAnalysis) lines.push(absorptionLatex(labels, a))
  lines.push(END)

  const usesMatrices = a.ok && (chain.showCanonical || chain.showAnalysis)
  return {
    latex: lines.join('\n'),
    needsMatrixLib: usesMatrices,
    needsAmsmath: chain.showMatrix || usesMatrices,
    needsGraphicx: shrink,
  }
}

/** If the cursor is inside a previously inserted chain, return it and its document range. */
function findExistingBlock(view: EditorView): { chain: Chain; from: number; to: number } | null {
  const doc = view.state.doc
  const head = view.state.selection.main.head
  const text = doc.toString()
  const start = text.lastIndexOf(START, head)
  if (start < 0) return null
  const endIdx = text.indexOf(END, start)
  if (endIdx < 0 || head > endIdx + END.length) return null
  try {
    const lineEnd = text.indexOf('\n', start)
    const data = JSON.parse(text.slice(start + START.length, lineEnd < 0 ? undefined : lineEnd))
    if (!Array.isArray(data.states) || !Array.isArray(data.P)) return null
    return {
      chain: {
        states: data.states,
        P: data.P,
        caption: data.caption ?? 'Markov chain',
        showMatrix: !!data.showMatrix,
        showCanonical: !!data.showCanonical,
        showAnalysis: !!data.showAnalysis,
      },
      from: start,
      to: endIdx + END.length,
    }
  } catch {
    return null
  }
}

// ---------- the dialog ----------

let dialog: HTMLDialogElement | null = null

function buildDialog() {
  const dlg = document.createElement('dialog')
  dlg.id = 'markov-dialog'
  dlg.className = 'wide markov'
  dlg.innerHTML = `
    <h3>Markov chain builder</h3>
    <p class="muted">Double-click the canvas to add a state · drag a state to move it ·
      <b>Shift</b>+drag from one state to another (or itself) to add a transition · click anything to edit it.
      A state with P(i→i) = 1 is <b>absorbing</b>.</p>
    <div class="mk-body">
      <div class="mk-left">
        <svg class="mk-canvas" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"></svg>
        <div class="mk-selection muted">Nothing selected</div>
      </div>
      <div class="mk-right">
        <div class="mk-matrix"></div>
        <div class="mk-buttons">
          <button type="button" data-act="add">+ State</button>
          <button type="button" data-act="row" title="States in a line, absorbing states at the ends">Row layout</button>
          <button type="button" data-act="circle">Circle layout</button>
          <button type="button" data-act="normalize" title="Scale each row so it sums to 1 (an empty row becomes an absorbing state)">Normalize rows</button>
        </div>
        <div class="mk-status"></div>
        <div class="mk-analysis"></div>
        <label class="mk-field">Caption <input class="mk-caption"></label>
        <div class="mk-options">
          <label class="mk-check"><input type="checkbox" class="mk-show-matrix"> Insert the transition matrix P</label>
          <label class="mk-check"><input type="checkbox" class="mk-show-canonical"> Insert P in canonical form [Q R; 0 I]</label>
          <label class="mk-check"><input type="checkbox" class="mk-show-analysis"> Insert absorption analysis (N, B, t)</label>
        </div>
      </div>
    </div>
    <menu><button type="button" class="primary mk-insert">Insert</button><button type="button" data-act="cancel">Cancel</button></menu>`
  document.body.appendChild(dlg)
  return dlg
}

export function openMarkovBuilder(view: EditorView, ctx: FormatContext) {
  dialog ??= buildDialog()
  const dlg = dialog
  const existing = findExistingBlock(view)
  const chain: Chain = existing ? structuredClone(existing.chain) : exampleChain()
  let sel: Selection = null

  const q = <T extends Element>(s: string) => dlg.querySelector<T>(s)!
  const svg = q<SVGSVGElement>('.mk-canvas')
  const matrixEl = q<HTMLElement>('.mk-matrix')
  const selEl = q<HTMLElement>('.mk-selection')
  const statusEl = q<HTMLElement>('.mk-status')
  const analysisEl = q<HTMLElement>('.mk-analysis')
  const insertBtn = q<HTMLButtonElement>('.mk-insert')
  const caption = q<HTMLInputElement>('.mk-caption')
  const showMatrix = q<HTMLInputElement>('.mk-show-matrix')
  const showCanonical = q<HTMLInputElement>('.mk-show-canonical')
  const showAnalysis = q<HTMLInputElement>('.mk-show-analysis')
  caption.value = chain.caption
  showMatrix.checked = chain.showMatrix
  showCanonical.checked = chain.showCanonical
  showAnalysis.checked = chain.showAnalysis
  insertBtn.textContent = existing ? 'Update' : 'Insert'

  // ----- placement -----

  const clamp = (p: Pt): Pt => ({ x: Math.min(W - R, Math.max(R, p.x)), y: Math.min(H - R, Math.max(R, p.y)) })
  const clearance = (p: Pt) => Math.min(Infinity, ...chain.states.map(s => dist(s, p)))

  /** A spot for a new state: the free point nearest `near`, or the emptiest point on the canvas. */
  const freeSpot = (near?: Pt): Pt => {
    sizeFor(chain.states.length + 1)
    let best: Pt = { x: W / 2, y: H / 2 }
    let bestScore = -Infinity
    for (let x = R * 1.5; x <= W - R * 1.5; x += 10)
      for (let y = R * 1.5; y <= H - R * 1.5; y += 10) {
        const p = { x, y }
        const c = clearance(p)
        const score = near
          ? (c >= MIN_GAP + 8 ? 0 : -1e6 + c) - dist(p, near)
          : Math.min(c, 400) - 0.05 * dist(p, { x: W / 2, y: H / 2 })
        if (score > bestScore) (bestScore = score), (best = p)
      }
    return best
  }

  const rowLayout = () => {
    sizeFor(chain.states.length)
    const idx = chain.states.map((_, i) => i)
    const abs = idx.filter(i => isAbsorbingRow(chain.P, i))
    const tr = idx.filter(i => !isAbsorbingRow(chain.P, i))
    // absorbing states at the ends: first one on the left, the rest on the right
    const order = abs.length ? [abs[0], ...tr, ...abs.slice(1)] : tr
    const n = order.length
    const margin = R * 1.6
    order.forEach((i, k) => {
      chain.states[i].x = n === 1 ? W / 2 : margin + ((W - 2 * margin) * k) / (n - 1)
      chain.states[i].y = H / 2 + 20
    })
    render()
  }

  const circleLayout = () => {
    const n = chain.states.length
    const r = Math.min(W, H) / 2 - R * 3
    chain.states.forEach((s, k) => {
      const a = -Math.PI / 2 + (2 * Math.PI * k) / n
      s.x = W / 2 + r * Math.cos(a)
      s.y = H / 2 + r * Math.sin(a)
    })
    render()
  }

  /** Push overlapping states apart until every pair has room. */
  const fixOverlaps = () => {
    sizeFor(chain.states.length)
    for (let iter = 0; iter < 300 && overlappingPairs(chain).length; iter++)
      for (const [i, j] of overlappingPairs(chain)) {
        const a = chain.states[i]
        const b = chain.states[j]
        const d = sub(b, a)
        const push = mul(len(d) > 0.5 ? unit(d) : { x: Math.cos(i + j), y: Math.sin(i + j) }, (MIN_GAP + 4 - dist(a, b)) / 2)
        Object.assign(a, clamp(sub(a, push)))
        Object.assign(b, clamp(add(b, push)))
      }
    render()
  }

  // ----- model edits (every one re-renders both views) -----

  const addState = (p: Pt) => {
    const n = chain.states.length
    chain.states.push({ label: `s_${n + 1}`, x: p.x, y: p.y })
    chain.P.forEach(row => row.push(0))
    chain.P.push(Array(n + 1).fill(0))
    sel = { kind: 'state', i: n }
    render()
  }

  const removeState = (i: number) => {
    chain.states.splice(i, 1)
    chain.P.splice(i, 1)
    chain.P.forEach(row => row.splice(i, 1))
    sel = null
    render()
  }

  const setEdge = (i: number, j: number, p: number) => {
    chain.P[i][j] = Math.max(0, Math.min(1, Number.isFinite(p) ? p : 0))
    render()
  }

  const setAbsorbing = (i: number, on: boolean) => {
    // absorbing means "stays put forever": the row becomes the identity row
    if (on) chain.P[i] = chain.P[i].map((_, j) => (j === i ? 1 : 0))
    else chain.P[i][i] = 0
    render()
  }

  const normalize = () => {
    chain.P.forEach((row, i) => {
      const s = rowSum(row)
      if (s > EPS) row.forEach((v, j) => (row[j] = v / s))
      else row[i] = 1 // no way out: make it absorbing
    })
    render()
  }

  // ----- rendering -----

  function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent: Element) {
    const e = document.createElementNS(SVG_NS, tag)
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v))
    parent.appendChild(e)
    return e
  }

  function renderCanvas() {
    svg.replaceChildren()
    const defs = el('defs', {}, svg)
    const marker = el('marker', { id: 'mk-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, defs)
    el('path', { d: 'M0,0 L10,5 L0,10 z', class: 'mk-arrowhead' }, marker)
    const n = chain.states.length
    const overlapping = new Set(overlappingPairs(chain).flat())

    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        if (chain.P[i][j] <= 0) continue
        const g = edgeGeometry(chain, i, j)
        const selected = sel?.kind === 'edge' && sel.i === i && sel.j === j
        const group = el('g', { class: `mk-edge${selected ? ' selected' : ''}`, 'data-i': i, 'data-j': j }, svg)
        el('path', { d: g.d, class: 'mk-edge-hit' }, group) // wide invisible stroke so thin edges are easy to click
        el('path', { d: g.d, class: 'mk-edge-line', 'marker-end': 'url(#mk-arrow)' }, group)
        const t = el('text', { x: g.label.x, y: g.label.y, class: 'mk-edge-label' }, group)
        t.textContent = fmt(chain.P[i][j])
      }

    chain.states.forEach((s, i) => {
      const cls = ['mk-state']
      if (sel?.kind === 'state' && sel.i === i) cls.push('selected')
      if (!isValidRow(chain.P[i])) cls.push('invalid')
      if (overlapping.has(i)) cls.push('overlap')
      if (isAbsorbingRow(chain.P, i)) cls.push('absorbing')
      const group = el('g', { class: cls.join(' '), 'data-state': i }, svg)
      el('circle', { cx: s.x, cy: s.y, r: R }, group)
      if (isAbsorbingRow(chain.P, i)) el('circle', { cx: s.x, cy: s.y, r: R - 4, class: 'mk-inner' }, group)
      const t = el('text', { x: s.x, y: s.y }, group)
      t.textContent = prettyLabel(s.label)
      if (t.textContent.length > 3) t.setAttribute('class', 'mk-small')
    })
  }

  function renderMatrix() {
    const n = chain.states.length
    const table = document.createElement('table')
    const head = table.insertRow()
    head.insertCell().textContent = 'from \\ to'
    chain.states.forEach(s => (head.insertCell().textContent = prettyLabel(s.label)))
    head.insertCell().textContent = 'Σ'
    const absHead = head.insertCell()
    absHead.textContent = 'Abs.'
    absHead.title = 'Absorbing: once the chain enters this state it never leaves (P(i→i) = 1)'
    for (let i = 0; i < n; i++) {
      const tr = table.insertRow()
      const name = document.createElement('input')
      name.className = 'mk-name'
      name.value = chain.states[i].label
      name.title = 'State name (LaTeX math, e.g. s_1)'
      name.onchange = () => {
        chain.states[i].label = name.value.trim() || `s_${i + 1}`
        render()
      }
      tr.insertCell().appendChild(name)
      for (let j = 0; j < n; j++) {
        const input = document.createElement('input')
        input.type = 'number'
        input.min = '0'
        input.max = '1'
        input.step = '0.05'
        input.value = chain.P[i][j] ? fmt(chain.P[i][j]) : ''
        input.placeholder = '0'
        input.onchange = () => setEdge(i, j, parseFloat(input.value || '0'))
        const td = tr.insertCell()
        if (sel?.kind === 'edge' && sel.i === i && sel.j === j) td.className = 'selected'
        td.appendChild(input)
      }
      const sumCell = tr.insertCell()
      const ok = isValidRow(chain.P[i])
      sumCell.textContent = `${fmt(rowSum(chain.P[i]))} ${ok ? '✓' : '✗'}`
      sumCell.className = ok ? 'mk-ok' : 'mk-bad'
      if (!ok) tr.className = 'mk-invalid-row'
      const abs = document.createElement('input')
      abs.type = 'checkbox'
      abs.className = 'mk-abs'
      abs.checked = isAbsorbingRow(chain.P, i)
      abs.title = 'Absorbing state'
      abs.onchange = () => setAbsorbing(i, abs.checked)
      tr.insertCell().appendChild(abs)
    }
    matrixEl.replaceChildren(table)
  }

  function renderSelection() {
    selEl.replaceChildren()
    if (!sel) {
      selEl.textContent = chain.states.length ? 'Nothing selected' : 'Double-click the canvas to add your first state'
      focusedEdge = null
      return
    }
    const del = document.createElement('button')
    del.type = 'button'
    del.textContent = 'Delete'
    if (sel.kind === 'state') {
      const i = sel.i
      const label = document.createElement('input')
      label.value = chain.states[i].label
      label.onchange = () => {
        chain.states[i].label = label.value.trim() || `s_${i + 1}`
        render()
      }
      del.onclick = () => removeState(i)
      selEl.append('State ', label, ' ', del)
      focusedEdge = null
      return
    }
    const { i, j } = sel
    const p = document.createElement('input')
    p.type = 'number'
    p.min = '0'
    p.max = '1'
    p.step = '0.05'
    p.value = fmt(chain.P[i][j])
    p.onchange = () => setEdge(i, j, parseFloat(p.value || '0'))
    del.onclick = () => {
      sel = null
      setEdge(i, j, 0)
    }
    selEl.append(`${chain.states[i].label} → ${chain.states[j].label}  probability `, p, ' ', del)
    // only grab focus when an edge is newly selected, not on every re-render
    const key = `${i},${j}`
    if (key !== focusedEdge) queueMicrotask(() => p.select())
    focusedEdge = key
  }
  let focusedEdge: string | null = null

  function renderStatus() {
    const bad = chain.states.map((s, i) => (isValidRow(chain.P[i]) ? null : s.label)).filter(Boolean)
    const overlaps = overlappingPairs(chain)
    statusEl.replaceChildren()
    if (!chain.states.length) {
      statusEl.textContent = 'Add at least one state.'
      statusEl.className = 'mk-status mk-bad'
    } else if (bad.length) {
      statusEl.textContent = `Each row must sum to 1. Fix: ${bad.join(', ')} (or use Normalize rows).`
      statusEl.className = 'mk-status mk-bad'
    } else if (overlaps.length) {
      const names = overlaps.map(([i, j]) => `${chain.states[i].label}/${chain.states[j].label}`).join(', ')
      statusEl.className = 'mk-status mk-bad'
      const fix = document.createElement('button')
      fix.type = 'button'
      fix.textContent = 'Fix layout'
      fix.onclick = fixOverlaps
      statusEl.append(`States overlap (${names}). `, fix)
    } else {
      statusEl.textContent = 'All rows sum to 1 ✓'
      statusEl.className = 'mk-status mk-ok'
    }
    insertBtn.disabled = !chain.states.length || bad.length > 0 || overlaps.length > 0
  }

  function renderAnalysis() {
    analysisEl.replaceChildren()
    const rowsOk = chain.states.length > 0 && chain.P.every(isValidRow)
    const a = rowsOk ? analyze(chain.P) : null
    const ok = !!a?.ok
    showCanonical.disabled = showAnalysis.disabled = !ok
    if (!a) return
    const title = document.createElement('div')
    title.className = 'mk-analysis-title'
    title.textContent = 'Absorption probabilities'
    analysisEl.appendChild(title)
    if (!a.ok) {
      const msg = document.createElement('div')
      msg.className = 'muted'
      msg.textContent = a.stuck ? `From ${a.stuck.map(i => chain.states[i].label).join(', ')} the chain can ${a.reason}` : a.reason
      analysisEl.appendChild(msg)
      return
    }
    analysisEl.appendChild(analysisTable(a))
  }

  function analysisTable(a: OkAnalysis) {
    const table = document.createElement('table')
    const head = table.insertRow()
    head.insertCell().textContent = 'start \\ ends in'
    a.absorbing.forEach(j => (head.insertCell().textContent = prettyLabel(chain.states[j].label)))
    head.insertCell().textContent = 'E[steps]'
    a.transient.forEach((i, r) => {
      const tr = table.insertRow()
      tr.insertCell().textContent = prettyLabel(chain.states[i].label)
      const cells = [...a.B[r], a.t[r]]
      for (const v of cells) {
        const td = tr.insertCell()
        const exact = v.toString()
        td.textContent = exact.includes('/') ? `${exact} ≈ ${v.decimal()}` : exact
        td.title = `${exact} = ${v.decimal(8)}`
      }
    })
    return table
  }

  function render() {
    sizeFor(chain.states.length)
    renderCanvas()
    renderMatrix()
    renderSelection()
    renderStatus()
    renderAnalysis()
  }

  // ----- canvas interaction -----

  const toSvg = (ev: { clientX: number; clientY: number }): Pt => {
    const r = svg.getBoundingClientRect()
    return { x: ((ev.clientX - r.left) / r.width) * W, y: ((ev.clientY - r.top) / r.height) * H }
  }

  svg.ondblclick = ev => {
    if ((ev.target as Element).closest('.mk-state, .mk-edge')) return
    const p = clamp(toSvg(ev))
    // too close to an existing state? use the nearest free spot instead
    addState(clearance(p) < MIN_GAP + 8 ? freeSpot(p) : p)
  }

  svg.onpointerdown = ev => {
    const target = ev.target as Element
    const stateEl = target.closest('.mk-state')
    const edgeEl = target.closest('.mk-edge')
    if (edgeEl) {
      sel = { kind: 'edge', i: +edgeEl.getAttribute('data-i')!, j: +edgeEl.getAttribute('data-j')! }
      return render()
    }
    if (!stateEl) {
      sel = null
      return render()
    }
    ev.preventDefault()
    const i = +stateEl.getAttribute('data-state')!
    const start = toSvg(ev)
    const origin = { x: chain.states[i].x, y: chain.states[i].y }
    let moved = false
    let temp: SVGLineElement | null = null
    if (ev.shiftKey) temp = el('line', { x1: origin.x, y1: origin.y, x2: start.x, y2: start.y, class: 'mk-temp' }, svg)
    // capture keeps the drag alive outside the canvas; it throws if the pointer is already gone
    try { svg.setPointerCapture(ev.pointerId) } catch {}

    svg.onpointermove = mv => {
      const p = toSvg(mv)
      if (temp) {
        temp.setAttribute('x2', String(p.x))
        temp.setAttribute('y2', String(p.y))
        return
      }
      if (!moved && len(sub(p, start)) < 3) return
      moved = true
      Object.assign(chain.states[i], clamp(add(origin, sub(p, start))))
      renderCanvas()
    }
    svg.onpointerup = up => {
      svg.onpointermove = svg.onpointerup = null
      try { svg.releasePointerCapture(up.pointerId) } catch {}
      if (temp) {
        temp.remove()
        // which state did the drag end on?
        const p = toSvg(up)
        const j = chain.states.findIndex(s => len(sub(s, p)) <= R + 4)
        if (j < 0) return render()
        if (chain.P[i][j] <= 0) {
          const remaining = 1 - rowSum(chain.P[i])
          chain.P[i][j] = remaining > EPS ? +remaining.toFixed(4) : 0.5
        }
        sel = { kind: 'edge', i, j }
        return render()
      }
      if (!moved) sel = { kind: 'state', i }
      render()
    }
  }

  dlg.onkeydown = ev => {
    if (ev.key !== 'Delete' && ev.key !== 'Backspace') return
    if ((ev.target as HTMLElement).tagName === 'INPUT') return
    if (sel?.kind === 'state') removeState(sel.i)
    else if (sel?.kind === 'edge') {
      const { i, j } = sel
      sel = null
      setEdge(i, j, 0)
    }
  }

  // ----- buttons -----

  q<HTMLElement>('.mk-buttons').onclick = ev => {
    const act = (ev.target as HTMLElement).dataset.act
    if (act === 'add') addState(freeSpot())
    else if (act === 'row') rowLayout()
    else if (act === 'circle') circleLayout()
    else if (act === 'normalize') normalize()
  }
  q<HTMLElement>('[data-act=cancel]').onclick = () => dlg.close()
  caption.oninput = () => (chain.caption = caption.value)
  showMatrix.onchange = () => (chain.showMatrix = showMatrix.checked)
  showCanonical.onchange = () => (chain.showCanonical = showCanonical.checked)
  showAnalysis.onchange = () => (chain.showAnalysis = showAnalysis.checked)

  insertBtn.onclick = () => {
    if (insertBtn.disabled) return
    const id = existing ? labelIdFrom(view, existing) : `markov-${Date.now().toString(36).slice(-4)}`
    const out = chainToLatex(chain, id)
    dlg.close()
    if (existing) {
      view.dispatch({ changes: { from: existing.from, to: existing.to, insert: out.latex }, userEvent: 'input.format' })
      view.focus()
    } else {
      insertRawBlock(view, out.latex)
    }
    ctx.ensurePackage('tikz')
    ctx.ensurePreamble('\\usetikzlibrary{automata}', /\\usetikzlibrary\s*\{[^}]*\bautomata\b/)
    if (out.needsMatrixLib)
      ctx.ensurePreamble(
        '\\usetikzlibrary{matrix,calc}',
        /^(?=[\s\S]*\\usetikzlibrary\s*\{[^}]*\bmatrix\b)(?=[\s\S]*\\usetikzlibrary\s*\{[^}]*\bcalc\b)/
      )
    if (out.needsAmsmath) ctx.ensurePackage('amsmath')
    if (out.needsGraphicx) ctx.ensurePackage('graphicx')
  }

  render()
  dlg.showModal()
}

/** Keep the original \label when re-editing so existing \ref{}s stay valid. */
function labelIdFrom(view: EditorView, existing: { from: number; to: number }) {
  const block = view.state.sliceDoc(existing.from, existing.to)
  return block.match(/\\label\{fig:([^}]+)\}/)?.[1] ?? `markov-${Date.now().toString(36).slice(-4)}`
}
