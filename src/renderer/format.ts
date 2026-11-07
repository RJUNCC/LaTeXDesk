// Formatting commands for the toolbar: text styles, headings, lists, math and inserts.
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import { snippet, startCompletion } from '@codemirror/autocomplete'
import { SyntaxNode } from '@lezer/common'

/** Services the commands need from the app (package management, dialogs). */
export type FormatContext = {
  ensurePackage(name: string, options?: string): void
  /** Add a preamble line (e.g. \usetikzlibrary{…}) unless `present` matches the preamble. */
  ensurePreamble(line: string, present: RegExp): void
  prompt(message: string, initial?: string): Promise<string | null>
  /** Pick a picture with the system file dialog; its \includegraphics path, or null if cancelled. */
  chooseImage(): Promise<string | null>
  /** The 📚 Sources dialog: add sources, cite them, choose the reference style. */
  openSources(): void
}

// Commands Overleaf's grammar parses into dedicated nodes, so toggling can find and unwrap them
const COMMAND_NODES: Record<string, string> = {
  textbf: 'TextBoldCommand',
  textit: 'TextItalicCommand',
  underline: 'UnderlineCommand',
  texttt: 'TextTeletypeCommand',
  textsc: 'TextSmallCapsCommand',
  emph: 'EmphasisCommand',
  textsuperscript: 'TextSuperscriptCommand',
  textsubscript: 'TextSubscriptCommand',
  sout: 'StrikeOutCommand',
}

export const HEADINGS = ['part', 'chapter', 'section', 'subsection', 'subsubsection', 'paragraph'] as const
export type Heading = (typeof HEADINGS)[number] | 'normal'

const HEADING_RE =
  /^(\s*)\\(part|chapter|section|subsection|subsubsection|paragraph)(\*?)\{((?:[^{}]|\{[^{}]*\})*)\}(.*)$/

/** Insert a CodeMirror snippet (#{} fields, Tab to move between them) replacing the main selection. */
function insertSnippet(view: EditorView, template: string, from?: number, to?: number) {
  const sel = view.state.selection.main
  snippet(template)(view, { label: '' }, from ?? sel.from, to ?? sel.to)
  view.focus()
}

function enclosingNode(state: EditorState, pos: number, name: string): SyntaxNode | null {
  for (const side of [-1, 1] as const) {
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, side)
    for (; node; node = node.parent) if (node.name === name) return node
  }
  return null
}

/** Is the cursor inside \cmd{...}? Used to light up toolbar buttons. */
export function isCommandActive(state: EditorState, command: string) {
  const nodeName = COMMAND_NODES[command]
  return !!nodeName && !!enclosingNode(state, state.selection.main.head, nodeName)
}

/** Wrap the selection in \cmd{...}, or unwrap it if it's already inside one. */
export function toggleCommand(view: EditorView, command: string) {
  const { state } = view
  const nodeName = COMMAND_NODES[command]
  const tx = state.changeByRange(range => {
    const node = nodeName ? enclosingNode(state, range.from, nodeName) : null
    const arg = node && node.getChild('TextArgument')
    const open = arg?.getChild('OpenBrace')
    const close = arg?.getChild('CloseBrace')
    if (node && open && close && range.to <= close.from) {
      // already formatted: remove "\cmd{" and the matching "}"
      const changes = state.changes([
        { from: node.from, to: open.to },
        { from: close.from, to: close.to },
      ])
      return { changes, range: EditorSelection.range(changes.mapPos(range.anchor, 1), changes.mapPos(range.head, 1)) }
    }
    const opener = `\\${command}{`
    return {
      changes: [
        { from: range.from, insert: opener },
        { from: range.to, insert: '}' },
      ],
      range: EditorSelection.range(range.anchor + opener.length, range.head + opener.length),
    }
  })
  view.dispatch(state.update(tx, { scrollIntoView: true, userEvent: 'input.format' }))
  view.focus()
  return true
}

/** Wrap with an arbitrary prefix/suffix, e.g. "{\large " … "}" or "$" … "$". */
export function wrap(view: EditorView, before: string, after: string) {
  view.dispatch(
    view.state.changeByRange(range => ({
      changes: [
        { from: range.from, insert: before },
        { from: range.to, insert: after },
      ],
      range: EditorSelection.range(range.anchor + before.length, range.head + before.length),
    }))
  )
  view.focus()
}

export function currentHeading(state: EditorState): Heading {
  const line = state.doc.lineAt(state.selection.main.head)
  const m = line.text.match(HEADING_RE)
  return m ? (m[2] as Heading) : 'normal'
}

/** Turn the current line(s) into a heading of the given level, or back into normal text. */
export function setHeading(view: EditorView, level: Heading) {
  const { state } = view
  const sel = state.selection.main
  const first = state.doc.lineAt(sel.from)
  const last = state.doc.lineAt(sel.to)

  // empty line: insert a heading and put the cursor inside the braces
  if (first.number === last.number && !first.text.trim() && level !== 'normal') {
    insertSnippet(view, `\\${level}{#{}}`, first.from, first.to)
    return
  }

  const changes = []
  for (let n = first.number; n <= last.number; n++) {
    const line = state.doc.line(n)
    if (!line.text.trim()) continue
    const m = line.text.match(HEADING_RE)
    let text: string
    if (m) {
      const [, indent, , star, title, rest] = m
      text = level === 'normal' ? `${indent}${title}${rest}` : `${indent}\\${level}${star}{${title}}${rest}`
    } else {
      if (level === 'normal') continue
      const indent = line.text.match(/^\s*/)![0]
      text = `${indent}\\${level}{${line.text.trim()}}`
    }
    changes.push({ from: line.from, to: line.to, insert: text })
  }
  view.dispatch({ changes, userEvent: 'input.format' })
  view.focus()
}

/** Expand the selection to whole lines and return the indentation of the first one. */
function selectedLines(state: EditorState) {
  const sel = state.selection.main
  const first = state.doc.lineAt(sel.from)
  const last = state.doc.lineAt(sel.to)
  return {
    from: first.from,
    to: last.to,
    indent: first.text.match(/^\s*/)![0],
    lines: state.sliceDoc(first.from, last.to).split('\n'),
  }
}

/** Wrap the selected lines in \begin{env} … \end{env}, or insert an empty one. */
export function environment(view: EditorView, env: string, emptyBody = '#{}') {
  const { state } = view
  if (state.selection.main.empty) return insertBlock(view, `\\begin{${env}}\n\t${emptyBody}\n\\end{${env}}`)
  const { from, to, indent, lines } = selectedLines(state)
  const body = lines.map(l => `\t${l.slice(Math.min(indent.length, l.match(/^\s*/)![0].length))}`).join('\n')
  const text = `${indent}\\begin{${env}}\n${body.replace(/^/gm, indent)}\n${indent}\\end{${env}}`
  view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length }, userEvent: 'input.format' })
  view.focus()
}

/** Bulleted / numbered list: each selected line becomes an \item. */
export function list(view: EditorView, env: 'itemize' | 'enumerate' | 'description') {
  const { state } = view
  const item = env === 'description' ? '\\item[#{Term}] #{}' : '\\item #{}'
  if (state.selection.main.empty) return environment(view, env, item)
  const { from, to, indent, lines } = selectedLines(state)
  const items = lines
    .filter(l => l.trim())
    .map(l => `${indent}\t\\item ${l.trim().replace(/^\\item\s*/, '')}`)
  const text = `${indent}\\begin{${env}}\n${items.join('\n')}\n${indent}\\end{${env}}`
  view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length }, userEvent: 'input.format' })
  view.focus()
}

/** Insert a block (table, figure…) on its own line after the cursor's line. */
/** Where a block goes: always at the cursor, on lines of its own. */
function placeBlock(state: EditorState, text: string) {
  const head = state.selection.main.head
  const line = state.doc.lineAt(head)
  const indentLen = line.text.match(/^\s*/)![0].length
  const restOfLine = line.text.slice(head - line.from)
  if (!line.text.trim()) return { from: line.from, to: line.to, insert: text }
  if (head - line.from <= indentLen) return { from: line.from, to: line.from, insert: text + '\n' }
  if (!restOfLine.trim()) return { from: line.to, to: line.to, insert: '\n' + text }
  return { from: head, to: head, insert: '\n' + text + '\n' }
}

function insertBlock(view: EditorView, template: string) {
  const p = placeBlock(view.state, template)
  insertSnippet(view, p.insert, p.from, p.to)
}

/** Like insertBlock, but plain text (no snippet fields), for generated code that may contain ${ or #{. */
export function insertRawBlock(view: EditorView, text: string) {
  const p = placeBlock(view.state, text)
  view.dispatch({
    changes: p,
    selection: { anchor: p.from + p.insert.length },
    scrollIntoView: true,
    userEvent: 'input.format',
  })
  view.focus()
}

/** Is pos inside math ($…$, \[…\], \(…\), equation, align…)? */
export function inMath(state: EditorState, pos: number) {
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1); n; n = n.parent) {
    const isMath =
      n.type.is('$MathContainer') || n.name === 'Math' || n.name === 'EquationEnvironment' || n.name === 'EquationArrayEnvironment'
    // the cursor sitting just outside a closing $ still resolves to the math node, so require strict containment
    if (isMath && n.from < pos && pos < n.to) return true
  }
  return false
}

/** Insert a math snippet, wrapping it in $…$ (or \[…\] for multi-line ones) when not already in math. */
export function mathSnippet(view: EditorView, template: string) {
  if (inMath(view.state, view.state.selection.main.head)) return insertSnippet(view, template)
  if (template.includes('\n')) return insertBlock(view, `\\[\n\t${template.replace(/\n/g, '\n\t')}\n\\]`)
  insertSnippet(view, `$${template}$`)
}

export type TableOptions = {
  rows: number
  cols: number
  align: 'l' | 'c' | 'r'
  style: 'grid' | 'booktabs' | 'plain'
  header: boolean
  float: boolean
  caption: string
}

export function insertTable(view: EditorView, ctx: FormatContext, o: TableOptions) {
  const grid = o.style === 'grid'
  const spec = grid ? `|${Array(o.cols).fill(o.align).join('|')}|` : Array(o.cols).fill(o.align).join('')
  const rule = (kind: 'top' | 'mid' | 'bottom' | 'row') => {
    if (o.style === 'booktabs') return kind === 'row' ? null : `\\${kind}rule`
    if (grid) return '\\hline'
    return null
  }
  // every cell is a snippet field, so Tab walks through the table
  const row = (header: boolean) =>
    Array.from({ length: o.cols }, (_, c) => (header ? `\\textbf{#{Heading ${c + 1}}}` : '#{}')).join(' & ') + ' \\\\'
  const body: string[] = []
  const push = (s: string | null) => s && body.push(s)
  push(rule('top'))
  for (let r = 0; r < o.rows; r++) {
    const isHeader = o.header && r === 0
    body.push(row(isHeader))
    if (r === o.rows - 1) push(rule('bottom'))
    else push(isHeader ? rule('mid') : rule('row'))
  }
  const tabular = [`\\begin{tabular}{${spec}}`, ...body.map(l => `\t${l}`), '\\end{tabular}']
  const lines = o.float
    ? [
        '\\begin{table}[h]',
        '\t\\centering',
        ...tabular.map(l => `\t${l}`),
        `\t\\caption{#{${o.caption.replace(/[{}]/g, '')}}}`,
        '\t\\label{tab:#{label}}',
        '\\end{table}',
      ]
    : tabular
  insertBlock(view, lines.join('\n'))
  if (o.style === 'booktabs') ctx.ensurePackage('booktabs')
}

export async function insertFigure(view: EditorView, ctx: FormatContext) {
  const file = await ctx.chooseImage()
  if (!file) return
  insertBlock(
    view,
    [
      '\\begin{figure}[h]',
      '\t\\centering',
      `\t\\includegraphics[width=#{0.8}\\linewidth]{${file.replace(/[#${}]/g, '')}}`,
      '\t\\caption{#{Caption}}',
      '\t\\label{fig:#{label}}',
      '\\end{figure}',
    ].join('\n')
  )
  ctx.ensurePackage('graphicx')
}

export async function insertLink(view: EditorView, ctx: FormatContext) {
  const sel = view.state.selection.main
  const url = await ctx.prompt('Link URL', 'https://')
  if (!url) return
  // hyperref wants # and % escaped; with braces stripped this can't form a snippet field
  const latexUrl = url.replace(/[{}]/g, '').replace(/[#%]/g, '\\$&')
  if (sel.empty) insertSnippet(view, `\\href{${latexUrl}}{#{link text}}`)
  else wrap(view, `\\href{${latexUrl}}{`, '}')
  ctx.ensurePackage('hyperref')
}

/** Insert \cmd{} and pop open autocomplete (labels for \ref, bib keys for \cite). */
export function insertWithCompletion(view: EditorView, command: string) {
  insertSnippet(view, `\\${command}{#{}}`)
  startCompletion(view)
}

export { insertSnippet, insertBlock }
