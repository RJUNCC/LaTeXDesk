// Live equation preview: put the cursor in (or hover over) any math and see it rendered with KaTeX,
// without recompiling. Math is found with the grammar's math nodes; preamble \newcommands are honoured.
import { EditorState, Extension, StateField } from '@codemirror/state'
import { EditorView, Tooltip, hoverTooltip, showTooltip } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import type { SyntaxNode } from '@lezer/common'
import katex from 'katex'

type MathSpan = { from: number; to: number; src: string; display: boolean }

// environments KaTeX renders as-is; others (equation…) are reduced to their body
const PASS_THROUGH = /^(align\*?|gather\*?|multline\*?|alignat\*?|flalign\*?|eqnarray\*?|split)$/

let macros: Record<string, string> = {}

/** Read \newcommand / \renewcommand / \def / \DeclareMathOperator from a preamble for KaTeX. */
export function setPreambleMacros(preamble: string) {
  const out: Record<string, string> = {}
  const body = (s: string, start: number): [string, number] | null => {
    if (s[start] !== '{') return null
    let depth = 0
    for (let i = start; i < s.length; i++) {
      if (s[i] === '{') depth++
      else if (s[i] === '}' && --depth === 0) return [s.slice(start + 1, i), i + 1]
    }
    return null
  }
  for (const m of preamble.matchAll(/\\(?:re)?newcommand\*?\s*\{?\s*(\\[A-Za-z]+)\s*\}?\s*(?:\[(\d)\])?\s*(?:\[[^\]]*\])?\s*/g)) {
    const b = body(preamble, m.index! + m[0].length)
    if (b) out[m[1]] = b[0]
  }
  for (const m of preamble.matchAll(/\\DeclareMathOperator\*?\s*\{\s*(\\[A-Za-z]+)\s*\}\s*/g)) {
    const b = body(preamble, m.index! + m[0].length)
    if (b) out[m[1]] = `\\operatorname{${b[0]}}`
  }
  for (const m of preamble.matchAll(/\\def\s*(\\[A-Za-z]+)\s*/g)) {
    const b = body(preamble, m.index! + m[0].length)
    if (b) out[m[1]] = b[0]
  }
  macros = out
}

/** The math expression around `pos`, with its delimiters removed. */
function mathAt(state: EditorState, pos: number): MathSpan | null {
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1); n; n = n.parent) {
    if (n.type.is('$MathContainer')) {
      const text = state.sliceDoc(n.from, n.to)
      const m =
        text.match(/^\$\$([\s\S]*)\$\$$/) ? { src: text.slice(2, -2), display: true } :
        text.match(/^\$([\s\S]*)\$$/) ? { src: text.slice(1, -1), display: false } :
        text.startsWith('\\[') ? { src: text.slice(2, -2), display: true } :
        text.startsWith('\\(') ? { src: text.slice(2, -2), display: false } : null
      return m ? { from: n.from, to: n.to, ...m } : null
    }
    if (n.name === 'EquationEnvironment' || n.name === 'EquationArrayEnvironment') {
      const text = state.sliceDoc(n.from, n.to)
      const env = text.match(/^\\begin\{([^}]+)\}/)?.[1] ?? ''
      const src = PASS_THROUGH.test(env)
        ? text.replace(/^\\begin\{eqnarray(\*?)\}/, '\\begin{align$1}').replace(/\\end\{eqnarray(\*?)\}$/, '\\end{align$1}')
        : text.replace(/^\\begin\{[^}]+\}/, '').replace(/\\end\{[^}]+\}$/, '')
      return { from: n.from, to: n.to, src, display: true }
    }
  }
  return null
}

function render(span: MathSpan) {
  const dom = document.createElement('div')
  dom.className = 'cm-math-preview'
  const src = span.src.replace(/\\label\{[^}]*\}/g, '').replace(/\\(nonumber|notag)\b/g, '').trim()
  if (!src) return null
  katex.render(src, dom, { displayMode: span.display, throwOnError: false, strict: 'ignore', macros: { ...macros }, trust: false })
  return dom
}

function tooltipFor(span: MathSpan, pos = span.from): Tooltip | null {
  return {
    pos,
    above: true,
    arrow: true,
    create: () => ({ dom: render(span) ?? document.createElement('div') }),
  }
}

// shows while the cursor sits inside math
const cursorPreview = StateField.define<Tooltip | null>({
  create: () => null,
  update(value, tr) {
    if (!tr.docChanged && !tr.selection) return value
    const sel = tr.state.selection.main
    if (!sel.empty) return null
    const span = mathAt(tr.state, sel.head)
    return span && span.src.trim() ? tooltipFor(span) : null
  },
  provide: f => showTooltip.from(f),
})

// shows when the mouse hovers over math elsewhere
const hoverPreview = hoverTooltip((view, pos) => {
  const span = mathAt(view.state, pos)
  if (!span || !span.src.trim()) return null
  const cur = view.state.selection.main.head
  if (cur >= span.from && cur <= span.to) return null // the cursor preview is already showing it
  return { ...tooltipFor(span)!, end: span.to }
}, { hoverTime: 350 })

export function equationPreview(): Extension {
  return [cursorPreview, hoverPreview, EditorView.baseTheme({ '.cm-math-preview': { padding: '6px 10px', maxWidth: '520px', overflowX: 'auto' } })]
}
