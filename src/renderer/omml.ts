// Word equations (Office Math Markup Language, inside .docx files, including Google Docs exports) → LaTeX.
// Covers what Word's equation editor produces: fractions, scripts, roots, brackets, sums/integrals, functions,
// limits, accents, bars, braces, matrices and equation arrays; symbols are mapped to LaTeX commands.

const SYMBOLS: Record<string, string> = {
  α: '\\alpha', β: '\\beta', γ: '\\gamma', δ: '\\delta', ε: '\\varepsilon', ϵ: '\\epsilon', ζ: '\\zeta', η: '\\eta', θ: '\\theta', ϑ: '\\vartheta',
  ι: '\\iota', κ: '\\kappa', λ: '\\lambda', μ: '\\mu', ν: '\\nu', ξ: '\\xi', π: '\\pi', ϖ: '\\varpi', ρ: '\\rho', ϱ: '\\varrho', σ: '\\sigma',
  ς: '\\varsigma', τ: '\\tau', υ: '\\upsilon', φ: '\\varphi', ϕ: '\\phi', χ: '\\chi', ψ: '\\psi', ω: '\\omega',
  Γ: '\\Gamma', Δ: '\\Delta', Θ: '\\Theta', Λ: '\\Lambda', Ξ: '\\Xi', Π: '\\Pi', Σ: '\\Sigma', Υ: '\\Upsilon', Φ: '\\Phi', Ψ: '\\Psi', Ω: '\\Omega',
  '≤': '\\leq', '≥': '\\geq', '≠': '\\neq', '≈': '\\approx', '≡': '\\equiv', '∼': '\\sim', '≃': '\\simeq', '≅': '\\cong', '∝': '\\propto',
  '≪': '\\ll', '≫': '\\gg', '∞': '\\infty', '×': '\\times', '·': '\\cdot', '⋅': '\\cdot', '÷': '\\div', '±': '\\pm', '∓': '\\mp',
  '→': '\\to', '←': '\\leftarrow', '↔': '\\leftrightarrow', '⇒': '\\Rightarrow', '⇐': '\\Leftarrow', '⇔': '\\Leftrightarrow', '↦': '\\mapsto',
  '∈': '\\in', '∉': '\\notin', '∋': '\\ni', '⊂': '\\subset', '⊃': '\\supset', '⊆': '\\subseteq', '⊇': '\\supseteq', '∪': '\\cup', '∩': '\\cap',
  '∀': '\\forall', '∃': '\\exists', '∄': '\\nexists', '∂': '\\partial', '∇': '\\nabla', '∅': '\\emptyset', '¬': '\\neg', '∧': '\\wedge', '∨': '\\vee',
  '⊥': '\\perp', '∥': '\\parallel', '∠': '\\angle', '∘': '\\circ', '∗': '*', '−': '-', '…': '\\ldots', '⋯': '\\cdots', '⋮': '\\vdots', '⋱': '\\ddots',
  '′': "'", '″': "''", '°': '^\\circ', 'ℏ': '\\hbar', 'ℓ': '\\ell', '∑': '\\sum', '∏': '\\prod', '∫': '\\int', '∮': '\\oint', '√': '\\surd',
  ℝ: '\\mathbb{R}', ℕ: '\\mathbb{N}', ℤ: '\\mathbb{Z}', ℚ: '\\mathbb{Q}', ℂ: '\\mathbb{C}', '⟨': '\\langle', '⟩': '\\rangle', '∆': '\\Delta',
  '{': '\\{', '}': '\\}', '%': '\\%', '#': '\\#', '$': '\\$', '_': '\\_', '~': '\\sim', '\u00A0': ' ', '\u2009': '\\,',
}
const NARY: Record<string, string> = { '∑': '\\sum', '∏': '\\prod', '∐': '\\coprod', '∫': '\\int', '∬': '\\iint', '∭': '\\iiint', '∮': '\\oint', '⋃': '\\bigcup', '⋂': '\\bigcap', '⋁': '\\bigvee', '⋀': '\\bigwedge' }
const ACCENTS: Record<string, string> = { '̂': '\\hat', '̃': '\\tilde', '̇': '\\dot', '̈': '\\ddot', '⃗': '\\vec', '̄': '\\bar', '̅': '\\bar', '̆': '\\breve', '̌': '\\check', '́': '\\acute', '̀': '\\grave' }
const DELIMS: Record<string, string> = { '(': '(', ')': ')', '[': '[', ']': ']', '{': '\\{', '}': '\\}', '|': '|', '‖': '\\|', '⟨': '\\langle', '⟩': '\\rangle', '⌈': '\\lceil', '⌉': '\\rceil', '⌊': '\\lfloor', '⌋': '\\rfloor', '': '.' }
const FUNCTIONS = new Set(['sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh', 'coth', 'log', 'ln', 'exp', 'lim', 'max', 'min', 'sup', 'inf', 'det', 'deg', 'gcd', 'arg', 'dim', 'ker', 'hom', 'Pr', 'lg'])

const kids = (el: Element) => [...el.children]
const child = (el: Element, name: string) => kids(el).find(c => c.localName === name) ?? null
/** A property value, e.g. <m:begChr m:val="["/> inside <m:dPr>. */
const prop = (el: Element, pr: string, name: string) => {
  const p = child(el, pr)
  const v = p && child(p, name)
  return v ? v.getAttribute('m:val') ?? v.getAttributeNS(v.namespaceURI, 'val') : null
}

function text(s: string) {
  let out = ''
  for (const ch of s) {
    const cmd = SYMBOLS[ch]
    if (cmd) out += /^\\[a-zA-Z]+$/.test(cmd) ? `${cmd} ` : cmd
    else out += ch
  }
  return out
}

const group = (s: string) => (s.length === 1 ? s : `{${s.trim()}}`)
const arg = (el: Element, name: string) => {
  const c = child(el, name)
  return c ? conv(c).trim() : ''
}

function conv(el: Element): string {
  switch (el.localName) {
    case 'r':
      return kids(el).filter(c => c.localName === 't').map(t => text(t.textContent ?? '')).join('')
    case 'f': {
      const type = prop(el, 'fPr', 'type')
      const num = arg(el, 'num')
      const den = arg(el, 'den')
      return type === 'lin' ? `${group(num)}/${group(den)}` : type === 'noBar' ? `\\genfrac{}{}{0pt}{}{${num}}{${den}}` : `\\frac{${num}}{${den}}`
    }
    case 'sSup':
      return `${group(arg(el, 'e'))}^{${arg(el, 'sup')}}`
    case 'sSub':
      return `${group(arg(el, 'e'))}_{${arg(el, 'sub')}}`
    case 'sSubSup':
      return `${group(arg(el, 'e'))}_{${arg(el, 'sub')}}^{${arg(el, 'sup')}}`
    case 'sPre':
      return `{}_{${arg(el, 'sub')}}^{${arg(el, 'sup')}}${group(arg(el, 'e'))}`
    case 'rad': {
      const deg = arg(el, 'deg')
      return deg && prop(el, 'radPr', 'degHide') !== '1' ? `\\sqrt[${deg}]{${arg(el, 'e')}}` : `\\sqrt{${arg(el, 'e')}}`
    }
    case 'd': {
      const beg = prop(el, 'dPr', 'begChr') ?? '('
      const end = prop(el, 'dPr', 'endChr') ?? ')'
      const sep = prop(el, 'dPr', 'sepChr') ?? '|'
      const parts = kids(el).filter(c => c.localName === 'e').map(e => conv(e).trim())
      return `\\left${DELIMS[beg] ?? beg} ${parts.join(` ${text(sep)} `)} \\right${DELIMS[end] ?? end}`
    }
    case 'nary': {
      const chr = prop(el, 'naryPr', 'chr') ?? '∫'
      const hideSub = prop(el, 'naryPr', 'subHide') === '1'
      const hideSup = prop(el, 'naryPr', 'supHide') === '1'
      const sub = hideSub ? '' : arg(el, 'sub')
      const sup = hideSup ? '' : arg(el, 'sup')
      return `${NARY[chr] ?? text(chr)}${sub ? `_{${sub}}` : ''}${sup ? `^{${sup}}` : ''} ${arg(el, 'e')}`
    }
    case 'func': {
      const nameEl = child(el, 'fName')
      const raw = nameEl ? conv(nameEl).trim() : ''
      const name = FUNCTIONS.has(raw) ? `\\${raw}` : /^[A-Za-z]+$/.test(raw) ? `\\operatorname{${raw}}` : raw
      return `${name} ${group(arg(el, 'e'))}`
    }
    case 'limLow': {
      const base = arg(el, 'e')
      const lim = arg(el, 'lim')
      return FUNCTIONS.has(base) ? `\\${base}_{${lim}}` : `\\underset{${lim}}{${base}}`
    }
    case 'limUpp':
      return `\\overset{${arg(el, 'lim')}}{${arg(el, 'e')}}`
    case 'acc': {
      const chr = prop(el, 'accPr', 'chr') ?? '̂'
      return `${ACCENTS[chr] ?? '\\hat'}{${arg(el, 'e')}}`
    }
    case 'bar':
      return prop(el, 'barPr', 'pos') === 'bot' ? `\\underline{${arg(el, 'e')}}` : `\\overline{${arg(el, 'e')}}`
    case 'groupChr': {
      const chr = prop(el, 'groupChrPr', 'chr') ?? '⏟'
      const pos = prop(el, 'groupChrPr', 'pos') ?? 'bot'
      return chr === '⏞' || pos === 'top' ? `\\overbrace{${arg(el, 'e')}}` : `\\underbrace{${arg(el, 'e')}}`
    }
    case 'borderBox':
      return `\\boxed{${arg(el, 'e')}}`
    case 'm': {
      const rows = kids(el).filter(c => c.localName === 'mr').map(r => kids(r).filter(c => c.localName === 'e').map(e => conv(e).trim()).join(' & '))
      return `\\begin{matrix} ${rows.join(' \\\\ ')} \\end{matrix}`
    }
    case 'eqArr': {
      const rows = kids(el).filter(c => c.localName === 'e').map(e => conv(e).trim())
      return `\\begin{aligned} ${rows.join(' \\\\ ')} \\end{aligned}`
    }
    default:
      // containers (oMath, e, num, den, sub, sup, deg, lim, fName, box, phant…) and properties (…Pr) to skip
      if (/Pr$/.test(el.localName)) return ''
      return kids(el).map(conv).join('')
  }
}

/** One <m:oMath> or <m:oMathPara> element → LaTeX (without $ delimiters). */
export function ommlToLatex(el: Element): string {
  if (el.localName === 'oMathPara') {
    const lines = kids(el).filter(c => c.localName === 'oMath').map(m => conv(m).trim())
    return lines.length > 1 ? `\\begin{gathered} ${lines.join(' \\\\ ')} \\end{gathered}` : lines[0] ?? ''
  }
  return conv(el).replace(/\s+/g, ' ').trim()
}
