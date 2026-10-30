// Offline spell check for LaTeX: prose is checked by Hunspell in a worker; commands, math, comments,
// verbatim text and arguments Overleaf's grammar marks as non-prose (labels, refs, cites, URLs, paths,
// package names) are skipped. Right-click a misspelling for suggestions or "Add to dictionary".
import { EditorState, Extension, RangeSetBuilder, StateEffect } from '@codemirror/state'
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import type { SyntaxNode } from '@lezer/common'
import { noSpellCheckProp } from '../overleaf/latex-language'

const WORD = /[A-Za-zÀ-ɏ](?:[A-Za-zÀ-ɏ'’]*[A-Za-zÀ-ɏ])?/g
const SKIP_NODES = new Set([
  'Comment', 'EquationEnvironment', 'EquationArrayEnvironment', 'VerbContent', 'VerbatimContent', 'LstInlineContent',
  'LiteralArgContent', 'SpaceDelimitedLiteralArgContent', 'BeginEnv', 'EndEnv', 'OptionalArgument', 'Csname',
])

// ---------- worker ----------

let worker: Worker | null = null
let seq = 0
const pending = new Map<number, (v: { ok: boolean; result?: unknown; error?: string }) => void>()
const known = new Map<string, boolean>() // word -> spelled correctly?
const ignored = new Set<string>()
let ready: Promise<void> | null = null
let enabled = true
let saveLearned: (words: string[]) => void = () => {}
let learned: string[] = []

function call<T>(msg: Record<string, unknown>): Promise<T> {
  const id = ++seq
  return new Promise((resolve, reject) => {
    pending.set(id, r => (r.ok ? resolve(r.result as T) : reject(new Error(r.error))))
    worker!.postMessage({ id, ...msg })
  })
}

/** Start the checker with the user's learned words; `persist` saves them when one is added. */
export function initSpell(learnedWords: string[], persist: (words: string[]) => void) {
  learned = [...learnedWords]
  saveLearned = persist
  worker = new Worker('spell-worker.js', { type: 'module' })
  worker.onmessage = ev => {
    pending.get(ev.data.id)?.(ev.data)
    pending.delete(ev.data.id)
  }
  ready = call<void>({ type: 'init', learned }).catch(e => console.warn('spell check unavailable:', e))
}

// ---------- which text is prose ----------

function checkable(state: EditorState, pos: number) {
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent) {
    if (SKIP_NODES.has(n.name) || n.type.is('$MathContainer')) return false
    const contexts = n.type.prop(noSpellCheckProp)
    if (contexts?.some(ctx => (ctx.length === 1 && ctx[0] === '') || n!.matchContext(ctx))) return false
  }
  return true
}

type Word = { from: number; to: number; text: string }

function wordsIn(view: EditorView): Word[] {
  const out: Word[] = []
  const { state } = view
  for (const { from, to } of view.visibleRanges) {
    const text = state.sliceDoc(from, to)
    for (const m of text.matchAll(WORD)) {
      const start = from + m.index!
      const w = m[0].replace(/['’]$/, '')
      if (w.length < 2) continue
      if (text[m.index! - 1] === '\\') continue // a command name like \textbf
      if (/^[A-Z]{2,}s?$/.test(w)) continue // acronyms (ANOVA, PDFs)
      if (!checkable(state, start)) continue
      out.push({ from: start, to: start + w.length, text: w })
    }
  }
  return out
}

function wordAt(view: EditorView, pos: number): Word | null {
  const line = view.state.doc.lineAt(pos)
  for (const m of line.text.matchAll(WORD)) {
    const from = line.from + m.index!
    const w = m[0].replace(/['’]$/, '')
    if (pos >= from && pos <= from + w.length) return { from, to: from + w.length, text: w }
  }
  return null
}

// ---------- decorations ----------

const refresh = StateEffect.define<null>()
const mark = Decoration.mark({ class: 'cm-spell-error' })

const plugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet = Decoration.none
    timer: number | undefined

    constructor(readonly view: EditorView) {
      this.schedule(50)
    }

    update(u: ViewUpdate) {
      if (u.docChanged) this.decorations = this.decorations.map(u.changes)
      if (u.docChanged || u.viewportChanged || u.transactions.some(t => t.effects.some(e => e.is(refresh)))) this.schedule()
    }

    schedule(delay = 300) {
      clearTimeout(this.timer)
      this.timer = window.setTimeout(() => void this.check(), delay)
    }

    async check() {
      const view = this.view
      if (!enabled || !worker) {
        this.decorations = Decoration.none
        view.dispatch({})
        return
      }
      await ready
      const words = wordsIn(view)
      const unknown = [...new Set(words.map(w => w.text))].filter(w => !known.has(w) && !ignored.has(w))
      if (unknown.length) {
        try {
          const bad = new Set(await call<number[]>({ type: 'spell', words: unknown }))
          unknown.forEach((w, i) => known.set(w, !bad.has(i)))
        } catch {
          return
        }
      }
      const builder = new RangeSetBuilder<Decoration>()
      for (const w of words.sort((a, b) => a.from - b.from)) {
        if (known.get(w.text) === false && !ignored.has(w.text)) builder.add(w.from, w.to, mark)
      }
      this.decorations = builder.finish()
      view.dispatch({}) // repaint with the new decorations
    }

    destroy() {
      clearTimeout(this.timer)
    }
  },
  { decorations: v => v.decorations }
)

// ---------- right-click menu ----------

let menu: HTMLElement | null = null
const closeMenu = () => (menu?.remove(), (menu = null))
document.addEventListener('mousedown', e => menu && !menu.contains(e.target as Node) && closeMenu())

async function showMenu(view: EditorView, word: Word, x: number, y: number) {
  closeMenu()
  menu = document.createElement('div')
  menu.className = 'fb-menu spell-menu'
  menu.style.left = `${x}px`
  menu.style.top = `${y}px`
  const item = (label: string, run: () => void, hint = '') => {
    const b = document.createElement('button')
    b.innerHTML = '<span></span><span class="hint"></span>'
    b.firstElementChild!.textContent = label
    b.lastElementChild!.textContent = hint
    b.onmousedown = e => e.preventDefault()
    b.onclick = () => (closeMenu(), run())
    menu!.appendChild(b)
  }
  document.body.appendChild(menu)
  const loading = Object.assign(document.createElement('div'), { className: 'muted spell-loading', textContent: 'Suggestions…' })
  menu.appendChild(loading)
  const suggestions = await call<string[]>({ type: 'suggest', word: word.text }).catch(() => [])
  loading.remove()
  if (!menu) return
  if (!suggestions.length) menu.appendChild(Object.assign(document.createElement('div'), { className: 'muted spell-loading', textContent: 'No suggestions' }))
  for (const s of suggestions) item(s, () => view.dispatch({ changes: { from: word.from, to: word.to, insert: s }, userEvent: 'input.spell' }))
  menu.appendChild(document.createElement('hr'))
  item('Add to dictionary', () => {
    learned.push(word.text)
    saveLearned([...learned])
    known.set(word.text, true)
    void call({ type: 'add', word: word.text })
    view.dispatch({ effects: refresh.of(null) })
  }, word.text)
  item('Ignore this session', () => {
    ignored.add(word.text)
    view.dispatch({ effects: refresh.of(null) })
  })
  // keep the menu on screen
  const r = menu.getBoundingClientRect()
  if (r.bottom > innerHeight) menu.style.top = `${Math.max(4, y - r.height)}px`
  if (r.right > innerWidth) menu.style.left = `${Math.max(4, innerWidth - r.width - 4)}px`
}

const contextMenu = EditorView.domEventHandlers({
  contextmenu(ev, view) {
    if (!enabled) return false
    const pos = view.posAtCoords({ x: ev.clientX, y: ev.clientY })
    if (pos == null) return false
    const word = wordAt(view, pos)
    if (!word || known.get(word.text) !== false || ignored.has(word.text)) return false
    ev.preventDefault()
    void showMenu(view, word, ev.clientX, ev.clientY)
    return true
  },
})

export function spellCheck(): Extension {
  return [plugin, contextMenu]
}

export function setSpellEnabled(view: EditorView, on: boolean) {
  enabled = on
  view.dispatch({ effects: refresh.of(null) })
}
