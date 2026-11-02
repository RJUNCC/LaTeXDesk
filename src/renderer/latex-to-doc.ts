// LaTeX → a simple document model (paragraphs, headings, lists, equations, tables, figures, footnotes), for
// Export to Word. It reads the LaTeX people commonly write: unknown commands keep their text, so nothing is
// silently lost. Numbers (sections, figures, equations), citations and \ref are filled in the way LaTeX does.

export type Style = {
  b?: boolean
  i?: boolean
  u?: boolean
  mono?: boolean
  sc?: boolean
  sup?: boolean
  sub?: boolean
  strike?: boolean
  color?: string
  /** points */
  size?: number
  link?: string
}
export type Run = ({ kind: 'text'; text: string } & Style) | { kind: 'math'; tex: string } | { kind: 'footnote'; blocks: Block[] } | { kind: 'break' }
export type Align = 'left' | 'center' | 'right' | 'both'
export type ParaStyle = 'Title' | 'Subtitle' | 'Author' | 'Date' | 'Caption' | 'Quote' | 'Code' | 'Abstract' | 'AbstractTitle' | 'Bibliography'
export type Cell = { runs: Run[]; span: number; align: Align }
export type Block =
  | { kind: 'para'; runs: Run[]; style?: ParaStyle; align?: Align; list?: { num: number; level: number }; indent?: number; keepNext?: boolean }
  | { kind: 'heading'; level: number; runs: Run[] }
  | { kind: 'equation'; tex: string; numbers: (string | null)[] }
  | { kind: 'table'; rows: { cells: Cell[]; header: boolean }[]; cols: number; rules: 'grid' | 'booktabs' | 'none' }
  | { kind: 'image'; path: string; width: number | null; height: number | null; scale: number | null }
  | { kind: 'pagebreak' }
  | { kind: 'toc' }

export type ListDef = { type: 'bullet' | 'number'; style: 'decimal' | 'lowerLetter' | 'lowerRoman' | 'upperLetter' | 'upperRoman' }
export type BibItem = { key: string; label: string; text: string }

/** What the converter needs besides the LaTeX itself. */
export type Sources = {
  /** \newlabel / \bibcite from the last compile's .aux, if there is one */
  aux?: string
  /** the last compile's .bbl (formatted bibliography), if there is one */
  bbl?: string
  /** .bib entries, for documents without a usable .bbl (e.g. biblatex) */
  bib?: Map<string, Record<string, string>>
}

export type DocModel = {
  blocks: Block[]
  lists: ListDef[]
  title: string
  author: string
  paper: 'a4' | 'letter'
  macros: Record<string, string>
  warnings: string[]
  counts: { equations: number; figures: number; tables: number; footnotes: number; citations: number }
}

const LEVEL: Record<string, number> = { part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5, subparagraph: 6 }
const SIZES: Record<string, number> = { tiny: 6, scriptsize: 8, footnotesize: 9, small: 10, normalsize: 11, large: 12, Large: 14, LARGE: 17, huge: 20, Huge: 25 }
const COLORS: Record<string, string> = {
  red: 'FF0000', green: '00A000', blue: '0000FF', cyan: '00FFFF', magenta: 'FF00FF', yellow: 'FFD700', black: '000000', white: 'FFFFFF',
  gray: '808080', darkgray: '404040', lightgray: 'BFBFBF', brown: '996633', lime: 'BFFF00', olive: '808000', orange: 'FF8000', pink: 'FFBFBF',
  purple: 'BF0040', teal: '008080', violet: '800080',
}
const SYMBOLS: Record<string, string> = {
  ldots: '…', dots: '…', textellipsis: '…', textendash: '–', textemdash: '—', textbullet: '•', textdegree: '°', copyright: '©', textcopyright: '©',
  texttrademark: '™', textregistered: '®', S: '§', P: '¶', dag: '†', ddag: '‡', pounds: '£', textsterling: '£', euro: '€', texteuro: '€',
  textasciitilde: '~', textbackslash: '\\', textless: '<', textgreater: '>', textbar: '|', textquoteleft: '‘', textquoteright: '’',
  textquotedblleft: '“', textquotedblright: '”', ss: 'ß', o: 'ø', O: 'Ø', ae: 'æ', AE: 'Æ', oe: 'œ', OE: 'Œ', aa: 'å', AA: 'Å', l: 'ł', L: 'Ł',
  i: 'ı', j: 'ȷ', LaTeX: 'LaTeX', TeX: 'TeX', LaTeXe: 'LaTeX2ε', BibTeX: 'BibTeX', quad: ' ', qquad: '  ', enspace: ' ',
  thinspace: ' ', textunderscore: '_', checkmark: '✓', textperthousand: '‰', textmu: 'µ', textpm: '±', texttimes: '×',
}
const ACCENT: Record<string, string> = { "'": '́', '`': '̀', '^': '̂', '"': '̈', '~': '̃', '=': '̄', '.': '̇', u: '̆', v: '̌', H: '̋', c: '̧', k: '̨', r: '̊', d: '̣', b: '̱' }
/** Commands whose argument is printed with a style. */
const TEXT_STYLE: Record<string, Style> = {
  textbf: { b: true }, textit: { i: true }, emph: { i: true }, textsl: { i: true }, underline: { u: true }, uline: { u: true }, texttt: { mono: true },
  textsc: { sc: true }, textsuperscript: { sup: true }, textsubscript: { sub: true }, sout: { strike: true }, st: { strike: true },
  textrm: {}, textsf: {}, textnormal: {}, textup: {}, textmd: {}, mbox: {}, text: {}, hbox: {}, makebox: {}, fbox: {}, framebox: {},
}
const DECLARATION: Record<string, Style> = { bfseries: { b: true }, bf: { b: true }, itshape: { i: true }, it: { i: true }, em: { i: true }, slshape: { i: true }, ttfamily: { mono: true }, tt: { mono: true }, scshape: { sc: true }, sc: { sc: true }, normalfont: { b: false, i: false, mono: false, sc: false }, rmfamily: {}, sffamily: {}, upshape: { i: false }, mdseries: { b: false } }
/** Commands dropped together with their (brace) arguments. */
const IGNORE_ARGS: Record<string, number> = {
  vspace: 1, hspace: 1, 'vspace*': 1, 'hspace*': 1, addtocounter: 2, setcounter: 2, setlength: 2, addtolength: 2, bibliographystyle: 1, graphicspath: 1,
  thispagestyle: 1, pagestyle: 1, pagenumbering: 1, index: 1, nocite: 1, phantom: 1, hphantom: 1, vphantom: 1, hypersetup: 1, addbibresource: 1,
  include: 1, input: 1, usepackage: 1, documentclass: 1, newtheorem: 2, theoremstyle: 1, renewcommand: 2, providecommand: 2, numberwithin: 2,
  captionsetup: 1, setstretch: 1, linespread: 1, enlargethispage: 1, definecolor: 3, tikzset: 1, pgfplotsset: 1, lstset: 1, sisetup: 1,
  markboth: 2, markright: 1, addcontentsline: 3, label: 1, hyphenation: 1, includeonly: 1, DeclareMathOperator: 2, newgeometry: 1, geometry: 1,
}
const MATH_ENVS = new Set(['equation', 'align', 'gather', 'multline', 'eqnarray', 'flalign', 'alignat', 'displaymath', 'math'])
const VERBATIM = new Set(['verbatim', 'Verbatim', 'lstlisting', 'minted', 'comment'])
const DEFAULT_THEOREMS: Record<string, string> = { theorem: 'Theorem', lemma: 'Lemma', corollary: 'Corollary', proposition: 'Proposition', definition: 'Definition', example: 'Example', remark: 'Remark', conjecture: 'Conjecture', claim: 'Claim', note: 'Note', exercise: 'Exercise' }

type Label = { text: string; kind: 'section' | 'figure' | 'table' | 'equation' | 'theorem' | 'item' | 'other'; name?: string }

/** Everything shared while converting one document. */
class Context {
  labels = new Map<string, Label>()
  /** from the first pass, so forward references work */
  known = new Map<string, Label>()
  counters: Record<string, number> = { part: 0, chapter: 0, section: 0, subsection: 0, subsubsection: 0, paragraph: 0, figure: 0, table: 0, equation: 0, footnote: 0, theorem: 0 }
  last: Label = { text: '', kind: 'other' }
  lists: ListDef[] = [{ type: 'bullet', style: 'decimal' }]
  theorems: Record<string, { title: string; counter: string }> = {}
  macros: Record<string, string> = {}
  textMacros = new Map<string, { args: number; optional?: string; body: string }>()
  colors: Record<string, string> = { ...COLORS }
  hasChapters = false
  appendix = false
  title: Run[] = []
  author: Run[][] = []
  date: Run[] | null = null
  citeOrder: string[] = []
  bib = new Map<string, { label: string; year?: string; authors?: string; text?: string }>()
  authorYear = false
  warnings = new Set<string>()
  counts = { equations: 0, figures: 0, tables: 0, footnotes: 0, citations: 0 }
}

const isLetter = (c: string) => /[A-Za-z@]/.test(c)

/** The index just after the group starting at `open` (a `{`), or -1. */
function groupEnd(s: string, open: number, o = '{', c = '}') {
  let depth = 0
  for (let i = open; i < s.length; i++) {
    const ch = s[i]
    if (ch === '\\') {
      i++
      continue
    }
    if (ch === o) depth++
    else if (ch === c && --depth === 0) return i + 1
  }
  return -1
}

/**
 * Split at a separator (a sticky regex: cells at &, rows at \\, items at \item) that isn't inside braces or a
 * nested environment.
 */
function splitTop(s: string, sep: RegExp): string[] {
  const out: string[] = []
  let depth = 0
  let envs = 0
  let start = 0
  for (let i = 0; i < s.length; i++) {
    if (depth === 0 && envs === 0) {
      sep.lastIndex = i
      const m = sep.exec(s)
      if (m && m[0].length) {
        out.push(s.slice(start, i))
        i += m[0].length - 1
        start = i + 1
        continue
      }
    }
    const ch = s[i]
    if (ch === '\\') {
      if (s.startsWith('\\begin', i) && !isLetter(s[i + 6] ?? '')) envs++
      else if (s.startsWith('\\end', i) && !isLetter(s[i + 4] ?? '')) envs = Math.max(0, envs - 1)
      i++
      continue
    }
    if (ch === '%') {
      const nl = s.indexOf('\n', i)
      i = nl < 0 ? s.length : nl
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') depth--
  }
  out.push(s.slice(start))
  return out
}

const roman = (n: number) => {
  const map: [number, string][] = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']]
  let out = ''
  for (const [v, s] of map) while (n >= v) (out += s), (n -= v)
  return out
}

class Parser {
  out: Block[] = []
  runs: Run[] = []
  style: Style = {}
  align: Align | undefined
  paraStyle: ParaStyle | undefined
  indent = 0
  list: { num: number; level: number } | null = null

  constructor(readonly ctx: Context) {}

  // ---------- output ----------

  text(t: string) {
    if (!t) return
    const last = this.runs[this.runs.length - 1]
    // spaces collapse, as in TeX
    if (t === ' ' && (!last || (last.kind === 'text' && / $/.test(last.text)) || last.kind === 'break')) return
    if (last?.kind === 'text' && sameStyle(last, this.style)) last.text += t
    else this.runs.push({ kind: 'text', text: t, ...this.style })
  }

  flush() {
    // trim spaces at the paragraph's edges
    while (this.runs.length && this.runs[0].kind === 'text' && !(this.runs[0] as { text: string }).text.trim()) this.runs.shift()
    const first = this.runs[0]
    if (first?.kind === 'text') first.text = first.text.replace(/^\s+/, '')
    while (this.runs.length && this.runs[this.runs.length - 1].kind === 'text' && !(this.runs[this.runs.length - 1] as { text: string }).text.trim()) this.runs.pop()
    const last = this.runs[this.runs.length - 1]
    if (last?.kind === 'text') last.text = last.text.replace(/\s+$/, '')
    if (this.runs.length) {
      this.out.push({ kind: 'para', runs: this.runs, style: this.paraStyle, align: this.align, list: this.list ?? undefined, indent: this.indent || undefined })
      // only an item's first paragraph has the bullet; the rest are indented under it
      if (this.list) {
        this.indent = this.list.level + 1
        this.list = null
      }
    }
    this.runs = []
  }

  block(b: Block) {
    this.flush()
    this.out.push(b)
  }

  /** Parse into a fresh paragraph list (captions, footnotes, cells) and return the runs or blocks. */
  child(src: string, inline: true): Run[]
  child(src: string, inline: false): Block[]
  child(src: string, inline: boolean) {
    const p = new Parser(this.ctx)
    p.style = { ...this.style }
    p.parse(src)
    if (inline) {
      // a caption or cell is one paragraph: join any paragraphs with a space
      p.flush()
      const runs: Run[] = []
      for (const b of p.out) if (b.kind === 'para') runs.push(...(runs.length ? [{ kind: 'text', text: ' ' } as Run] : []), ...b.runs)
      return runs
    }
    p.flush()
    return p.out
  }

  // ---------- reading ----------

  /** The argument at `i` ({…} or a single character/command), and where it ends. */
  arg(s: string, i: number): [string, number] {
    while (i < s.length && /\s/.test(s[i])) i++
    if (s[i] === '{') {
      const end = groupEnd(s, i)
      if (end < 0) return [s.slice(i + 1), s.length]
      return [s.slice(i + 1, end - 1), end]
    }
    if (s[i] === '\\') {
      let j = i + 1
      if (isLetter(s[j] ?? '')) while (j < s.length && isLetter(s[j])) j++
      else j++
      return [s.slice(i, j), j]
    }
    return [s[i] ?? '', i + 1]
  }

  optional(s: string, i: number): [string | null, number] {
    let j = i
    while (j < s.length && /[ \t]/.test(s[j])) j++
    if (s[j] !== '[') return [null, i]
    const end = groupEnd(s, j, '[', ']')
    if (end < 0) return [null, i]
    return [s.slice(j + 1, end - 1), end]
  }

  /** \begin{name}…\end{name} starting at i (just after "\begin"): [name, body, end index]. */
  environment(s: string, i: number): [string, string, number, string] {
    const [name, afterName] = this.arg(s, i)
    let depth = 1
    const re = /\\(begin|end)\s*\{([^}]*)\}/g
    re.lastIndex = afterName
    for (let m; (m = re.exec(s)); ) {
      if (m[2] !== name) continue
      if (m[1] === 'begin') depth++
      else if (--depth === 0) return [name, s.slice(afterName, m.index), m.index + m[0].length, s.slice(afterName)]
    }
    this.ctx.warnings.add(`\\begin{${name}} without a matching \\end`)
    return [name, s.slice(afterName), s.length, '']
  }

  // ---------- the main loop ----------

  parse(s: string) {
    for (let i = 0; i < s.length; ) {
      const ch = s[i]
      if (ch === '%') {
        // a comment: to the end of the line, and the line break with it
        const nl = s.indexOf('\n', i)
        i = nl < 0 ? s.length : nl + 1
        while (i < s.length && /[ \t]/.test(s[i])) i++
        continue
      }
      if (ch === '\n') {
        // a blank line ends the paragraph
        let j = i + 1
        while (j < s.length && /[ \t\r]/.test(s[j])) j++
        if (s[j] === '\n') {
          this.flush()
          while (j < s.length && /\s/.test(s[j])) j++
          i = j
        } else {
          this.text(' ')
          i = j
        }
        continue
      }
      if (ch === '\\') {
        i = this.command(s, i)
        continue
      }
      if (ch === '$') {
        const display = s[i + 1] === '$'
        const close = display ? s.indexOf('$$', i + 2) : findDollar(s, i + 1)
        if (close < 0) {
          this.text('$')
          i++
          continue
        }
        const tex = s.slice(i + (display ? 2 : 1), close)
        if (display) this.equation(tex, false)
        else this.math(tex)
        i = close + (display ? 2 : 1)
        continue
      }
      if (ch === '{') {
        const end = groupEnd(s, i)
        const saved = { ...this.style }
        this.parse(s.slice(i + 1, end < 0 ? s.length : end - 1))
        this.style = saved
        i = end < 0 ? s.length : end
        continue
      }
      if (ch === '}') {
        i++
        continue
      }
      if (ch === '~') {
        this.text(' ')
        i++
        continue
      }
      if (ch === '-' && s[i + 1] === '-') {
        const em = s[i + 2] === '-'
        this.text(em ? '—' : '–')
        i += em ? 3 : 2
        continue
      }
      if (ch === '`' || ch === "'") {
        const double = s[i + 1] === ch
        this.text(ch === '`' ? (double ? '“' : '‘') : double ? '”' : '’')
        i += double ? 2 : 1
        continue
      }
      if (ch === '&' || ch === '#') {
        i++
        continue
      }
      if (/[ \t\r]/.test(ch)) {
        let j = i
        while (j < s.length && /[ \t\r]/.test(s[j])) j++
        this.text(' ')
        i = j
        continue
      }
      // plain text up to the next special character
      let j = i + 1
      while (j < s.length && !/[\\$%{}~\n&#`'\- \t\r]/.test(s[j])) j++
      this.text(s.slice(i, j))
      i = j
    }
  }

  math(tex: string) {
    this.ctx.counts.equations++
    this.runs.push({ kind: 'math', tex: tex.trim() })
  }

  /** A display equation; numbered environments get the next equation number (one per line in align). */
  equation(tex: string, numbered: boolean, env = '') {
    this.ctx.counts.equations++
    const rows = env && /align|gather|eqnarray|flalign|alignat/.test(env) ? splitTop(tex, /\\\\/y).filter(r => r.trim()) : [tex]
    // a number for each line (none for \nonumber lines and starred environments); \tag sets its own
    const numbers = rows.map(r => {
      const tag = r.match(/\\tag\*?\s*\{([^}]*)\}/)
      const n = tag ? tag[1] : numbered && !/\\(nonumber|notag)\b/.test(r) ? this.next('equation') : null
      for (const m of r.matchAll(/\\label\s*\{([^}]*)\}/g)) this.label(m[1], { text: n ?? '', kind: 'equation' })
      return n
    })
    // labels, \nonumber and \tag are for LaTeX, not the picture
    let body = tex.replace(/\\label\s*\{[^}]*\}/g, '').replace(/\\(nonumber|notag)\b/g, '').replace(/\\tag\*?\s*\{[^}]*\}/g, '')
    if (/^(align|flalign|eqnarray)/.test(env)) body = `\\begin{aligned}${body.replace(/&\s*=\s*&/g, '&=')}\\end{aligned}`
    else if (/^alignat/.test(env)) body = `\\begin{aligned}${body.replace(/^\s*\{\d+\}/, '')}\\end{aligned}`
    else if (/^gather/.test(env)) body = `\\begin{gathered}${body}\\end{gathered}`
    else if (/^multline/.test(env)) body = body.replace(/\\\\/g, ' ')
    this.block({ kind: 'equation', tex: body.trim(), numbers })
  }

  next(counter: string) {
    const c = this.ctx.counters
    c[counter] = (c[counter] ?? 0) + 1
    // figures, tables and equations count within chapters in books and reports
    const chapter = this.ctx.hasChapters && ['figure', 'table', 'equation'].includes(counter) && c.chapter > 0 ? `${this.chapterNumber()}.` : ''
    return chapter + String(c[counter])
  }

  chapterNumber() {
    return this.ctx.appendix ? String.fromCharCode(64 + this.ctx.counters.chapter) : String(this.ctx.counters.chapter)
  }

  label(key: string, l: Label) {
    this.ctx.labels.set(key, l)
  }

  // ---------- commands ----------

  command(s: string, i: number): number {
    let j = i + 1
    let name: string
    if (isLetter(s[j] ?? '')) {
      while (j < s.length && isLetter(s[j])) j++
      name = s.slice(i + 1, j)
      if (s[j] === '*') {
        name += '*'
        j++
      }
    } else {
      name = s[j] ?? ''
      j++
    }
    const ctx = this.ctx
    // control symbols
    switch (name) {
      case '\\': {
        const [, k] = this.optional(s, j)
        this.runs.push({ kind: 'break' })
        return k
      }
      case '\\*':
        return j
      case '%': case '&': case '$': case '#': case '_': case '{': case '}':
        this.text(name)
        return j
      case ',': case ';': case ':': case '>':
        this.text(' ')
        return j
      case ' ': case '\n':
        this.text(' ')
        return j
      case '-': case '/': case '@': case '!':
        return j
      case '(': {
        const close = s.indexOf('\\)', j)
        this.math(s.slice(j, close < 0 ? s.length : close))
        return close < 0 ? s.length : close + 2
      }
      case '[': {
        const close = s.indexOf('\\]', j)
        this.equation(s.slice(j, close < 0 ? s.length : close), false)
        return close < 0 ? s.length : close + 2
      }
    }
    if (name.length === 1 && ACCENT[name]) {
      const [base, k] = this.arg(s, j)
      const letter = base.replace(/^\\([ij])$/, (_, c) => c)
      this.text((letter + ACCENT[name]).normalize('NFC'))
      return k
    }
    if (name in SYMBOLS && !(name === 'S' && s[j] === '{')) {
      this.text(SYMBOLS[name])
      // a command word eats the space after it
      return s[j] === '{' && s[j + 1] === '}' ? j + 2 : j
    }
    const base = name.replace(/\*$/, '')
    if (base in LEVEL) return this.heading(s, j, base, name.endsWith('*'))
    if (name in TEXT_STYLE) {
      let k = j
      // \makebox[w][pos]{…}
      while (true) {
        const [opt, after] = this.optional(s, k)
        if (opt == null) break
        k = after
      }
      const [content, end] = this.arg(s, k)
      this.styled(TEXT_STYLE[name], content)
      return end
    }
    if (name in DECLARATION) {
      Object.assign(this.style, DECLARATION[name])
      return j
    }
    if (name in SIZES) {
      this.style.size = SIZES[name] === 11 ? undefined : SIZES[name]
      return j
    }
    if (name in IGNORE_ARGS) {
      let k = j
      for (let n = 0; n < IGNORE_ARGS[name]; n++) {
        k = this.optional(s, k)[1]
        if (name === 'label') {
          const [key, end] = this.arg(s, k)
          this.label(key.trim(), { ...ctx.last })
          return end
        }
        k = this.arg(s, k)[1]
      }
      return this.optional(s, k)[1]
    }
    switch (name) {
      case 'begin':
        return this.begin(s, j)
      case 'end':
        return this.arg(s, j)[1]
      case 'item':
        return j // handled by the list environments
      case 'par': case 'medskip': case 'bigskip': case 'smallskip':
        this.flush()
        return j
      case 'newline': case 'linebreak':
        this.runs.push({ kind: 'break' })
        return this.optional(s, j)[1]
      case 'newpage': case 'clearpage': case 'cleardoublepage': case 'pagebreak':
        this.block({ kind: 'pagebreak' })
        return this.optional(s, j)[1]
      case 'noindent': case 'indent': case 'protect': case 'relax': case 'nobreak': case 'centering': case 'raggedright': case 'raggedleft': case 'hfill': case 'vfill': case 'null': case 'frontmatter': case 'mainmatter': case 'backmatter': case 'onehalfspacing': case 'doublespacing': case 'singlespacing': case 'FloatBarrier': case 'balance': case 'sloppy': case 'fussy': case 'selectlanguage':
        if (name === 'centering') this.align = 'center'
        if (name === 'raggedleft') this.align = 'right'
        if (name === 'selectlanguage') return this.arg(s, j)[1]
        return j
      case 'appendix':
        ctx.appendix = true
        if (ctx.hasChapters) ctx.counters.chapter = 0
        else ctx.counters.section = 0
        return j
      case 'maketitle':
        this.titleBlock()
        return j
      case 'tableofcontents':
        this.block({ kind: 'toc' })
        return j
      case 'listoffigures': case 'listoftables': case 'printindex': case 'printglossary':
        return j
      case 'today':
        this.text(new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }))
        return j
      case 'footnote': {
        const [, k] = this.optional(s, j)
        const [content, end] = this.arg(s, k)
        ctx.counts.footnotes++
        this.runs.push({ kind: 'footnote', blocks: this.child(content, false) })
        return end
      }
      case 'thanks': {
        const [content, end] = this.arg(s, j)
        this.runs.push({ kind: 'footnote', blocks: this.child(content, false) })
        return end
      }
      case 'href': {
        const [url, k] = this.arg(s, j)
        const [content, end] = this.arg(s, k)
        this.styled({ link: url.replace(/\\([#%&_~])/g, '$1') }, content)
        return end
      }
      case 'url': case 'nolinkurl': {
        const [url, end] = this.arg(s, j)
        const clean = url.replace(/\\([#%&_~])/g, '$1')
        const saved = { ...this.style }
        Object.assign(this.style, { link: name === 'url' ? clean : undefined, mono: true })
        this.text(clean)
        this.style = saved
        return end
      }
      case 'verb': {
        const delim = s[j]
        const close = s.indexOf(delim, j + 1)
        this.styled({ mono: true }, null, s.slice(j + 1, close < 0 ? s.length : close))
        return close < 0 ? s.length : close + 1
      }
      case 'textcolor': {
        const [, k0] = this.optional(s, j)
        const [color, k] = this.arg(s, k0)
        const [content, end] = this.arg(s, k)
        this.styled({ color: this.color(color) }, content)
        return end
      }
      case 'color': {
        // {\color{red} text}: the rest of the group
        const [c, end] = this.arg(s, this.optional(s, j)[1])
        this.style.color = this.color(c)
        return end
      }
      case 'colorbox': case 'fcolorbox': case 'highlight': case 'hl': {
        let k = this.arg(s, j)[1]
        if (name === 'fcolorbox') k = this.arg(s, k)[1]
        const [content, end] = name === 'hl' || name === 'highlight' ? this.arg(s, j) : this.arg(s, k)
        this.parse(content)
        return end
      }
      case 'caption': case 'caption*': {
        const [, k] = this.optional(s, j)
        const [, end] = this.arg(s, k)
        // captions are placed by the figure/table environments
        return end
      }
      case 'ref': case 'eqref': case 'autoref': case 'cref': case 'Cref': case 'pageref': case 'vref': case 'nameref': {
        const [key, end] = this.arg(s, j)
        this.text(this.reference(name, key.trim()))
        return end
      }
      case 'cite': case 'citep': case 'citet': case 'citealt': case 'citealp': case 'citeauthor': case 'citeyear': case 'parencite': case 'textcite': case 'autocite': case 'footcite': case 'cite*': case 'citep*': case 'citet*': case 'Citet': case 'Citep': case 'Textcite': case 'Parencite': case 'Autocite': {
        let [pre, k] = this.optional(s, j)
        let post: string | null = null
        const [second, k2] = this.optional(s, k)
        if (second != null) (post = second), (k = k2)
        else (post = pre), (pre = null)
        const [keys, end] = this.arg(s, k)
        this.text(this.citation(name.replace(/\*$/, ''), keys.split(',').map(x => x.trim()).filter(Boolean), pre, post))
        return end
      }
      case 'bibliography': {
        const [, end] = this.arg(s, j)
        this.bibliography()
        return end
      }
      case 'printbibliography':
        this.bibliography()
        return this.optional(s, j)[1]
      case 'newcommand': case 'renewcommand*': case 'newcommand*': case 'def': case 'providecommand': case 'renewcommand':
        return this.define(s, j, name)
      case 'includegraphics': case 'includegraphics*': {
        const [opts, k] = this.optional(s, j)
        const [file, end] = this.arg(s, k)
        this.image(file.trim(), opts ?? '')
        return end
      }
      case 'title': case 'author': case 'date': {
        const [, k] = this.optional(s, j)
        const [content, end] = this.arg(s, k)
        if (name === 'title') ctx.title = this.child(content, true)
        if (name === 'author') ctx.author = splitTop(content, /\\and\b/y).map(a => this.child(a.replace(/\\thanks\s*\{[^}]*\}/g, ''), true))
        if (name === 'date') ctx.date = this.child(content, true)
        return end
      }
      case 'input': case 'include': case 'subfile':
        return this.arg(s, j)[1]
    }
    // the user's own text macros
    const macro = ctx.textMacros.get(name)
    if (macro) {
      let k = j
      const args: string[] = []
      for (let n = 0; n < macro.args; n++) {
        if (n === 0 && macro.optional != null) {
          const [opt, after] = this.optional(s, k)
          args.push(opt ?? macro.optional)
          k = after
          continue
        }
        const [a, after] = this.arg(s, k)
        args.push(a)
        k = after
      }
      this.parse(macro.body.replace(/#(\d)/g, (_, d) => args[+d - 1] ?? ''))
      return k
    }
    // unknown: keep the text of its arguments (most commands that take text print it)
    let k = this.optional(s, j)[1]
    let any = false
    while (s[k] === '{') {
      const [content, end] = this.arg(s, k)
      // settings like {margin=1in} aren't text
      if (!/^\s*[\w-]+\s*=/.test(content)) this.parse(content)
      k = end
      any = true
    }
    if (!any) ctx.warnings.add(`\\${name} was left out`)
    return k
  }

  styled(patch: Style, content: string | null, literal?: string) {
    const saved = { ...this.style }
    Object.assign(this.style, patch)
    if (literal != null) this.text(literal)
    else if (content != null) this.parse(content)
    this.style = saved
  }

  color(spec: string) {
    const [name, pct] = spec.split('!')
    const hex = this.ctx.colors[name.trim()] ?? '000000'
    if (!pct) return hex
    // red!50 = half red, half white
    const p = Math.max(0, Math.min(100, parseFloat(pct))) / 100
    return [0, 2, 4].map(o => Math.round(parseInt(hex.slice(o, o + 2), 16) * p + 255 * (1 - p)).toString(16).padStart(2, '0')).join('').toUpperCase()
  }

  define(s: string, j: number, name: string) {
    let k = j
    let macroName: string
    if (name === 'def') {
      const m = s.slice(k).match(/^\s*\\([A-Za-z@]+)[^{]*/)
      if (!m) return k
      macroName = m[1]
      k += m[0].length
    } else {
      const [n, after] = this.arg(s, k)
      macroName = n.replace(/^\\/, '').trim()
      k = after
    }
    const [count, k2] = this.optional(s, k)
    const [optDefault, k3] = this.optional(s, k2)
    const [body, end] = this.arg(s, k3)
    const args = count ? parseInt(count, 10) || 0 : 0
    this.ctx.macros[`\\${macroName}`] = body
    this.ctx.textMacros.set(macroName, { args, optional: optDefault ?? undefined, body })
    return end
  }

  reference(kind: string, key: string) {
    const l = this.ctx.labels.get(key) ?? this.ctx.known.get(key)
    if (!l || !l.text) return kind === 'pageref' ? '?' : '??'
    if (kind === 'eqref') return `(${l.text})`
    if (kind === 'autoref' || kind === 'cref' || kind === 'Cref' || kind === 'vref') {
      const word = l.kind === 'equation' ? 'Equation' : l.kind === 'figure' ? 'Figure' : l.kind === 'table' ? 'Table' : l.kind === 'section' ? 'Section' : l.kind === 'theorem' ? l.name ?? 'Theorem' : ''
      const n = l.kind === 'equation' ? `(${l.text})` : l.text
      return word ? `${kind === 'Cref' || kind === 'autoref' ? word : word.toLowerCase()} ${n}` : n
    }
    return l.text
  }

  citation(kind: string, keys: string[], pre: string | null, post: string | null) {
    const ctx = this.ctx
    ctx.counts.citations++
    for (const k of keys) if (!ctx.citeOrder.includes(k)) ctx.citeOrder.push(k)
    const entries = keys.map(k => ({ key: k, e: ctx.bib.get(k) }))
    for (const { key, e } of entries) if (!e) ctx.warnings.add(`Citation ${key} isn’t in the bibliography (compile first so LaTeXDesk can read it)`)
    const label = (k: string) => ctx.bib.get(k)?.label ?? String(ctx.citeOrder.indexOf(k) + 1)
    const extra = (s: string) => (pre ? `${pre} ` : '') + s + (post ? `, ${post}` : '')
    if (ctx.authorYear) {
      const ay = entries.map(({ key, e }) => ({ who: e?.authors ?? key, year: e?.year ?? '' }))
      if (kind === 'citeauthor') return ay.map(a => a.who).join('; ')
      if (kind === 'citeyear') return ay.map(a => a.year).join('; ')
      if (/^(citet|Citet|textcite|Textcite)$/.test(kind)) return ay.map(a => `${a.who} (${a.year}${post ? `, ${post}` : ''})`).join('; ')
      const inner = extra(ay.map(a => `${a.who}${kind === 'citealt' || kind === 'citealp' ? ' ' : ', '}${a.year}`).join('; '))
      return /^(citealt|citealp)$/.test(kind) ? inner : `(${inner})`
    }
    const nums = keys.map(label).join(', ')
    if (kind === 'citeauthor') return entries.map(({ key, e }) => e?.authors ?? key).join('; ')
    if (/^(citet|Citet|textcite|Textcite)$/.test(kind)) return entries.map(({ key, e }) => `${e?.authors ?? key} [${label(key)}]`).join('; ')
    return `[${extra(nums)}]`
  }

  bibliography() {
    const ctx = this.ctx
    this.block({ kind: 'heading', level: 1, runs: [{ kind: 'text', text: ctx.hasChapters ? 'Bibliography' : 'References' }] })
    const items = [...ctx.bib.entries()].filter(([, e]) => e.text != null)
    const ordered = items.length ? items : []
    if (!ordered.length) ctx.warnings.add('The bibliography is empty: compile the document once so its references can be included')
    for (const [, e] of ordered) {
      const p = new Parser(ctx)
      p.paraStyle = 'Bibliography'
      p.text(ctx.authorYear ? '' : `[${e.label}] `)
      p.parse(e.text ?? '')
      p.flush()
      this.out.push(...p.out)
    }
  }

  heading(s: string, j: number, kind: string, starred: boolean) {
    const ctx = this.ctx
    const [, k] = this.optional(s, j)
    const [content, end] = this.arg(s, k)
    const level = LEVEL[kind]
    let number = ''
    if (!starred && level <= 4) {
      const c = ctx.counters
      c[kind]++
      // reset the levels below
      for (const [n, l] of Object.entries(LEVEL)) if (l > level) c[n] = 0
      if (kind === 'chapter') for (const n of ['figure', 'table', 'equation']) c[n] = 0
      const sec = ctx.appendix && kind === (ctx.hasChapters ? 'chapter' : 'section') ? String.fromCharCode(64 + c[kind]) : String(c[kind])
      if (kind === 'chapter') number = sec
      else if (kind === 'section') number = ctx.hasChapters ? `${this.chapterNumber()}.${c.section}` : sec
      else if (kind === 'subsection') number = `${ctx.hasChapters ? `${this.chapterNumber()}.` : ''}${ctx.appendix && !ctx.hasChapters ? String.fromCharCode(64 + c.section) : c.section}.${c.subsection}`
      else if (kind === 'subsubsection') number = `${ctx.hasChapters ? `${this.chapterNumber()}.` : ''}${c.section}.${c.subsection}.${c.subsubsection}`
      else if (kind === 'part') number = roman(c.part).toUpperCase()
      if (number) ctx.last = { text: number, kind: 'section' }
    }
    // Word heading levels: the document's top level is Heading 1
    const top = ctx.hasChapters ? 1 : 2
    const runs = this.child(content, true)
    if (kind === 'chapter' && number) runs.unshift({ kind: 'text', text: `${ctx.appendix ? 'Appendix' : 'Chapter'} ${number} ` })
    else if (number) runs.unshift({ kind: 'text', text: `${number} ` })
    if (level >= 5) {
      // \paragraph: a bold run-in heading
      this.flush()
      this.runs.push(...runs.map(r => (r.kind === 'text' ? { ...r, b: true } : r)), { kind: 'text', text: ' ' })
      return end
    }
    this.block({ kind: 'heading', level: Math.max(1, level - top + 1), runs })
    return end
  }

  titleBlock() {
    const ctx = this.ctx
    if (ctx.title.length) this.block({ kind: 'para', runs: ctx.title, style: 'Title' })
    for (const a of ctx.author) if (a.length) this.block({ kind: 'para', runs: a, style: 'Author' })
    const date = ctx.date ?? [{ kind: 'text', text: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) } as Run]
    if (date.length) this.block({ kind: 'para', runs: date, style: 'Date' })
  }

  image(file: string, opts: string) {
    this.ctx.counts.figures++
    const num = (key: string) => {
      const m = opts.match(new RegExp(`(?:^|,)\\s*${key}\\s*=\\s*([^,]+)`))
      return m ? m[1].trim() : null
    }
    // sizes in points; \textwidth-relative widths become a share of the page's text width
    const toPt = (v: string | null) => {
      if (!v) return null
      const rel = v.match(/^([\d.]*)\s*\\(textwidth|linewidth|columnwidth|hsize)/)
      if (rel) return (parseFloat(rel[1] || '1') || 1) * 468
      const abs = v.match(/^([\d.]+)\s*(cm|mm|in|pt|bp|em)$/)
      if (!abs) return null
      const n = parseFloat(abs[1])
      return n * ({ cm: 28.35, mm: 2.835, in: 72, pt: 0.996, bp: 1, em: 11 } as Record<string, number>)[abs[2]]
    }
    const height = num('height')
    this.block({ kind: 'image', path: file, width: toPt(num('width')), height: height && !/textheight/.test(height) ? toPt(height) : null, scale: num('scale') ? parseFloat(num('scale')!) : null })
  }

  // ---------- environments ----------

  begin(s: string, j: number): number {
    const [name, body, end] = this.environment(s, j)
    const ctx = this.ctx
    const base = name.replace(/\*$/, '')
    if (MATH_ENVS.has(base)) {
      if (base === 'math') this.math(body)
      else this.equation(body, !name.endsWith('*') && base !== 'displaymath', base)
      return end
    }
    if (VERBATIM.has(base)) {
      if (base === 'comment') return end
      // lstlisting[options] / minted{language}
      let code = body.replace(/^\[[^\]]*\]/, '')
      if (base === 'minted') code = code.replace(/^\s*(\[[^\]]*\])?\s*\{[^}]*\}/, '')
      this.flush()
      for (const line of code.replace(/^\n/, '').replace(/\n\s*$/, '').split('\n')) this.out.push({ kind: 'para', runs: line ? [{ kind: 'text', text: line, mono: true }] : [], style: 'Code' })
      return end
    }
    switch (base) {
      case 'document':
        this.parse(body)
        this.flush()
        return end
      case 'itemize': case 'enumerate': case 'description': case 'compactitem': case 'compactenum': case 'inparaenum': case 'asparaenum':
        this.listEnv(base, body)
        return end
      case 'abstract': {
        this.block({ kind: 'para', runs: [{ kind: 'text', text: 'Abstract', b: true }], style: 'AbstractTitle', align: 'center' })
        const p = new Parser(ctx)
        p.paraStyle = 'Abstract'
        p.parse(body)
        p.flush()
        this.out.push(...p.out)
        return end
      }
      case 'quote': case 'quotation': case 'verse': {
        this.flush()
        const p = new Parser(ctx)
        p.paraStyle = 'Quote'
        p.parse(body)
        p.flush()
        this.out.push(...p.out)
        return end
      }
      case 'center': case 'flushleft': case 'flushright': {
        this.flush()
        const p = new Parser(ctx)
        p.align = base === 'center' ? 'center' : base === 'flushright' ? 'right' : 'left'
        p.parse(body)
        p.flush()
        this.out.push(...p.out)
        return end
      }
      // ([h] placement, and wrapfigure's {r}{0.5\textwidth}, aren't content)
      case 'figure': case 'wrapfigure': case 'SCfigure':
        this.float(body.replace(/^\s*(\[[^\]]*\])?\s*(\{[^}]*\}\s*\{[^}]*\})?/, ''), 'figure')
        return end
      case 'table': case 'wraptable':
        this.float(body.replace(/^\s*(\[[^\]]*\])?\s*(\{[^}]*\}\s*\{[^}]*\})?/, ''), 'table')
        return end
      case 'subfigure': case 'minipage': {
        // a sub-figure's own caption is shown under its picture
        const p = new Parser(ctx)
        p.parse(body.replace(/^\s*(\[[^\]]*\])*\s*\{[^}]*\}/, ''))
        p.flush()
        this.flush()
        this.out.push(...p.out)
        return end
      }
      case 'tabular': case 'tabularx': case 'tabulary': case 'longtable': case 'tabular*': case 'array':
        this.table(body, base)
        return end
      case 'proof': {
        this.flush()
        const p = new Parser(ctx)
        const [title, rest] = body.trimStart().startsWith('[') ? [body.slice(body.indexOf('[') + 1, groupEnd(body, body.indexOf('['), '[', ']') - 1), body.slice(groupEnd(body, body.indexOf('['), '[', ']'))] : ['Proof', body]
        p.styled({ i: true }, null, `${title}. `)
        p.parse(rest)
        p.text(' ∎')
        p.flush()
        this.out.push(...p.out)
        return end
      }
      case 'thebibliography':
        // written out by hand in the document
        this.thebibliography(body)
        return end
      case 'tikzpicture': case 'pgfpicture': case 'forest': case 'circuitikz':
        ctx.warnings.add('TikZ drawings aren’t converted: add them as pictures (export the figure from the PDF)')
        this.block({ kind: 'para', runs: [{ kind: 'text', text: '[TikZ figure: see the PDF]', i: true }], align: 'center' })
        return end
    }
    const theorem = ctx.theorems[base] ?? (DEFAULT_THEOREMS[base] ? { title: DEFAULT_THEOREMS[base], counter: 'theorem' } : null)
    if (theorem) {
      this.flush()
      const [note, k] = this.optional(body, 0)
      const number = name.endsWith('*') ? '' : this.next(theorem.counter)
      ctx.last = { text: number, kind: 'theorem', name: theorem.title }
      const p = new Parser(ctx)
      p.styled({ b: true }, null, `${theorem.title}${number ? ` ${number}` : ''}`)
      if (note) p.styled({}, `\\ (${note})`)
      p.styled({ b: true }, null, '. ')
      p.style = { i: !/definition|example|remark|note|exercise/i.test(base) }
      p.parse(body.slice(k))
      p.flush()
      this.out.push(...p.out)
      return end
    }
    // anything else: its contents
    this.parse(body.replace(/^\s*(\[[^\]]*\])?/, ''))
    return end
  }

  listEnv(kind: string, body: string) {
    this.flush()
    const ctx = this.ctx
    // inside an item: one level deeper than it
    const depth = Math.min(8, this.list ? this.list.level + 1 : this.indent)
    const numbered = /enum/.test(kind)
    let num = 0
    if (numbered) {
      const styles: ListDef['style'][] = ['decimal', 'lowerLetter', 'lowerRoman', 'upperLetter']
      ctx.lists.push({ type: 'number', style: styles[depth % 4] })
      num = ctx.lists.length - 1
    }
    // the [label] options of enumitem aren't followed; Word numbers the list itself
    const items = splitTop(body.replace(/^\s*\[[^\]]*\]/, ''), /\\item\b/y).slice(1)
    let n = 0
    for (const item of items) {
      n++
      const p = new Parser(ctx)
      let text = item
      const [label, k] = p.optional(text, 0)
      if (label != null) text = text.slice(k)
      if (numbered) ctx.last = { text: String(n), kind: 'item' }
      p.list = kind === 'description' ? null : { num, level: depth }
      p.indent = kind === 'description' ? depth + 1 : 0
      if (kind === 'description' && label != null) {
        p.styled({ b: true }, label)
        p.text(' ')
      } else if (label != null) {
        // a custom bullet: keep it as text, without Word's bullet
        p.list = null
        p.indent = depth + 1
        p.parse(label)
        p.text(' ')
      }
      p.parse(text)
      p.flush()
      this.out.push(...p.out)
    }
  }

  float(body: string, kind: 'figure' | 'table') {
    const ctx = this.ctx
    this.flush()
    const captions: { at: number; text: string }[] = []
    for (const m of body.matchAll(/\\caption\*?\s*(?:\[[^\]]*\])?\s*\{/g)) {
      const open = m.index! + m[0].length - 1
      const close = groupEnd(body, open)
      captions.push({ at: m.index!, text: body.slice(open + 1, close - 1) })
    }
    const number = this.next(kind)
    ctx.last = { text: number, kind }
    if (kind === 'table') ctx.counts.tables++
    const p = new Parser(ctx)
    p.align = 'center'
    // (\caption itself prints nothing; it's placed below)
    p.parse(body)
    p.flush()
    const caption = captions[0]
    const blocks = p.out
    if (caption) {
      const runs: Run[] = [{ kind: 'text', text: `${kind === 'figure' ? 'Figure' : 'Table'} ${number}: `, b: true }, ...this.child(caption.text, true)]
      const capBlock: Block = { kind: 'para', runs, style: 'Caption', align: 'center' }
      // tables usually have the caption above, figures below: follow the source
      const firstContent = body.search(/\\(begin\s*\{(tabular|tabularx|longtable|subfigure|minipage)|includegraphics)/)
      if (kind === 'table' && caption.at < firstContent) blocks.unshift({ ...capBlock, keepNext: true })
      else blocks.push(capBlock)
    }
    this.out.push(...blocks)
  }

  table(body: string, kind: string) {
    // the column spec: tabular{spec}, tabularx{width}{spec}, array{spec}
    let rest = body.replace(/^\s*\[[^\]]*\]/, '')
    if (kind === 'tabularx' || kind === 'tabular*' || kind === 'tabulary') rest = rest.slice(this.arg(rest, 0)[1])
    const [spec, k] = this.arg(rest, 0)
    rest = rest.slice(k)
    const aligns: Align[] = []
    for (const c of spec.replace(/[@!>< ]\s*\{[^}]*\}/g, '').replace(/\*\s*\{(\d+)\}\s*\{([^}]*)\}/g, (_, n, x) => x.repeat(+n))) {
      if (c === 'l') aligns.push('left')
      else if (c === 'c') aligns.push('center')
      else if (c === 'r') aligns.push('right')
      else if ('pmbXLCRS'.includes(c)) aligns.push(c === 'C' ? 'center' : c === 'R' ? 'right' : 'left')
    }
    const vertical = spec.includes('|')
    const rowsRaw = splitTop(rest, /\\\\(\s*\[[^\]]*\])?|\\tabularnewline/y)
    type Raw = { cells: Cell[]; ruleAbove: boolean; header: boolean }
    const rows: Raw[] = []
    let pendingRule = false
    let rules = 0
    let booktabs = false
    for (let segment of rowsRaw) {
      // rules before the row's cells
      for (;;) {
        const m = segment.match(/^\s*\\(hline|toprule|midrule|bottomrule|cline\s*\{[^}]*\}|cmidrule\s*(\([^)]*\))?\s*\{[^}]*\}|endhead|endfirsthead|endfoot|endlastfoot)/)
        if (!m) break
        if (/rule/.test(m[1])) booktabs = true
        if (!/^end/.test(m[1])) pendingRule = true
        rules++
        segment = segment.slice(m[0].length)
      }
      if (!segment.trim()) continue
      // the column each cell starts in (a \multicolumn covers several)
      let col = 0
      const cells = splitTop(segment, /&/y).map(c => {
        const multi = c.match(/^\s*\\multicolumn\s*\{(\d+)\}\s*\{([^}]*)\}\s*\{/)
        if (multi) {
          const open = c.indexOf('{', multi.index! + multi[0].length - 1)
          const content = c.slice(open + 1, groupEnd(c, open) - 1)
          const a = multi[2].replace(/[|]/g, '')
          col += +multi[1]
          return { runs: this.child(content, true), span: +multi[1], align: (a.startsWith('c') ? 'center' : a.startsWith('r') ? 'right' : 'left') as Align }
        }
        const content = c.replace(/^\s*\\multirow\s*\{[^}]*\}\s*\{[^}]*\}\s*\{([\s\S]*)\}\s*$/, '$1')
        return { runs: this.child(content, true), span: 1, align: aligns[col++] ?? 'left' }
      })
      rows.push({ cells, ruleAbove: pendingRule, header: false })
      pendingRule = false
    }
    if (!rows.length) return
    // a rule under the first row (with more rows after) makes it a header row
    if (rows.length > 1 && rows[1].ruleAbove) rows[0].header = true
    const cols = Math.max(aligns.length, ...rows.map(r => r.cells.reduce((n, c) => n + c.span, 0)))
    const style = vertical || (rules >= rows.length && !booktabs) ? 'grid' : rules ? 'booktabs' : 'none'
    this.block({ kind: 'table', rows: rows.map(r => ({ cells: r.cells, header: r.header })), cols, rules: style })
  }

  thebibliography(body: string) {
    const ctx = this.ctx
    this.block({ kind: 'heading', level: 1, runs: [{ kind: 'text', text: ctx.hasChapters ? 'Bibliography' : 'References' }] })
    let n = 0
    for (const item of splitTop(body.replace(/^\s*\{[^}]*\}/, ''), /\\bibitem\b/y).slice(1)) {
      n++
      const p = new Parser(ctx)
      const [label, k] = p.optional(item, 0)
      const [, k2] = p.arg(item, k)
      p.paraStyle = 'Bibliography'
      if (!ctx.authorYear) p.text(`[${label ?? n}] `)
      p.parse(item.slice(k2).replace(/\\newblock\b/g, ''))
      p.flush()
      this.out.push(...p.out)
    }
  }
}

function sameStyle(a: Style, b: Style) {
  const keys: (keyof Style)[] = ['b', 'i', 'u', 'mono', 'sc', 'sup', 'sub', 'strike', 'color', 'size', 'link']
  return keys.every(k => (a[k] ?? undefined) === (b[k] ?? undefined) || (!a[k] && !b[k]))
}

/** The closing $ of inline maths starting at i (skipping \$). */
function findDollar(s: string, i: number) {
  for (let j = i; j < s.length; j++) {
    if (s[j] === '\\') j++
    else if (s[j] === '$') return j
  }
  return -1
}

// ---------- the document as a whole ----------

/** Read \newtheorem, colours, title data and macros from the preamble. */
function readPreamble(ctx: Context, preamble: string) {
  const p = new Parser(ctx)
  for (const m of preamble.matchAll(/\\newtheorem\*?\s*\{([^}]*)\}\s*(?:\[([^\]]*)\])?\s*\{([^}]*)\}\s*(?:\[([^\]]*)\])?/g)) {
    ctx.theorems[m[1]] = { title: m[3], counter: m[2] ?? (m[0].includes('*') ? '' : m[1]) }
  }
  for (const m of preamble.matchAll(/\\definecolor\s*\{([^}]*)\}\s*\{(HTML|rgb|RGB)\}\s*\{([^}]*)\}/g)) {
    const v = m[3].trim()
    ctx.colors[m[1]] =
      m[2] === 'HTML' ? v.toUpperCase() : v.split(',').map(x => Math.round(parseFloat(x) * (m[2] === 'rgb' ? 255 : 1)).toString(16).padStart(2, '0')).join('').toUpperCase()
  }
  for (const m of preamble.matchAll(/\\DeclareMathOperator\*?\s*\{\\([A-Za-z]+)\}\s*\{([^}]*)\}/g)) ctx.macros[`\\${m[1]}`] = `\\operatorname{${m[2]}}`
  // \newcommand, \title, \author, \date
  for (const m of preamble.matchAll(/\\(newcommand\*?|renewcommand\*?|providecommand|def|title|author|date)(?![A-Za-z])/g)) {
    p.command(preamble, m.index!)
  }
}

/** Numbers and labels for citations: the .bbl (formatted) and .aux (labels) of the last compile, else the .bib. */
function readBibliography(ctx: Context, sources: Sources) {
  const aux = sources.aux ?? ''
  // natbib: \bibcite{key}{{1}{1984}{{Knuth}}{{Knuth}}}; plain: \bibcite{key}{1}
  for (const m of aux.matchAll(/\\bibcite\{([^}]*)\}\{(.*)\}\s*$/gm)) {
    const nat = m[2].match(/^\{([^}]*)\}\{([^}]*)\}\{\{(.*?)\}\}/)
    if (nat) {
      ctx.bib.set(m[1], { label: nat[1], year: nat[2], authors: nat[3].replace(/\\[a-z]+\s*/gi, '').replace(/[{}]/g, '') })
      if (nat[2]) ctx.authorYear = true
    } else ctx.bib.set(m[1], { label: m[2].replace(/[{}]/g, '') })
  }
  for (const m of aux.matchAll(/\\newlabel\{([^}]*)\}\{\{([^}]*)\}/g)) ctx.known.set(m[1], { text: m[2].replace(/[{}]/g, ''), kind: /^eq/.test(m[1]) ? 'equation' : /^fig/.test(m[1]) ? 'figure' : /^tab/.test(m[1]) ? 'table' : /^(sec|ch)/.test(m[1]) ? 'section' : 'other' })
  const bbl = sources.bbl ?? ''
  if (bbl && !/\\entry\{/.test(bbl)) {
    let n = 0
    for (const item of splitTop(bbl.replace(/[\s\S]*?\\begin\{thebibliography\}\s*\{[^}]*\}/, '').replace(/\\end\{thebibliography\}[\s\S]*/, ''), /\\bibitem\b/y).slice(1)) {
      n++
      const opt = item.match(/^\s*\[((?:[^\][]|\{[^}]*\})*)\]/)
      const keyM = item.slice(opt ? opt[0].length : 0).match(/^\s*\{([^}]*)\}/)
      if (!keyM) continue
      const text = item.slice((opt ? opt[0].length : 0) + keyM[0].length).replace(/\\newblock\b/g, '').trim()
      const known = ctx.bib.get(keyM[1])
      ctx.bib.set(keyM[1], { label: known?.label ?? String(n), year: known?.year, authors: known?.authors, text })
    }
    return
  }
  // no formatted bibliography (biblatex, or never compiled): a plain one from the .bib, numbered by first citation
  if (sources.bib) ctx.warnings.add(bbl ? 'biblatex references are written in a simple style' : 'References are written in a simple style (compile first to use the document’s own style)')
}

function bibFallback(ctx: Context, bib: Map<string, Record<string, string>> | undefined) {
  if (!bib) return
  ctx.citeOrder.forEach((key, i) => {
    const f = bib.get(key)
    if (!f || ctx.bib.get(key)?.text != null) return
    const clean = (s?: string) => (s ?? '').replace(/[{}]/g, '').replace(/\s+/g, ' ').trim()
    const authors = clean(f.author).split(/\s+and\s+/).map(a => (a.includes(',') ? a.split(',').reverse().join(' ').trim() : a)).filter(Boolean)
    const who = authors.length > 2 ? `${authors[0]} et al.` : authors.join(' and ')
    const venue = clean(f.journal || f.booktitle || f.publisher || f.school || f.institution)
    const text = [who && `${who}.`, clean(f.title) && `\\emph{${clean(f.title)}}.`, venue && `${venue}${f.volume ? ` ${clean(f.volume)}` : ''}${f.number ? `(${clean(f.number)})` : ''}${f.pages ? `:${clean(f.pages).replace('--', '–')}` : ''},`, clean(f.year) && `${clean(f.year)}.`, f.doi ? `doi:${clean(f.doi)}` : '']
      .filter(Boolean)
      .join(' ')
    const surname = (authors[0] ?? key).split(' ').pop()
    ctx.bib.set(key, { label: ctx.bib.get(key)?.label ?? String(i + 1), year: clean(f.year), authors: authors.length > 2 ? `${surname} et al.` : authors.length === 2 ? `${authors[0].split(' ').pop()} and ${authors[1].split(' ').pop()}` : surname, text })
  })
}

/** Convert a whole document (with \input files already merged in). */
export function latexToDoc(source: string, sources: Sources = {}): DocModel {
  const start = source.search(/\\begin\s*\{document\}/)
  const preamble = start < 0 ? '' : source.slice(0, start)
  const body = start < 0 ? source : source.slice(start)
  const cls = preamble.match(/\\documentclass\s*(?:\[([^\]]*)\])?\s*\{([^}]*)\}/)
  const run = (known: Map<string, Label>, citeOrder: string[]) => {
    const ctx = new Context()
    ctx.known = known
    ctx.hasChapters = /^(report|book|memoir|scrbook|scrreprt|thesis)/.test(cls?.[2] ?? '') || /\\chapter\b/.test(body)
    readPreamble(ctx, preamble)
    readBibliography(ctx, sources)
    ctx.citeOrder = [...citeOrder]
    bibFallback(ctx, sources.bib)
    const p = new Parser(ctx)
    p.parse(body)
    p.flush()
    return { ctx, blocks: p.out }
  }
  // twice: the first pass finds labels and citations, so references to later things get their numbers
  const first = run(new Map(), [])
  const known = new Map([...first.ctx.known, ...first.ctx.labels])
  const { ctx, blocks } = run(known, first.ctx.citeOrder)
  const plain = (runs: Run[]) => runs.map(r => (r.kind === 'text' ? r.text : r.kind === 'math' ? r.tex : '')).join('')
  return {
    blocks,
    lists: ctx.lists,
    title: plain(ctx.title),
    author: ctx.author.map(plain).join(', '),
    paper: /a4paper/.test(cls?.[1] ?? '') || /\\usepackage\s*\[[^\]]*a4paper/.test(preamble) ? 'a4' : 'letter',
    macros: ctx.macros,
    warnings: [...ctx.warnings].slice(0, 12),
    counts: ctx.counts,
  }
}
