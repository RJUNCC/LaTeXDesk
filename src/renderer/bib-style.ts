// Reference styles a beginner can pick by name. Each is a citation package plus a BibTeX style that compiles
// with MiKTeX, TeX Live and the built-in engine. Pure text functions over the main document.

export type BibStyle = { id: string; name: string; example: string; preamble: string[]; bst: string }

export const BIB_STYLES: BibStyle[] = [
  { id: 'apa', name: 'APA', example: '… as shown (Smith & Lee, 2020).', preamble: ['\\usepackage[natbibapa]{apacite}'], bst: 'apacite' },
  { id: 'harvard', name: 'Harvard', example: '… as shown (Smith & Lee 2020).', preamble: ['\\usepackage{natbib}', '\\renewcommand{\\harvardurl}[1]{\\textbf{URL:} \\url{#1}}'], bst: 'agsm' },
  { id: 'chicago', name: 'Chicago (author–date)', example: '… as shown (Smith and Lee 2020).', preamble: ['\\usepackage{natbib}'], bst: 'chicago' },
  { id: 'numbered', name: 'Numbered [1], in the order you cite', example: '… as shown [1].', preamble: ['\\usepackage[numbers]{natbib}'], bst: 'unsrtnat' },
  { id: 'numbered-az', name: 'Numbered [1], list sorted A–Z', example: '… as shown [1].', preamble: ['\\usepackage[numbers]{natbib}'], bst: 'plainnat' },
  { id: 'ieee', name: 'IEEE', example: '… as shown [1].', preamble: ['\\usepackage[numbers]{natbib}'], bst: 'IEEEtran' },
]

// styles found in older documents and templates, named for the picker
const OTHER_NAMES: Record<string, string> = {
  plain: 'Numbered [1], list sorted A–Z',
  unsrt: 'Numbered [1], in the order you cite',
  abbrv: 'Numbered [1], first names abbreviated',
  alpha: 'Labels like [Smi20]',
  plainnat: 'Author–year (Smith and Lee, 2020)',
  apalike: 'Author–year (Smith and Lee, 2020)',
  apacite: 'APA',
  'ACM-Reference-Format': 'ACM',
  splncs04: 'Springer LNCS',
  'elsarticle-num': 'Elsevier (numbered)',
}

// document classes that come with their own citation setup, which the picker must not change
const OWN_STYLE_CLASS = /^[^%\n]*\\documentclass\s*(?:\[[^\]]*\])?\s*\{\s*(IEEEtran|acmart|apa6|apa7|llncs|elsarticle|revtex4(?:-\d)?|aastex\d*|svjour3|mnras|achemso)\s*\}/m

const preambleEnd = (text: string) => {
  const i = text.search(/^[^%\n]*\\begin\s*\{document\}/m)
  return i < 0 ? text.length : i
}
const STYLE_LINE = /^([^%\n]*?)\\bibliographystyle\s*\{([^}]*)\}/m
const BIB_LINE = /^([^%\n]*?)\\bibliography\s*\{([^}]*)\}/m
// the preamble lines a style adds, so switching styles removes the previous one's
const MANAGED = [
  /^[ \t]*\\usepackage\s*(?:\[[^\]]*\])?\s*\{\s*natbib\s*\}[^\n]*\n?/m,
  /^[ \t]*\\usepackage\s*(?:\[[^\]]*\])?\s*\{\s*apacite\s*\}[^\n]*\n?/m,
  /^[ \t]*\\renewcommand\s*\{?\\harvardurl\}?[^\n]*\n?/m,
]

const loads = (preamble: string, pkg: string) => new RegExp(`^[^%\\n]*\\\\(?:usepackage|RequirePackage)\\s*(?:\\[[^\\]]*\\])?\\s*\\{[^}]*\\b${pkg}\\b[^}]*\\}`, 'm').test(preamble)

/** Why the style can't be changed here, or null. */
export function lockedReason(text: string) {
  const cls = text.match(OWN_STYLE_CLASS)?.[1]
  if (cls) return `This document uses the ${cls} template, which sets its own reference style.`
  if (loads(text.slice(0, preambleEnd(text)), 'biblatex')) return 'This document uses biblatex. Its style is set in the \\usepackage[style=…]{biblatex} line.'
  return null
}

/** Whether the document prints a reference list. */
export const hasBibliography = (text: string) => BIB_LINE.test(text) || /^[^%\n]*\\printbibliography/m.test(text)

/** The current style: one of BIB_STYLES when it matches, with a readable name either way. */
export function currentStyle(text: string): { id: string | null; name: string; bst: string | null } {
  const bst = text.match(STYLE_LINE)?.[2].trim() ?? null
  if (!bst) return { id: null, name: /^[^%\n]*\\printbibliography/m.test(text) ? 'biblatex' : 'Not chosen yet', bst }
  const preamble = text.slice(0, preambleEnd(text))
  const numbers = /\\usepackage\s*\[[^\]]*\bnumbers\b[^\]]*\]\s*\{\s*natbib\s*\}/.test(preamble)
  const style = BIB_STYLES.find(s => s.bst === bst && (s.bst !== 'plainnat' || numbers))
  return { id: style?.id ?? null, name: style?.name ?? OTHER_NAMES[bst] ?? bst, bst }
}

export const styleName = (bst: string) => BIB_STYLES.find(s => s.bst === bst)?.name ?? OTHER_NAMES[bst] ?? bst

/** \citep when the document's citation package has it (natbib, apacite's natbibapa), else \cite. */
export function citeCommand(text: string): 'citep' | 'cite' {
  const preamble = text.slice(0, preambleEnd(text))
  if (loads(preamble, 'natbib') || /\\usepackage\s*\[[^\]]*\bnatbibapa\b[^\]]*\]\s*\{\s*apacite\s*\}/.test(preamble)) return 'citep'
  if (/^[^%\n]*\\documentclass\s*\[[^\]]*\bnatbib\b[^\]]*\]\s*\{\s*apa[67]\s*\}/m.test(preamble)) return 'citep'
  return 'cite'
}

/**
 * The document with `styleId` as its reference style: the style's packages in the preamble (replacing the
 * previous style's), \bibliographystyle set, and a reference list before \end{document} if it has none.
 */
export function applyStyle(text: string, styleId: string, bibName = 'refs') {
  const style = BIB_STYLES.find(s => s.id === styleId)
  if (!style || lockedReason(text)) return text
  let preamble = text.slice(0, preambleEnd(text))
  let body = text.slice(preamble.length)
  for (const re of MANAGED) while (re.test(preamble)) preamble = preamble.replace(re, '')
  const lines = [...style.preamble]
  // web addresses in the reference list need \url, which hyperref also provides
  if (!loads(preamble, 'url') && !loads(preamble, 'hyperref')) lines.push('\\usepackage{url}')
  // after the other packages, but before hyperref, which wants to come last
  const hyperref = preamble.search(/^[^%\n]*\\usepackage\s*(?:\[[^\]]*\])?\s*\{\s*hyperref\s*\}/m)
  let at = hyperref
  if (at < 0) {
    const packages = [...preamble.matchAll(/^[^%\n]*\\usepackage[^\n]*\n?/gm)]
    const last = packages.at(-1) ?? preamble.match(/^[^%\n]*\\documentclass[^\n]*\n?/m)
    at = last ? last.index! + last[0].length : 0
  }
  if (at > 0 && preamble[at - 1] !== '\n') preamble = preamble.slice(0, at) + '\n' + preamble.slice(at), at++
  preamble = preamble.slice(0, at) + lines.join('\n') + '\n' + preamble.slice(at)

  const styleCmd = `\\bibliographystyle{${style.bst}}`
  if (STYLE_LINE.test(body)) body = body.replace(STYLE_LINE, (_m, before) => before + styleCmd)
  else if (STYLE_LINE.test(preamble)) preamble = preamble.replace(STYLE_LINE, (_m, before) => before + styleCmd)
  else if (BIB_LINE.test(body)) body = body.replace(BIB_LINE, m => `${styleCmd}\n${m}`)
  else {
    const end = body.search(/^[^%\n]*\\end\s*\{document\}/m)
    const list = `${styleCmd}\n\\bibliography{${bibName}}\n\n`
    body = end < 0 ? body + '\n' + list : body.slice(0, end) + list + body.slice(end)
  }
  return preamble + body
}
