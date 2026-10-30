// LaTeXDesk: Overleaf's visual editor typesets with MathJax. This stand-in offers the same calls, rendered
// with KaTeX (already bundled for previews), so the ported widgets work unchanged.
import katex from 'katex'
import renderMathInElement from 'katex/contrib/auto-render'

// \newcommand definitions from the preamble persist here between renders (KaTeX globalGroup)
let macros: Record<string, string> = {}

const options = (displayMode: boolean) => ({ displayMode, throwOnError: true, strict: 'ignore' as const, macros, globalGroup: true, trust: false })

const KaTeXAsMathJax = {
  /** Start of each render: forget macros so stale definitions don't linger. */
  texReset(_args?: unknown) {
    macros = {}
  },
  getMetricsFor(_element: HTMLElement, _display: boolean) {
    return {}
  },
  /** Render TeX into an element (MathJax returns an SVG container; KaTeX returns HTML). */
  async tex2svgPromise(tex: string, opts: { display?: boolean } = {}) {
    const el = document.createElement(opts.display ? 'div' : 'span')
    katex.render(tex, el, options(!!opts.display))
    return el
  },
  /** Typeset the $…$, \(…\), \[…\] maths inside these elements (titles, captions, theorem names). */
  async typesetPromise(elements: HTMLElement[]) {
    for (const el of elements)
      renderMathInElement(el, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '\\[', right: '\\]', display: true },
          { left: '$', right: '$', display: false },
          { left: '\\(', right: '\\)', display: false },
        ],
        throwOnError: false,
        strict: 'ignore',
        macros,
      })
  },
  typesetClear(_elements?: HTMLElement[]) {},
}

export type MathJaxStandIn = typeof KaTeXAsMathJax

export const loadMathJax = async (_options?: unknown): Promise<MathJaxStandIn> => KaTeXAsMathJax
