// LaTeX → prose for checkers. Splits the document into paragraphs and turns each into LanguageTool's
// annotated-text form: prose stays text, LaTeX becomes markup with a stand-in reading (math → "x",
// \cite → "[1]", \ref → "1"). The pieces concatenate back to the exact source, so checker offsets
// map 1:1 onto document positions.
import type { EditorState } from '@codemirror/state'
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { noSpellCheckProp } from '../overleaf/latex-language'

export type Segment = { text: string } | { markup: string; interpretAs: string }
export type Paragraph = { from: number; to: number; text: string; section: string }

// whole subtrees that are never prose, with what a reader would "hear" in their place
const SKIP: Record<string, string> = {
  Comment: '',
  EquationEnvironment: '',
  EquationArrayEnvironment: '',
  VerbContent: 'code',
  VerbatimContent: '',
  LstInlineContent: 'code',
  BeginEnv: '',
  EndEnv: '',
  OptionalArgument: '',
  LiteralArgContent: '',
  SpaceDelimitedLiteralArgContent: '',
}
const CITE = /^\\(no)?cite|^\\(paren|text|auto|foot)cite/
const REF = /^\\(eq|auto|c|C|page|name)?ref\b/

type Span = { from: number; to: number; as: string }

/** Ranges inside [from, to) that are LaTeX rather than prose, each with its stand-in text. */
function markupSpans(state: EditorState, from: number, to: number): Span[] {
  const spans: Span[] = []
  // the editor parses lazily; make sure this range is parsed before walking it
  const tree = ensureSyntaxTree(state, to, 500) ?? syntaxTree(state)
  tree.iterate({
    from,
    to,
    enter(node) {
      const n = node.node
      if (n.to <= from || n.from >= to) return false
      const add = (as: string) => spans.push({ from: Math.max(n.from, from), to: Math.min(n.to, to), as })
      if (n.name in SKIP) return add(SKIP[n.name]), false
      if (n.name === 'Tilde') return add(' '), false
      if (n.type.is('$MathContainer')) {
        const text = state.sliceDoc(n.from, n.to)
        return add(/^\$\$|^\\\[/.test(text) ? '' : 'x'), false
      }
      const ctx = n.type.prop(noSpellCheckProp)
      if (ctx?.some(c => (c.length === 1 && c[0] === '') || n.matchContext(c))) return add(''), false
      if (n.type.is('$CtrlSeq') || n.type.is('$CtrlSym') || n.name === 'CtrlSeq' || n.name === 'OpenBrace' || n.name === 'CloseBrace') {
        const text = state.sliceDoc(n.from, n.to)
        if (text === '\\\\' || text === '~') return add(' '), false
        return add(''), false
      }
      return undefined
    },
  })
  // a whole \cite{…} / \ref{…} reads as a citation / number, not as nothing
  const text = state.sliceDoc(from, to)
  for (const m of text.matchAll(/\\[A-Za-z]+\*?(\[[^\]]*\])*\{[^}]*\}/g)) {
    const cmd = m[0]
    if (!CITE.test(cmd) && !REF.test(cmd)) continue
    const a = from + m.index!
    const b = a + cmd.length
    for (let i = spans.length - 1; i >= 0; i--) if (spans[i].from >= a && spans[i].to <= b) spans.splice(i, 1)
    spans.push({ from: a, to: b, as: CITE.test(cmd) ? '[1]' : '1' })
  }
  spans.sort((x, y) => x.from - y.from || y.to - x.to)
  // merge overlaps (outer span wins)
  const merged: Span[] = []
  for (const s of spans) {
    const last = merged[merged.length - 1]
    if (last && s.from < last.to) {
      if (s.to > last.to) last.to = s.to
      continue
    }
    merged.push({ ...s })
  }
  return merged
}

/** LanguageTool annotation for a document range; concatenating every piece gives back the source exactly. */
export function annotate(state: EditorState, from: number, to: number): Segment[] {
  const out: Segment[] = []
  let pos = from
  const pushText = (a: number, b: number) => {
    if (b <= a) return
    // single line breaks inside a paragraph are just spaces to a reader
    const raw = state.sliceDoc(a, b)
    let last = 0
    for (const m of raw.matchAll(/\n/g)) {
      if (m.index! > last) out.push({ text: raw.slice(last, m.index) })
      out.push({ markup: '\n', interpretAs: ' ' })
      last = m.index! + 1
    }
    if (last < raw.length) out.push({ text: raw.slice(last) })
  }
  for (const s of markupSpans(state, from, to)) {
    pushText(pos, s.from)
    out.push({ markup: state.sliceDoc(s.from, s.to), interpretAs: s.as })
    pos = s.to
  }
  pushText(pos, to)
  return out
}

/** The plain reading of a range (what a checker or the LLM should see). */
export function plainText(state: EditorState, from: number, to: number) {
  return annotate(state, from, to)
    .map(s => ('text' in s ? s.text : s.interpretAs))
    .join('')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

/** Prose paragraphs of the document body (between \begin{document} and \end{document} when present). */
export function paragraphs(state: EditorState): Paragraph[] {
  const doc = state.doc.toString()
  const begin = doc.indexOf('\\begin{document}')
  const end = doc.lastIndexOf('\\end{document}')
  const bodyFrom = begin >= 0 ? begin + '\\begin{document}'.length : 0
  const bodyTo = end >= 0 ? end : doc.length
  const out: Paragraph[] = []
  let section = ''
  const re = /\n[ \t]*\n/g
  let start = bodyFrom
  const flush = (a: number, b: number) => {
    let text = doc.slice(a, b)
    const lead = text.length - text.trimStart().length
    text = text.trim()
    if (!text) return
    const head = text.match(/^\\(?:part|chapter|section|subsection|subsubsection)\*?\{((?:[^{}]|\{[^{}]*\})*)\}/)
    if (head) section = head[1]
    // skip paragraphs that are only commands/environments (figures, tables, \maketitle…)
    const words = plainText(state, a + lead, a + lead + text.length).match(/[A-Za-z]{2,}/g) ?? []
    if (words.length < 4) return
    out.push({ from: a + lead, to: a + lead + text.length, text, section })
  }
  let m: RegExpExecArray | null
  re.lastIndex = bodyFrom
  while ((m = re.exec(doc)) && m.index < bodyTo) {
    flush(start, m.index)
    start = m.index + m[0].length
  }
  flush(start, bodyTo)
  return out
}

/** Cheap stable hash for caching per paragraph. */
export function hash(s: string) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return (h >>> 0).toString(36) + s.length.toString(36)
}
