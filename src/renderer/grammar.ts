// Live grammar & style underlines from the local LanguageTool server. Each paragraph is checked once per
// distinct text (cached by hash); offsets map straight onto the document because the annotation
// concatenates back to the source (see prose.ts).
import { EditorState, Extension, RangeSetBuilder, StateEffect } from '@codemirror/state'
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, hoverTooltip } from '@codemirror/view'
import { Paragraph, Segment, annotate, hash, paragraphs } from './prose'

export type LtMatch = { offset: number; length: number; message: string; shortMessage: string; replacements: string[]; rule: string; category: string; issueType: string }
type Bridge = {
  status(): Promise<{ installed: boolean; java: boolean; running: boolean }>
  install(): Promise<unknown>
  check(annotation: Segment[], language?: string): Promise<LtMatch[]>
  onInstallProgress(cb: (p: { stage: string; fraction: number | null }) => void): void
}
export const lt: Bridge = (window as unknown as { texdesk: { lt: Bridge } }).texdesk.lt

/** Absolute issue in the document. */
export type GrammarIssue = LtMatch & { from: number; to: number; kind: 'correctness' | 'style' }

const cache = new Map<string, LtMatch[]>() // paragraph hash -> matches (offsets relative to the paragraph)
let available: boolean | null = null
const refresh = StateEffect.define<null>()

const STYLE_TYPES = new Set(['style', 'locale-violation', 'register', 'uncategorized'])
const kindOf = (m: LtMatch): GrammarIssue['kind'] => (STYLE_TYPES.has(m.issueType) || /STYLE|REDUNDANCY|PLAIN_ENGLISH|WORD_REPEAT/.test(m.category) ? 'style' : 'correctness')

export async function grammarAvailable(recheck = false) {
  if (available === null || recheck) available = await lt.status().then(s => s.installed && s.java, () => false)
  return available
}

async function checkParagraph(state: EditorState, p: Paragraph) {
  const key = hash(p.text)
  if (cache.has(key)) return cache.get(key)!
  const matches = await lt.check(annotate(state, p.from, p.to))
  cache.set(key, matches)
  return matches
}

/** Every issue in the document (checks paragraphs not seen yet). Used by the Review tab. */
export async function checkDocument(state: EditorState, onProgress: (done: number, total: number) => void = () => {}): Promise<GrammarIssue[]> {
  if (!(await grammarAvailable())) return []
  const ps = paragraphs(state)
  const out: GrammarIssue[] = []
  for (const [i, p] of ps.entries()) {
    const ms = await checkParagraph(state, p)
    for (const m of ms) out.push({ ...m, from: p.from + m.offset, to: p.from + m.offset + m.length, kind: kindOf(m) })
    onProgress(i + 1, ps.length)
  }
  return out
}

/** Issues already known for the current text (no new checks). */
export function knownIssues(state: EditorState): GrammarIssue[] {
  const out: GrammarIssue[] = []
  for (const p of paragraphs(state)) {
    for (const m of cache.get(hash(p.text)) ?? []) out.push({ ...m, from: p.from + m.offset, to: p.from + m.offset + m.length, kind: kindOf(m) })
  }
  return out
}

const marks = { correctness: Decoration.mark({ class: 'cm-lt-correctness' }), style: Decoration.mark({ class: 'cm-lt-style' }) }

const plugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet = Decoration.none
    timer: number | undefined
    running = false

    constructor(readonly view: EditorView) {
      this.schedule(400)
    }

    update(u: ViewUpdate) {
      if (u.docChanged) this.decorations = this.decorations.map(u.changes)
      if (u.docChanged || u.viewportChanged || u.transactions.some(t => t.effects.some(e => e.is(refresh)))) this.schedule()
    }

    schedule(delay = 800) {
      clearTimeout(this.timer)
      this.timer = window.setTimeout(() => void this.run(), delay)
    }

    async run() {
      if (this.running) return this.schedule(300)
      if (!(await grammarAvailable())) return
      this.running = true
      try {
        const view = this.view
        const { from, to } = view.viewport
        const visible = paragraphs(view.state).filter(p => p.to >= from && p.from <= to)
        for (const p of visible) {
          if (cache.has(hash(p.text))) continue
          try {
            await checkParagraph(view.state, p)
          } catch {
            return // server not reachable right now: try again on the next edit
          }
        }
        this.decorate()
      } finally {
        this.running = false
      }
    }

    decorate() {
      const view = this.view
      const b = new RangeSetBuilder<Decoration>()
      const issues = knownIssues(view.state)
        .filter(i => i.to <= view.state.doc.length)
        .sort((x, y) => x.from - y.from)
      let last = -1
      for (const i of issues) {
        if (i.from < last || i.to <= i.from) continue // RangeSetBuilder needs sorted, non-overlapping-from ranges
        b.add(i.from, i.to, marks[i.kind])
        last = i.from
      }
      this.decorations = b.finish()
      view.dispatch({})
    }

    destroy() {
      clearTimeout(this.timer)
    }
  },
  { decorations: v => v.decorations }
)

const tooltip = hoverTooltip(
  (view, pos) => {
    const issue = knownIssues(view.state).find(i => pos >= i.from && pos <= i.to)
    if (!issue) return null
    return {
      pos: issue.from,
      end: issue.to,
      above: true,
      create: () => {
        const dom = document.createElement('div')
        dom.className = `cm-lt-tip ${issue.kind}`
        const msg = Object.assign(document.createElement('div'), { className: 'cm-lt-msg', textContent: issue.message })
        const fixes = document.createElement('div')
        fixes.className = 'cm-lt-fixes'
        for (const r of issue.replacements.slice(0, 4)) {
          const b = Object.assign(document.createElement('button'), { textContent: r || '(remove)' })
          b.onmousedown = e => e.preventDefault()
          b.onclick = () => view.dispatch({ changes: { from: issue.from, to: issue.to, insert: r }, userEvent: 'input.grammar' })
          fixes.appendChild(b)
        }
        const rule = Object.assign(document.createElement('div'), { className: 'cm-lt-rule', textContent: `${issue.kind === 'style' ? 'Style' : 'Grammar'} · LanguageTool ${issue.rule}` })
        dom.append(msg, fixes, rule)
        return { dom }
      },
    }
  },
  { hoverTime: 250 }
)

export function grammarCheck(): Extension {
  return [plugin, tooltip]
}

/** Re-run the live checker (after installing LanguageTool, for example). */
export function refreshGrammar(view: EditorView) {
  view.dispatch({ effects: refresh.of(null) })
}
