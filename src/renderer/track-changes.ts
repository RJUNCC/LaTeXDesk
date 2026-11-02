// Comments and suggested changes (track changes), like Word or Overleaf. While "Suggest" is on, every edit is
// recorded instead of just happening: typed text is highlighted as an insertion, and deleted text stays visible
// (struck through) until someone accepts or rejects it. The file on disk always holds the text with the
// suggestions applied (so it compiles as suggested); the suggestions and comments are kept beside it in
// .texdesk/review.json, with enough surrounding text to find their place again if the file is edited elsewhere.
import { Annotation, EditorState, Extension, StateEffect, StateField, Transaction } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, hoverTooltip } from '@codemirror/view'

export type Reply = { id: string; author: string; date: number; text: string }
export type Comment = {
  id: string
  from: number
  to: number
  /** the commented text when it was saved, and a little on each side, for finding it again */
  quote: string
  before?: string
  after?: string
  author: string
  date: number
  text: string
  replies: Reply[]
  resolved?: boolean
}
export type Change = {
  id: string
  kind: 'insert' | 'delete'
  /** an insertion covers from–to; a deletion sits at `from` (= `to`) and holds the deleted text */
  from: number
  to: number
  text: string
  before?: string
  after?: string
  author: string
  date: number
}
export type FileReview = { comments: Comment[]; changes: Change[] }

const empty: FileReview = { comments: [], changes: [] }

/** Edits made by accepting/rejecting or loading, which must never be recorded as suggestions. */
export const untracked = Annotation.define<boolean>()
const editComments = StateEffect.define<(c: Comment[]) => Comment[]>()
const dropChanges = StateEffect.define<string[]>()

// who is suggesting (null: edits just happen). One switch for the whole app, like Word's Track Changes.
let suggester: string | null = null
export function setSuggesting(author: string | null) {
  suggester = author
}
export const suggesting = () => suggester

const newId = () => crypto.randomUUID().slice(0, 8)

function mapChanges(list: Change[], tr: Transaction): Change[] {
  const out: Change[] = []
  for (const c of list) {
    if (c.kind === 'insert') {
      // text typed right at either edge isn't part of the suggestion unless it's suggested too (then it merges)
      const from = tr.changes.mapPos(c.from, 1)
      const to = tr.changes.mapPos(c.to, -1)
      if (to > from) out.push({ ...c, from, to })
    } else {
      // a deletion stays before text typed where it was (delete "old", type "new" reads ~~old~~new)
      const at = tr.changes.mapPos(c.from, -1)
      out.push({ ...c, from: at, to: at })
    }
  }
  return out
}

function mapComments(list: Comment[], tr: Transaction): Comment[] {
  return list.map(c => {
    const from = tr.changes.mapPos(c.from, 1)
    const to = Math.max(from, tr.changes.mapPos(c.to, -1))
    return from === c.from && to === c.to ? c : { ...c, from, to }
  })
}

/** Turn the edits of one transaction into suggestions by `who`, on top of the existing ones. */
function track(old: Change[], tr: Transaction, who: string): Change[] {
  const now = Date.now()
  const start = tr.startState.doc
  const insertions = old.filter(c => c.kind === 'insert').sort((a, b) => a.from - b.from)
  const deletions = old.filter(c => c.kind === 'delete')
  const merged = new Set<string>()
  const added: Change[] = []
  const undoing = tr.isUserEvent('undo') || tr.isUserEvent('redo')
  tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    const text = inserted.toString()
    // undoing a suggested deletion puts the text back: the suggestion just goes away
    if (undoing && text && toA === fromA) {
      const d = deletions.find(d => !merged.has(d.id) && d.from === fromA && d.text === text)
      if (d) return void merged.add(d.id)
    }
    if (toA > fromA) {
      // deleting suggested (inserted) text just removes it; the rest becomes a suggested deletion, joined with
      // this author's deletions at its edges or inside it (so backspacing letter by letter makes one suggestion)
      const pieces: { at: number; text: string; earlier: boolean }[] = []
      let pos = fromA
      for (const ins of insertions) {
        if (ins.to <= fromA || ins.from >= toA) continue
        if (ins.from > pos) pieces.push({ at: pos, text: start.sliceString(pos, ins.from), earlier: false })
        pos = Math.max(pos, ins.to)
      }
      if (pos < toA) pieces.push({ at: pos, text: start.sliceString(pos, toA), earlier: false })
      for (const d of deletions) {
        if (d.author !== who || merged.has(d.id) || d.from < fromA || d.from > toA) continue
        merged.add(d.id)
        pieces.push({ at: d.from, text: d.text, earlier: true })
      }
      // an earlier deletion sits before the character at its position
      pieces.sort((a, b) => a.at - b.at || Number(b.earlier) - Number(a.earlier))
      const deleted = pieces.map(p => p.text).join('')
      if (deleted) added.push({ id: newId(), kind: 'delete', from: fromB, to: fromB, text: deleted, author: who, date: now })
    }
    if (toB > fromB) added.push({ id: newId(), kind: 'insert', from: fromB, to: toB, text, author: who, date: now })
  })
  const all = [...mapChanges(old.filter(c => !merged.has(c.id)), tr), ...added]
  // neighbouring insertions by the same person are one suggestion
  all.sort((a, b) => a.from - b.from || (a.kind === 'delete' ? -1 : 1))
  const out: Change[] = []
  for (const c of all) {
    const prev = out[out.length - 1]
    if (prev && c.kind === 'insert' && prev.kind === 'insert' && prev.author === c.author && prev.to === c.from) {
      out[out.length - 1] = { ...prev, to: c.to, date: Math.max(prev.date, c.date) }
    } else out.push(c)
  }
  return out
}

export const reviewField = StateField.define<FileReview>({
  create: () => empty,
  update(value, tr) {
    let { comments, changes } = value
    for (const e of tr.effects) {
      if (e.is(editComments)) comments = e.value(comments)
      if (e.is(dropChanges)) changes = changes.filter(c => !e.value.includes(c.id))
    }
    if (tr.docChanged) {
      comments = mapComments(comments, tr)
      const who = suggester && !tr.annotation(untracked) ? suggester : null
      changes = who ? track(changes, tr, who) : mapChanges(changes, tr)
    }
    return comments === value.comments && changes === value.changes ? value : { comments, changes }
  },
  provide: f => EditorView.decorations.from(f, decorations),
})

// ---------- how it looks ----------

/** A steady colour per person. */
export function authorColor(name: string) {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360
  return `hsl(${h} 70% 62%)`
}

class DeletedText extends WidgetType {
  constructor(readonly change: Change) {
    super()
  }
  eq(other: DeletedText) {
    return other.change.id === this.change.id && other.change.text === this.change.text
  }
  toDOM() {
    const el = document.createElement('span')
    el.className = 'tc-del'
    el.dataset.change = this.change.id
    el.style.setProperty('--tc-color', authorColor(this.change.author))
    // long deletions are shortened in the text; the panel and the tooltip show all of it
    const t = this.change.text
    el.textContent = t.length > 120 ? `${t.slice(0, 55)} … ${t.slice(-55)}` : t
    return el
  }
  ignoreEvent() {
    return false
  }
}

function decorations(review: FileReview) {
  const ranges = []
  for (const c of review.comments) {
    if (c.resolved || c.to <= c.from) continue
    ranges.push(Decoration.mark({ class: 'tc-comment', attributes: { 'data-comment': c.id } }).range(c.from, c.to))
  }
  for (const c of review.changes) {
    if (c.kind === 'insert') {
      ranges.push(Decoration.mark({ class: 'tc-ins', attributes: { 'data-change': c.id, style: `--tc-color: ${authorColor(c.author)}` } }).range(c.from, c.to))
    } else {
      ranges.push(Decoration.widget({ widget: new DeletedText(c), side: -1 }).range(c.from))
    }
  }
  return Decoration.set(ranges, true)
}

const when = (t: number) => {
  const mins = Math.round((Date.now() - t) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  if (mins < 60 * 24) return `${Math.round(mins / 60)} h ago`
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}
export { when as timeAgo }

/** Hovering a suggestion shows who made it, with Accept and Reject. */
const changeTooltip = hoverTooltip((view, pos) => {
  const { changes } = view.state.field(reviewField)
  const c = changes.find(c => (c.kind === 'insert' ? pos >= c.from && pos <= c.to : pos === c.from))
  if (!c) return null
  return {
    pos: c.from,
    end: c.to,
    above: true,
    create() {
      const dom = document.createElement('div')
      dom.className = 'tc-tip'
      const head = document.createElement('div')
      head.innerHTML = '<span class="tc-dot"></span><strong></strong> <span class="muted"></span>'
      head.querySelector<HTMLElement>('.tc-dot')!.style.background = authorColor(c.author)
      head.querySelector('strong')!.textContent = c.author
      head.querySelector('.muted')!.textContent = `${c.kind === 'insert' ? 'added text' : 'deleted text'} · ${when(c.date)}`
      const accept = Object.assign(document.createElement('button'), { textContent: '✓ Accept', className: 'primary' })
      const reject = Object.assign(document.createElement('button'), { textContent: '✗ Reject' })
      accept.onclick = () => acceptChanges(view, [c.id])
      reject.onclick = () => rejectChanges(view, [c.id])
      const actions = document.createElement('div')
      actions.className = 'tc-tip-actions'
      actions.append(accept, reject)
      dom.append(head, actions)
      return { dom }
    },
  }
})

const theme = EditorView.baseTheme({
  '.tc-ins': { background: 'color-mix(in srgb, var(--tc-color) 22%, transparent)', borderBottom: '2px solid var(--tc-color)' },
  '.tc-del': { color: 'var(--tc-color)', textDecoration: 'line-through', opacity: '0.85', background: 'color-mix(in srgb, var(--tc-color) 12%, transparent)' },
  '.tc-comment': { background: '#e5c07b33', borderBottom: '2px solid #e5c07b' },
  '.tc-tip': { padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: '6px' },
  '.tc-tip-actions': { display: 'flex', gap: '6px' },
  '.tc-dot': { display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', marginRight: '4px' },
})

export function trackChanges(initial: FileReview = empty): Extension {
  return [reviewField.init(() => initial), changeTooltip, theme]
}

// ---------- actions ----------

export function acceptChanges(view: EditorView, ids: string[]) {
  if (ids.length) view.dispatch({ effects: dropChanges.of(ids), annotations: untracked.of(true) })
}

/** Undo the suggestions: remove suggested insertions, put suggested deletions back. */
export function rejectChanges(view: EditorView, ids: string[]) {
  const picked = view.state.field(reviewField).changes.filter(c => ids.includes(c.id))
  if (!picked.length) return
  const changes = picked.map(c => (c.kind === 'insert' ? { from: c.from, to: c.to, insert: '' } : { from: c.from, insert: c.text }))
  // not undoable on its own: Ctrl+Z would bring the text back without its suggestion
  view.dispatch({ changes, effects: dropChanges.of(ids), annotations: [untracked.of(true), Transaction.addToHistory.of(false)] })
}

export function updateComments(view: EditorView, fn: (c: Comment[]) => Comment[]) {
  view.dispatch({ effects: editComments.of(fn) })
}

export function addComment(view: EditorView, author: string, text: string, range: { from: number; to: number } = view.state.selection.main) {
  const c: Comment = { id: newId(), from: range.from, to: range.to, quote: view.state.sliceDoc(range.from, range.to), author, date: Date.now(), text, replies: [] }
  updateComments(view, list => [...list, c].sort((a, b) => a.from - b.from))
  return c
}

// ---------- saving and loading ----------

const CONTEXT = 40

/** What's saved for a file: positions, plus the text at and around each one. */
export function serialize(state: EditorState): FileReview {
  const { comments, changes } = state.field(reviewField, false) ?? empty
  const doc = state.doc
  const around = (from: number, to: number) => ({ before: doc.sliceString(Math.max(0, from - CONTEXT), from), after: doc.sliceString(to, Math.min(doc.length, to + CONTEXT)) })
  return {
    comments: comments.map(c => ({ ...c, quote: c.to > c.from ? doc.sliceString(c.from, c.to) : c.quote, ...around(c.from, c.to) })),
    changes: changes.map(c => (c.kind === 'insert' ? { ...c, text: doc.sliceString(c.from, c.to), ...around(c.from, c.to) } : { ...c, ...around(c.from, c.from) })),
  }
}

/** Where `text` (with its saved surroundings) is now, preferring the spot nearest where it was. */
function relocate(doc: string, text: string, before = '', after = '', near: number): number | null {
  const at = (from: number) => doc.slice(from, from + text.length) === text
  if (near >= 0 && near + text.length <= doc.length && at(near) && doc.slice(Math.max(0, near - before.length), near) === before) return near
  const candidates: number[] = []
  for (const probe of [before.slice(-12) + text + after.slice(0, 12), text]) {
    if (!probe) continue
    for (let i = doc.indexOf(probe); i >= 0; i = doc.indexOf(probe, i + 1)) {
      candidates.push(probe === text ? i : i + before.slice(-12).length)
      if (candidates.length > 200) break
    }
    if (candidates.length) break
  }
  if (!candidates.length) return null
  return candidates.sort((a, b) => Math.abs(a - near) - Math.abs(b - near))[0]
}

/**
 * Fit saved review data to the file's current text. Anything that can't be found again is dropped (an
 * insertion) or kept at the nearest point (a comment, marked as detached by being empty; a deletion).
 */
export function restore(doc: string, saved: FileReview | undefined): FileReview {
  if (!saved) return empty
  const clamp = (n: number) => Math.max(0, Math.min(doc.length, n))
  const comments: Comment[] = []
  for (const c of saved.comments ?? []) {
    const at = c.quote ? relocate(doc, c.quote, c.before, c.after, c.from) : null
    if (at != null) comments.push({ ...c, from: at, to: at + c.quote.length })
    else comments.push({ ...c, from: clamp(c.from), to: clamp(c.from) })
  }
  const changes: Change[] = []
  for (const c of saved.changes ?? []) {
    if (c.kind === 'insert') {
      const at = relocate(doc, c.text, c.before, c.after, c.from)
      if (at != null) changes.push({ ...c, from: at, to: at + c.text.length })
    } else {
      // a deletion is found by the text that was on either side of it
      const left = c.before ?? ''
      const right = c.after ?? ''
      let at: number | null = doc.slice(Math.max(0, c.from - left.length), c.from) === left && doc.slice(c.from, c.from + right.length) === right ? c.from : null
      if (at == null && (left || right)) {
        const probe = left.slice(-15) + right.slice(0, 15)
        const i = probe ? doc.indexOf(probe) : -1
        if (i >= 0) at = i + left.slice(-15).length
      }
      changes.push({ ...c, from: at ?? clamp(c.from), to: at ?? clamp(c.from) })
    }
  }
  comments.sort((a, b) => a.from - b.from)
  changes.sort((a, b) => a.from - b.from)
  return { comments, changes }
}

export const reviewOf = (state: EditorState): FileReview => state.field(reviewField, false) ?? empty
export const hasReview = (r: FileReview) => r.comments.length > 0 || r.changes.length > 0
