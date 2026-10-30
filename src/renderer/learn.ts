// The Learn view (Learn button, Help → Learn): interactive LaTeX lessons and "How LaTeXDesk works".
// Each lesson has a practice editor and a live PDF. Check compiles the practice document in a private folder
// (the app data "learn" folder, never the user's project) and ticks off the lesson's goals.
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { LanguageSupport, syntaxHighlighting } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { drawSelection, EditorView, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view'
import LatexParser from '../overleaf/latex-log-parser'
import { LaTeXLanguage } from '../overleaf/latex-language'
import { highlightStyle, theme } from './editor-theme'
import { LESSONS, Lesson, PRACTICE_BIB } from './learn-lessons'
import { TOPICS, runTour } from './learn-tour'
import { PdfViewer } from './pdf-viewer'

export type LearnDeps = {
  /** the private practice folder */
  sandbox(): Promise<string>
  readFileOptional(root: string, rel: string): Promise<string | null>
  writeFile(root: string, rel: string, text: string): Promise<void>
  writeBinary(root: string, rel: string, base64: string): Promise<void>
  compile(root: string, file: string): Promise<{ log: string; pdf: Uint8Array | null; missingTex?: boolean }>
  done(): string[]
  setDone(ids: string[]): void
  showPanel(name: string): void
  /** make sure a project is open, so the tour has something to point at */
  ensureProject(): Promise<boolean>
}

let deps: LearnDeps
let root = ''
let lesson: Lesson = LESSONS[0]
let editor: EditorView
let pdf: PdfViewer
let saveTimer = 0
let checking = false
const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(`#learn ${sel}`)!

const bodyOf = (src: string) => {
  const m = /\\begin\{document\}([\s\S]*)\\end\{document\}/.exec(src)
  return (m ? m[1] : src).replace(/(^|[^\\])%.*$/gm, '$1')
}
const fileFor = (l: Lesson) => `lesson-${l.id}.tex`

export function initLearn(d: LearnDeps) {
  deps = d
  const view = document.createElement('div')
  view.id = 'learn'
  view.hidden = true
  view.innerHTML = `
    <div class="learn-top">
      <div class="learn-tabs" role="tablist">
        <button data-track="lessons" class="active">Learn LaTeX</button>
        <button data-track="guide">How LaTeXDesk works</button>
      </div>
      <span class="learn-progress muted"></span>
      <span class="spacer"></span>
      <button class="learn-close" title="Close (Esc)">✕</button>
    </div>
    <div class="learn-lessons">
      <nav class="learn-nav"></nav>
      <section class="learn-text">
        <h2 class="learn-title"></h2>
        <div class="learn-intro"></div>
        <h4>Your goals</h4>
        <ul class="learn-goals"></ul>
        <div class="learn-result"></div>
        <div class="learn-actions">
          <button class="primary learn-check" title="Compile and check (Ctrl+Enter)">Check</button>
          <button class="learn-next">Next lesson →</button>
          <span class="spacer"></span>
          <button class="learn-solution">Show solution</button>
          <button class="learn-reset" title="Start this lesson again">Reset</button>
        </div>
      </section>
      <div class="learn-editor"></div>
      <div class="learn-pdf"><div class="learn-pdf-empty muted">Press <b>Check</b> to see your PDF here.</div><div class="learn-pdf-pages"></div></div>
    </div>
    <div class="learn-guide" hidden>
      <nav class="learn-topics"></nav>
      <section class="learn-topic"></section>
    </div>`
  document.body.append(view)

  editor = new EditorView({
    parent: $('.learn-editor'),
    state: EditorState.create({ doc: '' }),
  })
  // the viewer replaces everything in its container, so it gets one of its own
  pdf = new PdfViewer($('.learn-pdf-pages'))

  view.querySelectorAll<HTMLButtonElement>('.learn-tabs button').forEach(b => (b.onclick = () => showTrack(b.dataset.track as 'lessons' | 'guide')))
  $('.learn-close').onclick = closeLearn
  $('.learn-check').onclick = () => void check()
  $('.learn-next').onclick = () => {
    const i = LESSONS.indexOf(lesson)
    if (i < LESSONS.length - 1) void openLesson(LESSONS[i + 1])
    else showTrack('guide')
  }
  $('.learn-reset').onclick = () => {
    if (confirm(`Start “${lesson.title}” again? Your changes in this lesson will be replaced.`)) setText(lesson.starter)
  }
  $('.learn-solution').onclick = () => {
    if (confirm('Replace your practice text with the model solution?')) setText(lesson.solution)
  }
  view.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !document.querySelector('.tour-card')) closeLearn()
  })
  renderNav()
  renderTopics()
}

function extensions() {
  return [
    lineNumbers(),
    history(),
    drawSelection(),
    highlightActiveLine(),
    closeBrackets(),
    EditorView.lineWrapping,
    new LanguageSupport(LaTeXLanguage),
    syntaxHighlighting(highlightStyle),
    theme,
    keymap.of([{ key: 'Mod-Enter', run: () => (void check(), true) }, { key: 'Mod-s', run: () => (save(), true) }, indentWithTab, ...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap]),
    EditorView.updateListener.of(u => {
      if (!u.docChanged) return
      clearTimeout(saveTimer)
      saveTimer = window.setTimeout(save, 600)
    }),
  ]
}

function setText(text: string) {
  editor.setState(EditorState.create({ doc: text, extensions: extensions() }))
  save()
  renderGoals(null)
  editor.focus()
}

function save() {
  if (root) void deps.writeFile(root, fileFor(lesson), editor.state.doc.toString())
}

export async function openLearn(track: 'lessons' | 'guide' = 'lessons') {
  root ||= await deps.sandbox()
  const view = document.getElementById('learn')!
  // sit just below the top bar
  view.style.top = `${document.getElementById('toolbar')!.offsetHeight}px`
  view.hidden = false
  showTrack(track)
  if (track === 'lessons') {
    // continue with the first lesson not yet done
    const done = new Set(deps.done())
    await openLesson(editor.state.doc.length ? lesson : LESSONS.find(l => !done.has(l.id)) ?? LESSONS[0])
  }
}

export function closeLearn() {
  save()
  document.getElementById('learn')!.hidden = true
}

export const learnOpen = () => !document.getElementById('learn')!.hidden

function showTrack(track: 'lessons' | 'guide') {
  document.querySelectorAll<HTMLButtonElement>('#learn .learn-tabs button').forEach(b => b.classList.toggle('active', b.dataset.track === track))
  $('.learn-lessons').hidden = track !== 'lessons'
  $('.learn-guide').hidden = track !== 'guide'
  if (track === 'lessons' && !editor.state.doc.length && root) void openLesson(lesson)
}

async function openLesson(l: Lesson) {
  // the lesson already open: nothing to reload (reloading could undo an edit made meanwhile)
  if (l === lesson && editor.state.doc.length) return
  save()
  lesson = l
  const saved = await deps.readFileOptional(root, fileFor(l))
  editor.setState(EditorState.create({ doc: saved ?? l.starter, extensions: extensions() }))
  // the practice folder gets whatever this lesson's exercises refer to
  if (l.files?.includes('bib')) await deps.writeFile(root, 'refs.bib', PRACTICE_BIB)
  if (l.files?.includes('image')) await deps.writeBinary(root, 'picture.png', practiceImage())
  $('.learn-title').textContent = `${LESSONS.indexOf(l) + 1}. ${l.title}`
  $('.learn-intro').innerHTML = l.intro
  $('.learn-result').textContent = ''
  pdf.clear()
  $('.learn-pdf-empty').hidden = false
  renderGoals(null)
  renderNav()
  editor.focus()
}

type GoalState = { ok: boolean }[] | null

function renderGoals(results: GoalState, compiled?: { ok: boolean; message: string }) {
  const list = $('.learn-goals')
  const goals = [...lesson.goals.map(g => ({ text: g.text, hint: g.hint })), { text: 'It compiles without errors', hint: compiled?.message ?? 'Press Check to compile.' }]
  list.replaceChildren(
    ...goals.map((g, i) => {
      const li = document.createElement('li')
      const state = i < lesson.goals.length ? results?.[i]?.ok : compiled?.ok
      li.className = state == null ? '' : state ? 'ok' : 'todo'
      li.innerHTML = `<span class="learn-tick">${state ? '✓' : state === false ? '•' : '○'}</span><div><div>${escapeHtml(g.text)}</div>${state === false ? `<div class="learn-hint">${escapeHtml(g.hint)}</div>` : ''}</div>`
      return li
    })
  )
}

async function check() {
  if (checking) return
  checking = true
  const btn = $<HTMLButtonElement>('.learn-check')
  btn.disabled = true
  btn.textContent = 'Checking…'
  // MiKTeX may fetch packages the first time a feature is used, which can take a while
  const slow = window.setTimeout(() => {
    const result = $('.learn-result')
    result.className = 'learn-result'
    result.textContent = 'Still compiling… the first time can take a minute while MiKTeX installs what it needs.'
  }, 8000)
  try {
    const src = editor.state.doc.toString()
    await deps.writeFile(root, fileFor(lesson), src)
    const body = bodyOf(src)
    const results = lesson.goals.map(g => {
      try {
        return { ok: g.test(body, src) }
      } catch {
        return { ok: false }
      }
    })
    const r = await deps.compile(root, fileFor(lesson))
    const errors = r.missingTex ? [] : new LatexParser(r.log, { ignoreDuplicates: true }).parse().errors
    const compiled = r.missingTex
      ? { ok: false, message: 'No TeX installation found: install MiKTeX (Help → Getting Started).' }
      : errors.length
        ? { ok: false, message: `${errors[0].message}${errors[0].line ? ` (line ${errors[0].line})` : ''}` }
        : r.pdf
          ? { ok: true, message: '' }
          : { ok: false, message: 'No PDF was produced.' }
    if (r.pdf) {
      $('.learn-pdf-empty').hidden = true
      await pdf.load(new Uint8Array(r.pdf))
    }
    renderGoals(results, compiled)
    const all = results.every(x => x.ok) && compiled.ok
    const result = $('.learn-result')
    if (all) {
      const done = new Set(deps.done())
      done.add(lesson.id)
      deps.setDone([...done])
      const last = LESSONS.indexOf(lesson) === LESSONS.length - 1
      result.className = 'learn-result ok'
      result.textContent = last ? '🎉 You finished every lesson! Try the guides in “How LaTeXDesk works”.' : '🎉 Well done! On to the next lesson when you’re ready.'
      renderNav()
    } else {
      const left = results.filter(x => !x.ok).length + (compiled.ok ? 0 : 1)
      result.className = 'learn-result'
      result.textContent = `${left} goal${left > 1 ? 's' : ''} to go. The hints show what to try.`
    }
  } finally {
    clearTimeout(slow)
    checking = false
    btn.disabled = false
    btn.textContent = 'Check'
  }
}

function renderNav() {
  const done = new Set(deps.done())
  const nav = $('.learn-nav')
  nav.replaceChildren(
    ...LESSONS.map((l, i) => {
      const b = document.createElement('button')
      b.className = `learn-nav-item${l === lesson ? ' active' : ''}${done.has(l.id) ? ' done' : ''}`
      b.innerHTML = `<span class="learn-nav-mark">${done.has(l.id) ? '✓' : i + 1}</span>${escapeHtml(l.title)}`
      b.onclick = () => void openLesson(l)
      return b
    })
  )
  $('.learn-progress').textContent = `${done.size} of ${LESSONS.length} lessons done`
  $('.learn-next').textContent = LESSONS.indexOf(lesson) === LESSONS.length - 1 ? 'How LaTeXDesk works →' : 'Next lesson →'
}

function renderTopics() {
  const nav = $('.learn-topics')
  const tourBtn = document.createElement('button')
  tourBtn.className = 'primary learn-tour-all'
  tourBtn.textContent = 'Take the full tour'
  tourBtn.onclick = () => void tour(null)
  nav.replaceChildren(
    tourBtn,
    ...TOPICS.map(t => {
      const b = document.createElement('button')
      b.className = 'learn-nav-item'
      b.dataset.topic = t.id
      b.textContent = t.title
      b.onclick = () => showTopic(t.id)
      return b
    })
  )
  showTopic(TOPICS[0].id)
}

function showTopic(id: string) {
  const t = TOPICS.find(x => x.id === id)!
  document.querySelectorAll<HTMLButtonElement>('#learn .learn-topics .learn-nav-item').forEach(b => b.classList.toggle('active', b.dataset.topic === id))
  const sec = $('.learn-topic')
  sec.innerHTML = `<h2>${t.title}</h2>${t.html}${t.tour ? '<button class="primary learn-show-me">Show me</button>' : ''}`
  sec.querySelector<HTMLButtonElement>('.learn-show-me')?.addEventListener('click', () => void tour(t.tour!))
}

/** Close the Learn view and walk through the real window, then come back. */
async function tour(ids: string[] | null) {
  if (!(await deps.ensureProject())) return
  closeLearn()
  runTour(ids, deps.showPanel, () => void openLearn('guide'))
}

/** A small picture for the figures lesson, drawn on the spot. */
function practiceImage() {
  const c = document.createElement('canvas')
  c.width = 600
  c.height = 360
  const g = c.getContext('2d')!
  const grad = g.createLinearGradient(0, 0, 600, 360)
  grad.addColorStop(0, '#1d6fa5')
  grad.addColorStop(1, '#138a07')
  g.fillStyle = grad
  g.fillRect(0, 0, 600, 360)
  g.fillStyle = '#ffffffcc'
  for (let i = 0; i < 12; i++) {
    const x = 40 + i * 45
    const h = 40 + 220 * Math.abs(Math.sin(i / 2))
    g.fillRect(x, 320 - h, 30, h)
  }
  g.fillStyle = '#fff'
  g.font = 'bold 34px sans-serif'
  g.fillText('picture.png', 24, 50)
  return c.toDataURL('image/png').split(',')[1]
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
