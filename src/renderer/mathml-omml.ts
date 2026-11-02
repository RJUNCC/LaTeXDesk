// LaTeX maths → Word equations. KaTeX turns the LaTeX into MathML; this turns MathML into OMML, the format of
// Word's own equation editor, so equations stay editable in Word (the reverse of omml.ts, used for import).
import katex from 'katex'

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

const NARY = new Set([...'∑∏∐∫∬∭∮∯∰⋃⋂⋁⋀⨁⨂⨀⨄⨆'])
const INTEGRALS = new Set([...'∫∬∭∮∯∰'])
// operators that end the operand of a sum or integral at the same level
const STOP = new Set([...'=<>≤≥≠≈≡∼≃≅∝→←↔⇒⇐⇔,;+−-∣'])
const ACCENTS: Record<string, string> = {
  '^': '̂', 'ˆ': '̂', '~': '̃', '˜': '̃', '˙': '̇', '¨': '̈', 'ˇ': '̌', '´': '́',
  '`': '̀', 'ˋ': '̀', '˘': '̆', '→': '⃗', '⃗': '⃗', '°': '̊', '˚': '̊',
}
const SCRIPTS: Record<string, string> = { 'double-struck': 'double-struck', fraktur: 'fraktur', script: 'script', 'sans-serif': 'sans-serif', monospace: 'monospace' }

const kids = (el: Element) => [...el.children]

function run(text: string, style?: 'p' | 'b' | 'bi' | 'i', script?: string, normalText = false) {
  // invisible function-application and separator characters KaTeX adds
  text = text.replace(/[⁡-⁤]/g, '')
  if (!text) return ''
  const props = [normalText ? '<m:nor/>' : '', script ? `<m:scr m:val="${script}"/>` : '', style && style !== 'i' ? `<m:sty m:val="${style}"/>` : ''].join('')
  return `<m:r>${props ? `<m:rPr>${props}</m:rPr>` : ''}<w:rPr><w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math"/></w:rPr><m:t xml:space="preserve">${esc(text)}</m:t></m:r>`
}

const wrap = (tag: string, inner: string) => `<m:${tag}>${inner}</m:${tag}>`

function token(el: Element) {
  const text = el.textContent ?? ''
  const variant = el.getAttribute('mathvariant') ?? ''
  const script = SCRIPTS[variant]
  const bold = /bold/.test(variant)
  switch (el.tagName) {
    case 'mi':
      // single letters are italic; names (sin, log) and mathvariant="normal" are upright
      if (variant === 'normal' || (text.length > 1 && !variant)) return run(text, bold ? 'b' : 'p', script)
      return run(text, bold ? (variant.includes('italic') ? 'bi' : 'b') : script ? 'p' : 'i', script)
    case 'mn':
      return run(text, bold ? 'b' : 'p', script)
    case 'mo':
      // KaTeX writes | as "divides" (∣), which Word spaces like a relation
      return run(text.replace(/∣/g, '|'), bold ? 'b' : 'p')
    case 'mtext':
      return run(text, undefined, undefined, true)
    case 'ms':
      return run(`"${text}"`, 'p')
  }
  return ''
}

const isFence = (el: Element | undefined) => !!el && el.tagName === 'mo' && el.getAttribute('fence') === 'true'
const opChar = (el: Element | undefined) => (el && el.tagName === 'mo' ? (el.textContent ?? '').trim() : '')

/** A row of siblings, with \left…\right fences and sums/integrals taking their operand. */
function row(list: Element[]): string {
  // \left( … \right) — KaTeX marks the outer brackets as fences
  if (list.length >= 2 && isFence(list[0]) && isFence(list[list.length - 1])) {
    const inner = list.slice(1, -1)
    const parts: Element[][] = [[]]
    let sep = ''
    // \middle| separators split the contents
    for (const el of inner) {
      if (isFence(el)) {
        sep ||= opChar(el)
        parts.push([])
      } else parts[parts.length - 1].push(el)
    }
    const pr = `<m:dPr><m:begChr m:val="${esc(opChar(list[0]))}"/>${sep ? `<m:sepChr m:val="${esc(sep)}"/>` : ''}<m:endChr m:val="${esc(opChar(list[list.length - 1]))}"/></m:dPr>`
    return wrap('d', pr + parts.map(p => wrap('e', row(p))).join(''))
  }
  let out = ''
  for (let i = 0; i < list.length; i++) {
    const el = list[i]
    // cases and similar: a brace (or bracket) before a table stretches to its height
    if (el.tagName === 'mo' && /^[{(\[|‖]$/.test(opChar(el)) && list[i + 1]?.tagName === 'mtable') {
      const closing = /^[})\]|‖]$/.test(opChar(list[i + 2])) ? opChar(list[i + 2]) : ''
      out += wrap('d', `<m:dPr><m:begChr m:val="${esc(opChar(el))}"/><m:endChr m:val="${esc(closing)}"/></m:dPr>` + wrap('e', node(list[i + 1])))
      i += closing ? 2 : 1
      continue
    }
    const nary = naryOf(el)
    if (nary) {
      // the operand: what follows, up to the next relation or plus/minus at this level
      const operand: Element[] = []
      while (i + 1 < list.length && !STOP.has(opChar(list[i + 1]))) operand.push(list[++i])
      out += nary(row(operand))
      continue
    }
    out += node(el)
  }
  return out
}

/** A sum, product or integral with its limits, waiting for its operand. */
function naryOf(el: Element): ((operand: string) => string) | null {
  const [base, a, b] = kids(el)
  let chr = ''
  let sub = ''
  let sup = ''
  let loc = 'undOvr'
  if (el.tagName === 'mo' && NARY.has(opChar(el))) chr = opChar(el)
  else if (['msub', 'msup', 'msubsup', 'munder', 'mover', 'munderover'].includes(el.tagName) && NARY.has(opChar(base))) {
    chr = opChar(base)
    loc = el.tagName.startsWith('ms') ? 'subSup' : 'undOvr'
    if (el.tagName === 'msub' || el.tagName === 'munder') sub = node(a)
    else if (el.tagName === 'msup' || el.tagName === 'mover') sup = node(a)
    else (sub = node(a)), (sup = node(b))
  } else return null
  if (INTEGRALS.has(chr)) loc = 'subSup'
  const pr = `<m:naryPr>${chr === '∫' ? '' : `<m:chr m:val="${chr}"/>`}<m:limLoc m:val="${loc}"/>${sub ? '' : '<m:subHide m:val="1"/>'}${sup ? '' : '<m:supHide m:val="1"/>'}</m:naryPr>`
  return operand => wrap('nary', pr + wrap('sub', sub) + wrap('sup', sup) + wrap('e', operand))
}

function table(el: Element) {
  const rows = kids(el).filter(r => r.tagName === 'mtr' || r.tagName === 'mlabeledtr')
  const aligns = (el.getAttribute('columnalign') ?? '').split(/\s+/)
  // aligned / gathered / split: rows of an equation; anything else (matrices, cases) is a matrix
  const isEquationRows = aligns.length > 1 && aligns.every((a, i) => a === (i % 2 ? 'left' : 'right'))
  const cells = (r: Element) => kids(r).filter(c => c.tagName === 'mtd')
  const width = Math.max(1, ...rows.map(r => cells(r).length))
  // (a single column of rows, e.g. gathered or a column vector, stacks the same way)
  if (isEquationRows || (width === 1 && rows.length > 1)) {
    // each & stays an & run: Word lines the rows up at it (checked in Word: <m:aln/> is ignored there)
    const aligned = (cell: string, i: number) => (i === 0 ? cell : `<m:r><m:t>&amp;</m:t></m:r>${cell}`)
    return wrap('eqArr', rows.map(r => wrap('e', cells(r).map((c, i) => aligned(row(kids(c)), i)).join(''))).join(''))
  }
  const jc = aligns[0] === 'left' ? 'left' : aligns[0] === 'right' ? 'right' : 'center'
  const pr = `<m:mPr><m:mcs><m:mc><m:mcPr><m:count m:val="${width}"/><m:mcJc m:val="${jc}"/></m:mcPr></m:mc></m:mcs></m:mPr>`
  return wrap('m', pr + rows.map(r => wrap('mr', Array.from({ length: width }, (_, i) => wrap('e', cells(r)[i] ? row(kids(cells(r)[i])) : '')).join(''))).join(''))
}

function node(el: Element | undefined): string {
  if (!el) return ''
  const [a, b, c] = kids(el)
  switch (el.tagName) {
    case 'math':
    case 'mrow':
    case 'mstyle':
    case 'mpadded':
    case 'semantics':
    case 'mtd':
      return row(kids(el).filter(k => k.tagName !== 'annotation' && k.tagName !== 'annotation-xml'))
    case 'mi':
    case 'mn':
    case 'mo':
    case 'mtext':
    case 'ms':
      return token(el)
    case 'mspace': {
      const w = parseFloat(el.getAttribute('width') ?? '0')
      return w <= 0 ? '' : run(w < 0.3 ? ' ' : w < 0.6 ? ' ' : ' ', 'p')
    }
    case 'mphantom':
      return ''
    case 'mfrac': {
      const noBar = /^0/.test(el.getAttribute('linethickness') ?? '')
      return wrap('f', (noBar ? '<m:fPr><m:type m:val="noBar"/></m:fPr>' : '') + wrap('num', node(a)) + wrap('den', node(b)))
    }
    case 'msqrt':
      return wrap('rad', '<m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/>' + wrap('e', row(kids(el))))
    case 'mroot':
      return wrap('rad', wrap('deg', node(b)) + wrap('e', node(a)))
    case 'msup':
      return wrap('sSup', wrap('e', node(a)) + wrap('sup', node(b)))
    case 'msub':
      return wrap('sSub', wrap('e', node(a)) + wrap('sub', node(b)))
    case 'msubsup':
      return wrap('sSubSup', wrap('e', node(a)) + wrap('sub', node(b)) + wrap('sup', node(c)))
    case 'mover': {
      const mark = opChar(b)
      if (el.getAttribute('accent') === 'true' && ACCENTS[mark]) return wrap('acc', `<m:accPr><m:chr m:val="${ACCENTS[mark]}"/></m:accPr>` + wrap('e', node(a)))
      if (/^[‾¯_̅]$/.test(mark)) return wrap('bar', '<m:barPr><m:pos m:val="top"/></m:barPr>' + wrap('e', node(a)))
      if (mark === '⏞' || mark === '︷') return wrap('groupChr', '<m:groupChrPr><m:chr m:val="⏞"/><m:pos m:val="top"/><m:vertJc m:val="bot"/></m:groupChrPr>' + wrap('e', node(a)))
      // \overbrace{…}^{label}: the brace is the base
      return wrap('limUpp', wrap('e', node(a)) + wrap('lim', node(b)))
    }
    case 'munder': {
      const mark = opChar(b)
      if (/^[‾¯_̲]$/.test(mark)) return wrap('bar', '<m:barPr><m:pos m:val="bot"/></m:barPr>' + wrap('e', node(a)))
      if (mark === '⏟' || mark === '︸') return wrap('groupChr', '<m:groupChrPr><m:chr m:val="⏟"/><m:pos m:val="bot"/><m:vertJc m:val="top"/></m:groupChrPr>' + wrap('e', node(a)))
      return wrap('limLow', wrap('e', node(a)) + wrap('lim', node(b)))
    }
    case 'munderover':
      return wrap('limUpp', wrap('e', wrap('limLow', wrap('e', node(a)) + wrap('lim', node(b)))) + wrap('lim', node(c)))
    case 'mtable':
      return table(el)
    case 'menclose':
      return /box/.test(el.getAttribute('notation') ?? '') ? wrap('borderBox', wrap('e', row(kids(el)))) : row(kids(el))
  }
  return row(kids(el))
}

/** OMML for a LaTeX formula: `<m:oMath>` (inline), or `<m:oMathPara>` for a display equation of its own. */
export function latexToOmml(tex: string, display: boolean, macros: Record<string, string> = {}): string {
  const mathml = katex.renderToString(tex, { output: 'mathml', displayMode: display, throwOnError: false, strict: 'ignore', macros: { ...macros } })
  const doc = new DOMParser().parseFromString(mathml, 'text/html')
  const math = doc.querySelector('math')
  // a formula KaTeX can't read is kept as its LaTeX, so nothing is lost
  if (!math || doc.querySelector('.katex-error')) return `<m:oMath>${run(tex, 'p', undefined, true)}</m:oMath>`
  const body = `<m:oMath>${node(math)}</m:oMath>`
  return display ? `<m:oMathPara>${body}</m:oMathPara>` : body
}
