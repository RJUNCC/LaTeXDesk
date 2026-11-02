// Accessibility check: things that make the PDF hard to use with a screen reader, for people with low vision
// or colour blindness, or that universities' accessibility rules ask for. The checks read the LaTeX; most
// come with a one-click fix.

export type A11yIssue = {
  id: string
  severity: 'problem' | 'warning' | 'tip'
  title: string
  detail: string
  file: string
  /** where in the file (offsets), for highlighting and fixes */
  from: number
  to: number
  /** what the fix does, if there is one */
  fix?: Fix
}
export type Fix =
  | { kind: 'alt'; image: string }
  | { kind: 'metadata'; title: string }
  | { kind: 'link'; url: string; label: string }
  | { kind: 'header-rule'; at: number }
  | { kind: 'replace'; from: number; to: number; text: string; label: string }

type Source = { path: string; text: string }

// colours and their contrast against a white page (WCAG asks for 4.5 : 1 for text)
const NAMED: Record<string, string> = {
  red: 'FF0000', green: '00FF00', blue: '0000FF', cyan: '00FFFF', magenta: 'FF00FF', yellow: 'FFFF00', black: '000000', white: 'FFFFFF',
  gray: '808080', darkgray: '404040', lightgray: 'BFBFBF', brown: 'BF8040', lime: 'BFFF00', olive: '808000', orange: 'FF8000', pink: 'FFBFBF',
  purple: 'BF0040', teal: '008080', violet: '800080',
}

function luminance(hex: string) {
  const [r, g, b] = [0, 2, 4].map(i => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
export const contrastOnWhite = (hex: string) => 1.05 / (luminance(hex) + 0.05)

/** The colour a name like red, red!40, or one from \definecolor stands for. */
function colourOf(spec: string, defined: Record<string, string>) {
  const [name, pct, other] = spec.split('!').map(s => s.trim())
  const base = defined[name] ?? NAMED[name]
  if (!base) return null
  if (!pct) return base
  const p = Math.max(0, Math.min(100, parseFloat(pct))) / 100
  const mix = other ? (defined[other] ?? NAMED[other] ?? 'FFFFFF') : 'FFFFFF'
  return [0, 2, 4].map(o => Math.round(parseInt(base.slice(o, o + 2), 16) * p + parseInt(mix.slice(o, o + 2), 16) * (1 - p)).toString(16).padStart(2, '0')).join('').toUpperCase()
}

/** The lightest shade of the colour (mixed with black, in xcolor's name!p!black form) that is readable. */
function darker(spec: string, defined: Record<string, string>) {
  const name = spec.split('!')[0].trim()
  for (let p = 90; p >= 10; p -= 10) {
    const hex = colourOf(`${name}!${p}!black`, defined)
    if (hex && contrastOnWhite(hex) >= 4.5) return `${name}!${p}!black`
  }
  return null
}

/** The text with comments blanked out (same length, so offsets stay valid). */
const uncomment = (t: string) => t.replace(/(^|[^\\])(%.*)$/gm, (_m, a, c) => a + ' '.repeat(c.length))

/** Index just past the brace group opening at `open`. */
function groupEnd(s: string, open: number) {
  let depth = 0
  for (let i = open; i < s.length; i++) {
    if (s[i] === '\\') i++
    else if (s[i] === '{') depth++
    else if (s[i] === '}' && --depth === 0) return i + 1
  }
  return s.length
}

const LEVELS: Record<string, number> = { part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4 }
const VAGUE_LINK = /^\s*(here|click here|this|this link|link|more|read more|website|page)\s*\.?\s*$/i

export function checkAccessibility(sources: Source[], mainFile: string): A11yIssue[] {
  const issues: A11yIssue[] = []
  const add = (i: Omit<A11yIssue, 'id'>) => issues.push({ ...i, id: `${i.file}:${i.from}:${i.title}` })
  const main = sources.find(s => s.path === mainFile) ?? sources[0]
  if (!main) return issues
  const mainText = uncomment(main.text)
  const preambleEnd = mainText.indexOf('\\begin{document}')
  const preamble = preambleEnd < 0 ? mainText : mainText.slice(0, preambleEnd)
  const defined: Record<string, string> = {}
  for (const s of sources)
    for (const m of uncomment(s.text).matchAll(/\\definecolor\s*\{([^}]*)\}\s*\{(HTML|rgb|RGB)\}\s*\{([^}]*)\}/g)) {
      const v = m[3].trim()
      defined[m[1]] = m[2] === 'HTML' ? v.toUpperCase() : v.split(',').map(x => Math.round(parseFloat(x) * (m[2] === 'rgb' ? 255 : 1)).toString(16).padStart(2, '0')).join('').toUpperCase()
    }
  const beamer = /\\documentclass\s*(\[[^\]]*\])?\s*\{beamer\}/.test(preamble)

  // the PDF's title and language, which screen readers announce
  const hasLang = /pdflang\s*=|\\DocumentMetadata\s*\{[^}]*lang\s*=/.test(preamble)
  const hasTitle = /pdftitle\s*=|\\DocumentMetadata\s*\{[^}]*title/.test(preamble) || /pdfusetitle/.test(preamble)
  if (!hasLang || !hasTitle) {
    const title = (mainText.match(/\\title\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/)?.[1] ?? '').replace(/\\\\|\\[a-zA-Z]+\s*/g, ' ').replace(/\s+/g, ' ').trim()
    const where = mainText.search(/\\documentclass/)
    add({
      severity: 'problem',
      title: !hasLang && !hasTitle ? 'The PDF has no title or language' : !hasLang ? 'The PDF has no language set' : 'The PDF has no title',
      detail: 'Screen readers announce the title (not the file name) and need the language to pronounce words correctly.',
      file: main.path,
      from: Math.max(0, where),
      to: Math.max(0, where) + 14,
      fix: { kind: 'metadata', title: title || 'Untitled' },
    })
  }

  for (const src of sources) {
    const text = uncomment(src.text)
    const bodyStart = src.path === main.path ? Math.max(0, preambleEnd) : 0

    // pictures without a text description
    for (const m of text.matchAll(/\\includegraphics\s*(\[([^\]]*)\])?\s*\{([^}]*)\}/g)) {
      if (m.index! < bodyStart) continue
      if (/\balt\s*=/.test(m[2] ?? '')) continue
      add({
        severity: 'problem',
        title: `Picture without a description: ${m[3]}`,
        detail: 'Add alt text: a sentence saying what the picture shows, read aloud by screen readers.',
        file: src.path,
        from: m.index!,
        to: m.index! + m[0].length,
        fix: { kind: 'alt', image: m[3] },
      })
    }

    // figures without a caption
    for (const m of text.matchAll(/\\begin\{figure\*?\}([\s\S]*?)\\end\{figure\*?\}/g)) {
      if (/\\caption/.test(m[1]) || !/\\includegraphics|\\begin\{tikzpicture\}/.test(m[1])) continue
      add({ severity: 'warning', title: 'Figure without a caption', detail: 'A caption tells every reader what the figure is for, and lets you refer to it by number.', file: src.path, from: m.index!, to: m.index! + 14 })
    }

    // tables: a header row, set off by a rule, is how readers (and tagging) know what each column holds
    for (const m of text.matchAll(/\\begin\{(tabular\*?|tabularx|longtable)\}/g)) {
      const end = text.indexOf(`\\end{${m[1]}}`, m.index!)
      if (end < 0) continue
      const body = text.slice(m.index! + m[0].length, end).replace(/^\s*(\[[^\]]*\])?\s*\{[^}]*\}(\s*\{[^}]*\})?/, '')
      const rows = body.split(/\\\\/).filter(r => r.replace(/\\(hline|toprule|midrule|bottomrule)/g, '').trim())
      if (rows.length < 2) continue
      const firstBreak = text.indexOf('\\\\', m.index!)
      const afterFirst = text.slice(firstBreak + 2, firstBreak + 80)
      if (/^\s*(\[[^\]]*\])?\s*\\(hline|midrule|cline|cmidrule)/.test(afterFirst)) continue
      add({
        severity: 'tip',
        title: 'Table without a marked header row',
        detail: 'Put a rule under the header row (\\midrule with booktabs, or \\hline) so the column headings stand out.',
        file: src.path,
        from: m.index!,
        to: m.index! + m[0].length,
        fix: firstBreak > 0 && firstBreak < end ? { kind: 'header-rule', at: firstBreak + 2 } : undefined,
      })
    }

    // heading levels that skip one (a section straight to a subsubsection)
    let last = -1
    for (const m of text.matchAll(/\\(part|chapter|section|subsection|subsubsection)\*?\s*(\[[^\]]*\])?\s*\{/g)) {
      const level = LEVELS[m[1]]
      if (last >= 0 && level > last + 1)
        add({ severity: 'warning', title: `Heading level skipped: \\${m[1]} after a higher level`, detail: 'Screen-reader users navigate by headings; a skipped level looks like something is missing.', file: src.path, from: m.index!, to: m.index! + m[0].length - 1 })
      last = level
    }

    // text colours that are hard to read on white
    for (const m of text.matchAll(/\\(?:textcolor|color)\s*\{([^}]*)\}/g)) {
      const hex = colourOf(m[1], defined)
      if (!hex) continue
      const ratio = contrastOnWhite(hex)
      if (ratio >= 4.5 || beamer) continue
      add({
        severity: 'warning',
        title: `Low-contrast text colour: ${m[1]} (${ratio.toFixed(1)} : 1)`,
        detail: 'Text needs a contrast of at least 4.5 : 1 against the page to be readable for people with low vision. Use a darker shade.',
        file: src.path,
        from: m.index!,
        to: m.index! + m[0].length,
        fix: darker(m[1], defined) ? { kind: 'replace', from: m.index!, to: m.index! + m[0].length, text: m[0].replace(m[1], darker(m[1], defined)!), label: `Use a darker ${m[1].split('!')[0]}` } : undefined,
      })
    }

    // links whose text doesn't say where they go
    for (const m of text.matchAll(/\\href\s*\{([^}]*)\}\s*\{/g)) {
      const open = m.index! + m[0].length - 1
      const label = text.slice(open + 1, groupEnd(text, open) - 1)
      if (!VAGUE_LINK.test(label)) continue
      add({ severity: 'warning', title: `Link text “${label.trim()}” doesn’t say where it goes`, detail: 'Screen-reader users often list a page’s links on their own; “here” tells them nothing. Name the destination instead.', file: src.path, from: m.index!, to: groupEnd(text, open) })
    }

    // very small text
    for (const m of text.matchAll(/\\(tiny|scriptsize)\b/g)) {
      if (m.index! < bodyStart) continue
      add({ severity: 'tip', title: `Very small text (\\${m[1]})`, detail: 'Text this small is hard to read in print and for people with low vision.', file: src.path, from: m.index!, to: m.index! + m[0].length })
    }
  }

  // a tagged PDF: what PDF/UA and many universities' accessibility policies ask for
  if (!/\\DocumentMetadata/.test(main.text) && !beamer) {
    const where = Math.max(0, mainText.search(/\\documentclass/))
    add({
      severity: 'tip',
      title: 'Make a tagged (structured) PDF',
      detail: 'A tagged PDF tells screen readers what is a heading, a list, a table or a figure. LaTeX is adding this with \\DocumentMetadata, but it is still experimental: it needs an up-to-date MiKTeX (update it in the MiKTeX Console), doesn’t work with the built-in engine yet, and some packages don’t support it. The fixes above help either way.',
      file: main.path,
      from: where,
      to: where + 14,
      fix: { kind: 'link', url: 'https://latex3.github.io/tagging-project/', label: 'How to make a tagged PDF' },
    })
  }

  const order = { problem: 0, warning: 1, tip: 2 }
  return issues.sort((a, b) => order[a.severity] - order[b.severity] || a.file.localeCompare(b.file) || a.from - b.from)
}

// ---------- fixes (pure text edits, so they can be shown and undone like any edit) ----------

/** Add alt={…} to the \includegraphics at `from`. */
export function withAlt(text: string, from: number, alt: string) {
  const m = text.slice(from).match(/^\\includegraphics\s*(\[([^\]]*)\])?/)
  if (!m) return text
  const clean = alt.replace(/[{}\\%#&$]/g, '').trim()
  const opts = m[2]?.trim()
  const replacement = `\\includegraphics[${opts ? `${opts}, ` : ''}alt={${clean}}]`
  return text.slice(0, from) + replacement + text.slice(from + m[0].length)
}

/** \hypersetup with the PDF title and language (loading hyperref if needed), after the last \usepackage. */
export function withMetadata(text: string, title: string, lang = 'en-US') {
  const end = text.indexOf('\\begin{document}')
  const preamble = end < 0 ? text : text.slice(0, end)
  const lines: string[] = []
  if (!/\\usepackage\s*(\[[^\]]*\])?\s*\{[^}]*\bhyperref\b/.test(preamble)) lines.push('\\usepackage{hyperref}')
  const keys = [/pdftitle\s*=/.test(preamble) ? '' : `pdftitle={${title.replace(/[{}\\]/g, '')}}`, /pdflang\s*=/.test(preamble) ? '' : `pdflang={${lang}}`, 'pdfdisplaydoctitle=true'].filter(Boolean)
  lines.push(`\\hypersetup{${keys.join(', ')}}`)
  const anchors = [...preamble.matchAll(/^\\(?:usepackage|documentclass)\b.*$/gm)]
  const at = anchors.length ? anchors[anchors.length - 1].index! + anchors[anchors.length - 1][0].length : 0
  return text.slice(0, at) + '\n' + lines.join('\n') + text.slice(at)
}

export function withHeaderRule(text: string, at: number) {
  const rule = /\\(toprule|midrule|bottomrule)/.test(text) ? '\\midrule' : '\\hline'
  return text.slice(0, at) + ` ${rule}` + text.slice(at)
}
