// AI autocomplete: after a short pause in typing, a fill-in-the-middle model proposes a continuation,
// shown as grey "ghost" text at the cursor. Tab accepts, Esc dismisses, typing anything else discards it.
import { Prec, StateEffect, StateField, Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, ViewUpdate, WidgetType, keymap } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import type { SyntaxNode } from '@lezer/common'
import { featureReady, runAi } from './ai-client'

type Ghost = { pos: number; text: string } | null

const DEBOUNCE_MS = 550
const PREFIX_CHARS = 2500
const SUFFIX_CHARS = 1200

const setGhost = StateEffect.define<Ghost>()

class GhostWidget extends WidgetType {
  constructor(readonly text: string) {
    super()
  }
  eq(other: GhostWidget) {
    return other.text === this.text
  }
  toDOM() {
    const span = document.createElement('span')
    span.className = 'cm-ghost'
    span.textContent = this.text
    return span
  }
  ignoreEvent() {
    return true
  }
}

const ghostField = StateField.define<Ghost>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setGhost)) return e.value
    // any edit or cursor move makes the suggestion stale
    if (tr.docChanged || tr.selection) return null
    return value
  },
  provide: f =>
    EditorView.decorations.from(f, g =>
      g ? Decoration.set([Decoration.widget({ widget: new GhostWidget(g.text), side: 1 }).range(g.pos)]) : Decoration.none
    ),
})

/** Places where a suggestion would be noise: comments, the preamble, the middle of existing text. */
function worthSuggesting(view: EditorView) {
  const { state } = view
  const sel = state.selection.main
  if (!sel.empty || state.selection.ranges.length > 1) return false
  const pos = sel.head
  const line = state.doc.lineAt(pos)
  const after = line.text.slice(pos - line.from)
  if (after.trim() && !/^[\s})\]$]*$/.test(after)) return false
  if (!line.text.slice(0, pos - line.from).trim() && pos === line.from && line.number > 1 && !state.doc.line(line.number - 1).text.trim()) {
    // empty line after an empty line: nothing to continue yet
    return false
  }
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1); n; n = n.parent) {
    if (n.name === 'Comment') return false
  }
  const begin = state.doc.toString().indexOf('\\begin{document}')
  if (begin >= 0 && pos < begin) return false
  return true
}

/** Tidy a raw model completion: one paragraph at most, no echo of text that's already there. */
function clean(text: string, before: string, after: string) {
  let t = text.replace(/\r/g, '')
  // the cursor already follows a space: don't add a second one
  if (/\s$/.test(before)) t = t.replace(/^[ \t]+/, '')
  const para = t.indexOf('\n\n')
  if (para >= 0) t = t.slice(0, para)
  t = t.replace(/\s+$/, '')
  if (t.length > 400) t = t.slice(0, 400).replace(/\s\S*$/, '')
  // the model sometimes repeats what already follows the cursor (a closing brace, the next line…):
  // cut the suggestion where that repetition starts
  const following = after.replace(/^\s+/, '').slice(0, 24)
  if (following.length >= 3) {
    const at = t.indexOf(following.length > 12 ? following.slice(0, 12) : following)
    if (at >= 0) t = t.slice(0, at)
  }
  const tail = after.split('\n')[0].trim()
  if (tail && t.endsWith(tail)) t = t.slice(0, -tail.length)
  return t.replace(/\s+$/, '')
}

const plugin = ViewPlugin.fromClass(
  class {
    timer: number | undefined
    cancel: (() => void) | null = null

    constructor(readonly view: EditorView) {}

    update(u: ViewUpdate) {
      if (u.transactions.some(tr => tr.effects.some(e => e.is(setGhost)))) return
      if (u.docChanged || u.selectionSet) this.abort()
      // only typing (not undo, paste of whole blocks, or AI edits) triggers a new suggestion
      const typed = u.transactions.some(tr => tr.isUserEvent('input.type') || tr.isUserEvent('delete.backward'))
      if (u.docChanged && typed) this.schedule()
    }

    schedule(delay = DEBOUNCE_MS) {
      clearTimeout(this.timer)
      this.timer = window.setTimeout(() => this.request(), delay)
    }

    abort() {
      clearTimeout(this.timer)
      this.cancel?.()
      this.cancel = null
    }

    async request() {
      const view = this.view
      if (!worthSuggesting(view) || !(await featureReady('autocomplete'))) return
      const pos = view.state.selection.main.head
      const doc = view.state.doc
      const prefix = doc.sliceString(Math.max(0, pos - PREFIX_CHARS), pos)
      const suffix = doc.sliceString(pos, Math.min(doc.length, pos + SUFFIX_CHARS))
      const docVersion = view.state.doc
      const job = runAi({ feature: 'autocomplete', fim: { prefix, suffix }, maxTokens: 64, stop: ['\n\n'] })
      this.cancel = job.cancel
      try {
        const r = await job.result
        // discard if anything changed while we waited
        if (view.state.doc !== docVersion || view.state.selection.main.head !== pos) return
        const text = clean(r.text, prefix, suffix)
        if (text) view.dispatch({ effects: setGhost.of({ pos, text }) })
      } catch {
        // cancelled or the model is unavailable: autocomplete stays silent
      } finally {
        if (this.cancel === job.cancel) this.cancel = null
      }
    }

    destroy() {
      this.abort()
    }
  }
)

function accept(view: EditorView) {
  const g = view.state.field(ghostField, false)
  if (!g) return false
  view.dispatch({
    changes: { from: g.pos, insert: g.text },
    selection: { anchor: g.pos + g.text.length },
    userEvent: 'input.complete',
    scrollIntoView: true,
  })
  return true
}

function dismiss(view: EditorView) {
  if (!view.state.field(ghostField, false)) return false
  view.dispatch({ effects: setGhost.of(null) })
  return true
}

/** Ask for a suggestion now (Alt+\). */
function trigger(view: EditorView) {
  view.plugin(plugin)?.schedule(0)
  return true
}

export function aiAutocomplete(): Extension {
  return [
    ghostField,
    plugin,
    // above snippet/indent bindings so Tab takes the suggestion when one is showing
    Prec.highest(keymap.of([
      { key: 'Tab', run: accept },
      { key: 'Escape', run: dismiss },
      { key: 'Alt-\\', run: trigger },
    ])),
  ]
}
