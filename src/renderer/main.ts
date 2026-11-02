import { EditorState, Extension, Compartment } from '@codemirror/state'
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  highlightSpecialChars,
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab, toggleComment } from '@codemirror/commands'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from '@codemirror/autocomplete'
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
  HighlightStyle,
  LanguageSupport,
} from '@codemirror/language'
import { linter, lintGutter, Diagnostic, setDiagnostics } from '@codemirror/lint'
import { tags as t } from '@lezer/highlight'
import { LaTeXLanguage } from '../overleaf/latex-language'
import LatexParser, { LatexLogEntry } from '../overleaf/latex-log-parser'
import { latexCompletions, indexProjectText, projectSymbols, setZoteroSource } from './completions'
import { PdfViewer } from './pdf-viewer'
import { highlightStyle, theme } from './editor-theme'
import { FormatToolbar } from './toolbar'
import { FormatContext, toggleCommand } from './format'
import { TEMPLATES, Template } from './templates'
import { initPanels, PanelName, showPanel } from './panels'
import { applyRecommendedDefaults, openAiSettings } from './ai-settings'
import type { AppHost } from './host'
import { reviewChanges } from './diff-review'
import { explainError, initAiPanel } from './ai-panel'
import { aiAutocomplete } from './autocomplete'
import { initTasks } from './tasks'
import { equationPreview, setPreambleMacros } from './equation-preview'
import { openGettingStarted, showAbout } from './getting-started'
import { importDocument } from './import-doc'
import { offerTexSetup } from './tex-setup'
import { checkForUpdates, initUpdates } from './updates'
import { initComments, loadReview, persist as persistReview, refreshComments, reviewExtension, startComment, toggleSuggest } from './comments-panel'
import { acceptChanges, rejectChanges, reviewOf } from './track-changes'
import { exportWord } from './export-word'
import { initLearn, openLearn } from './learn'
import { contentWidth, isVisual, projectImages, setVisual, sourceOnly, visual, visualCapable, visualPhrases } from './visual-mode'
import { imageFrom, imageToLatex, initResearch } from './research-panel'
import { initSpell, setSpellEnabled, spellCheck } from './spell'
import { initHistory } from './history'
import { initReferences, shouldSyncOnCompile } from './references-panel'
import { initLibrary } from './library-panel'
import { initReview } from './review-panel'
import { initProof } from './proof-panel'
import { grammarCheck } from './grammar'
import { ensureInBib, libraryItems, refreshLibrary, syncBeforeCompile } from './zotero-client'

declare global {
  interface Window {
    texdesk: {
      getSettings(): Promise<Settings>
      setSettings(patch: Partial<Settings>): Promise<void>
      chooseProject(): Promise<string | null>
      listFiles(root: string): Promise<{ path: string; editable: boolean }[]>
      reveal(root: string): Promise<void>
      readFile(root: string, rel: string): Promise<string>
      readFileOptional(root: string, rel: string): Promise<string | null>
      exportSubmission(root: string, mainFile: string, zipPath?: string): Promise<unknown>
      deleteAppData(root: string, rel: string): Promise<void>
      writeFile(root: string, rel: string, content: string): Promise<void>
      writeBinary(root: string, rel: string, base64: string): Promise<void>
      importChoose(): Promise<{ name: string; base64: string } | null>
      importCopyImage(rel: string, root: string, destRel: string): Promise<void>
      learnFolder(name: 'practice' | 'tour'): Promise<string>
      appInfo(): Promise<{ name: string; version: string; user: string }>
      compile(root: string, main: string): Promise<{ ok: boolean; log: string; pdf: Uint8Array | null; engine: string; cancelled: boolean; timedOut: boolean; missingTex?: boolean; hint?: string | null }>
      cancelCompile(): Promise<void>
      synctex(root: string, main: string, args: object): Promise<any>
      onMenu(cb: (channel: string) => void): void
    }
  }
}

type Settings = {
  lastProject?: string
  mainFiles?: Record<string, string>
  autoCompile?: boolean
  split?: number
  learnedWords?: string[]
  spellCheck?: boolean
  zoteroSyncOnCompile?: boolean
  /** Code (LaTeX source) or Visual (formatted, like a word processor) for .tex files */
  editorMode?: 'code' | 'visual'
  /** the welcome / Getting Started dialog has been shown once */
  welcomed?: boolean
  /** ids of the Learn lessons completed */
  learnDone?: string[]
  /** which TeX compiles: an installed distribution, the built-in engine, or whichever is available */
  texEngine?: 'auto' | 'system' | 'tectonic'
  /** check GitHub for new versions (on by default) */
  autoUpdate?: boolean
  /** shown on comments and suggested changes */
  authorName?: string
}

const api = window.texdesk
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

let settings: Settings = {}
let root: string | null = null
let mainFile: string | null = null
let currentPath: string | null = null
const states = new Map<string, EditorState>()
const dirty = new Set<string>()
let compiling = false
let compileQueued = false
let logEntries: LatexLogEntry[] = []
let autoSaveTimer: number | undefined

// ---------- editor ----------

const lineWrapping = new Compartment()

// pasting an image (and no text) into the editor offers Screenshot → LaTeX
const screenshotPaste = EditorView.domEventHandlers({
  paste: ev => {
    const file = imageFrom(ev.clipboardData)
    if (!file) return false
    ev.preventDefault()
    void imageToLatex(file)
    return true
  },
})

// Diagnostics from the last compile, filtered to the open file
const compileLinter = linter(view => diagnosticsFor(currentPath, view.state), { delay: 0 })

const visualOn = () => settings.editorMode === 'visual'

/** Switch .tex files between the LaTeX source and the formatted Visual editor (the file itself never changes). */
function setEditorMode(mode: 'code' | 'visual', persist = true) {
  settings.editorMode = mode
  if (currentPath && visualCapable(currentPath) && isVisual(view) !== (mode === 'visual')) view.dispatch(setVisual(mode === 'visual'))
  renderModeSwitch()
  if (persist) void api.setSettings({ editorMode: mode })
}

let texHelpShown = false

const TOUR_SAMPLE = String.raw`\documentclass{article}
\usepackage{amsmath}
\title{A Sample Document}
\author{LaTeXDesk}
\begin{document}
\maketitle

\section{Introduction}
This sample shows what a LaTeX document looks like. Text can be \textbf{bold} or \emph{emphasised}, and maths can sit in a sentence, like $a^2 + b^2 = c^2$, or on its own line:
\[
  \int_0^1 x^2 \, dx = \frac{1}{3}
\]

\section{A list}
\begin{itemize}
  \item Sections are numbered for you.
  \item The PDF updates when you compile.
\end{itemize}

\end{document}
`

function gettingStarted(firstRun = false) {
  openGettingStarted({ mode: visualOn() ? 'visual' : 'code', setMode: m => setEditorMode(m), firstRun, onLearn: () => void openLearn() })
}

function renderModeSwitch() {
  const sw = $('mode-switch')
  sw.hidden = !currentPath || !visualCapable(currentPath)
  for (const b of sw.querySelectorAll<HTMLButtonElement>('button')) b.classList.toggle('active', b.dataset.mode === (visualOn() ? 'visual' : 'code'))
}

function extensions(path: string, doc = ''): Extension[] {
  const isTex = /\.(tex|sty|cls)$/i.test(path)
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    foldGutter(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    lineWrapping.of(EditorView.lineWrapping),
    syntaxHighlighting(highlightStyle),
    theme,
    lintGutter(),
    compileLinter,
    isTex ? [new LanguageSupport(LaTeXLanguage), autocompletion({ override: [latexCompletions] }), screenshotPaste, spellCheck(), grammarCheck()] : [],
    // ghost-text completion and hover previews are for the LaTeX source; Visual mode shows the result itself
    isTex ? (visualCapable(path) ? sourceOnly(visualOn(), [aiAutocomplete(), equationPreview()]) : [aiAutocomplete(), equationPreview()]) : [],
    visualCapable(path) ? [visual(path, visualOn()), projectImages(() => files), contentWidth, visualPhrases] : [],
    // comments and suggested changes (any text file)
    reviewExtension(path, doc),
    keymap.of([
      { key: 'Mod-s', run: () => (save().then(() => maybeCompile(true)), true) },
      { key: 'Mod-Enter', run: () => (compile(), true) },
      { key: 'Mod-/', run: toggleComment },
      { key: 'Mod-b', run: v => toggleCommand(v, 'textbf') },
      { key: 'Mod-i', run: v => toggleCommand(v, 'textit') },
      { key: 'Mod-Alt-m', run: () => (void startComment(), true) },
      indentWithTab,
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
      ...completionKeymap,
    ]),
    EditorView.updateListener.of(update => {
      if (update.docChanged && currentPath) {
        dirty.add(currentPath)
        renderFileList()
        scheduleAutoSave()
      }
      if (update.docChanged || update.selectionSet) {
        renderOutline()
        toolbar.update(update.state)
      }
    }),
  ]
}

const view = new EditorView({
  state: EditorState.create({ doc: '' }),
  parent: $('editor'),
})

// ---------- formatting toolbar ----------

const formatContext: FormatContext = {
  ensurePackage,
  ensurePreamble,
  prompt: (message, initial) => prompt(message, initial),
  projectImages: () => {
    // \includegraphics paths are relative to the main document's folder
    const mainDir = mainFile?.includes('/') ? mainFile.slice(0, mainFile.lastIndexOf('/') + 1) : ''
    return files
      .filter(f => /\.(png|jpe?g|pdf|eps)$/i.test(f.path))
      .map(f => (f.path.startsWith(mainDir) ? f.path.slice(mainDir.length) : f.path))
  },
}
const toolbar = new FormatToolbar($('format-bar'), view, formatContext)

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Add \usepackage{name} to the main document's preamble if it isn't loaded yet. */
function ensurePackage(name: string, options?: string) {
  const loaded = new RegExp(`\\\\(?:usepackage|RequirePackage)\\s*(?:\\[[^\\]]*\\])?\\{[^}]*\\b${escapeRegExp(name)}\\b[^}]*\\}`)
  ensurePreamble(`\\usepackage${options ? `[${options}]` : ''}{${name}}`, loaded)
}

let preambleWrites = Promise.resolve()

/** Current text of a project file: the open editor, an unsaved buffer, or disk. */
async function fileText(path: string) {
  if (path === currentPath) return view.state.doc.toString()
  return states.get(path)?.doc.toString() ?? (await api.readFile(root!, path))
}

const hasDocumentClass = (text: string) => /^[^%\n]*\\documentclass/m.test(text)

/**
 * The document that actually gets compiled: the main file if it has \documentclass, otherwise the
 * project file that \input/\include's it (or, as a last resort, any file with \documentclass).
 */
async function resolveRootDoc(): Promise<string | null> {
  if (!root || !mainFile) return null
  if (hasDocumentClass(await fileText(mainFile))) return mainFile
  const stem = mainFile.replace(/\.tex$/i, '')
  const includesMain = new RegExp(`\\\\(?:input|include|subfile)\\s*\\{\\s*(?:\\./)?${escapeRegExp(stem)}(?:\\.tex)?\\s*\\}`)
  let fallback: string | null = null
  for (const f of files) {
    if (!f.path.endsWith('.tex') || f.path === mainFile) continue
    const text = await fileText(f.path)
    if (!hasDocumentClass(text)) continue
    if (includesMain.test(text)) return f.path
    fallback ??= f.path
  }
  return fallback
}

/** Add a line to the root document's preamble unless `present` already matches it. */
function ensurePreamble(lineToAdd: string, present: RegExp) {
  if (!root || !mainFile) return
  const dir = root
  // queued: preamble edits must not interleave, or one read-modify-write would undo another
  preambleWrites = preambleWrites
    .then(async () => {
      const file = await resolveRootDoc()
      if (!file) {
        setStatus(`Couldn't add ${lineToAdd}: no file in this project has \\documentclass`, 'error')
        return
      }
      await addToPreamble(dir, file, lineToAdd, present)
    })
    .catch(e => setStatus(`Couldn't update the preamble: ${e}`, 'error'))
}

async function addToPreamble(dir: string, file: string, lineToAdd: string, present: RegExp) {
  // returns [position, text] to insert, or null if nothing to do
  const plan = (text: string): [number, string] | null => {
    const end = text.indexOf('\\begin{document}')
    const preamble = end < 0 ? text : text.slice(0, end)
    if (present.test(preamble)) return null
    // after the last \usepackage, or else after \documentclass
    const anchors = [...preamble.matchAll(/^\\(?:usepackage|documentclass)\b.*$/gm)]
    const last = anchors[anchors.length - 1]
    if (!last) return null
    return [last.index! + last[0].length, `\n${lineToAdd}`]
  }

  const announce = () => setStatus(`Added ${lineToAdd} to ${file}`, 'ok')
  if (file === currentPath) {
    const p = plan(view.state.doc.toString())
    if (p) (view.dispatch({ changes: { from: p[0], insert: p[1] } }), announce())
    return
  }
  const state = states.get(file)
  if (state) {
    const p = plan(state.doc.toString())
    if (p) {
      states.set(file, state.update({ changes: { from: p[0], insert: p[1] } }).state)
      dirty.add(file)
      renderFileList()
      announce()
    }
    return
  }
  const text = await api.readFile(dir, file)
  const p = plan(text)
  if (p) {
    await api.writeFile(dir, file, text.slice(0, p[0]) + p[1] + text.slice(p[0]))
    announce()
  }
}

// ---------- project / files ----------

let files: { path: string; editable: boolean }[] = []

async function openProject(dir: string, offerTemplates = true) {
  root = dir
  states.clear()
  dirty.clear()
  // comments and suggestions are attached to files as they open, so read them first
  await loadReview()
  projectSymbols.labels.clear()
  projectSymbols.bibKeys.clear()
  logEntries = []
  pdf.clear()
  document.title = `${dir.split(/[\\/]/).pop()} — LaTeXDesk`
  $('project-name').textContent = dir.split(/[\\/]/).pop() || dir
  await refreshFiles()

  for (const f of files) {
    if (/\.(tex|bib)$/i.test(f.path)) indexProjectText(f.path, await api.readFile(dir, f.path))
  }

  const savedMain = settings.mainFiles?.[dir]
  mainFile = savedMain && files.some(f => f.path === savedMain) ? savedMain : await guessMainFile()
  currentPath = null
  settings.lastProject = dir
  await api.setSettings({ lastProject: dir })
  $('empty').hidden = true
  $('workspace').hidden = false

  if (mainFile) {
    await openFile(mainFile)
    compile()
  } else if (files.find(f => f.editable)) {
    await openFile(files.find(f => f.editable)!.path)
  } else {
    // nothing to edit yet: offer a template straight away
    view.setState(EditorState.create({ doc: '' }))
    $('current-file').textContent = ''
    toolbar.setEnabled(false)
    if (offerTemplates) showTemplates()
  }
  projectListeners.forEach(cb => cb())
}

async function guessMainFile() {
  const tex = files.filter(f => f.path.endsWith('.tex'))
  for (const f of tex) {
    if (/\\documentclass/.test(await api.readFile(root!, f.path))) return f.path
  }
  return tex[0]?.path ?? null
}

async function refreshFiles() {
  files = (await api.listFiles(root!)).sort((a, b) => a.path.localeCompare(b.path))
  renderFileList()
}

function renderFileList() {
  const list = $('file-list')
  const rows: HTMLLIElement[] = []
  const shownDirs = new Set<string>()
  for (const f of files) {
    // emit a folder row the first time each parent directory appears
    const parts = f.path.split('/')
    for (let d = 1; d < parts.length; d++) {
      const dir = parts.slice(0, d).join('/')
      if (shownDirs.has(dir)) continue
      shownDirs.add(dir)
      const li = document.createElement('li')
      li.className = 'folder'
      li.style.paddingLeft = `${12 + (d - 1) * 14}px`
      li.textContent = parts[d - 1]
      rows.push(li)
    }
    rows.push(fileRow(f))
  }
  list.replaceChildren(...rows)
}

function fileRow(f: { path: string; editable: boolean }) {
  const li = document.createElement('li')
  const depth = f.path.split('/').length - 1
  li.style.paddingLeft = `${12 + depth * 14}px`
  li.textContent = f.path.split('/').pop()!
  li.title = f.path
  if (f.path === currentPath) li.classList.add('active')
  if (!f.editable) li.classList.add('binary')
  if (f.path === mainFile) li.classList.add('main')
  if (dirty.has(f.path)) li.classList.add('dirty')
  if (f.editable) li.onclick = () => openFile(f.path)
  return li
}

async function openFile(path: string, line?: number) {
  if (!root) return
  if (currentPath) states.set(currentPath, view.state)
  let state = states.get(path)
  if (!state) {
    const doc = await api.readFile(root, path)
    state = EditorState.create({ doc, extensions: extensions(path, doc) })
  }
  currentPath = path
  view.setState(state)
  // a file opened earlier may still be in the other mode
  if (visualCapable(path) && isVisual(view) !== visualOn()) view.dispatch(setVisual(visualOn()))
  $('current-file').textContent = path
  renderModeSwitch()
  toolbar.setEnabled(/\.(tex|sty|cls)$/i.test(path))
  toolbar.update(view.state)
  renderFileList()
  renderOutline()
  refreshDiagnostics()
  refreshComments()
  if (line) goToLine(line)
  view.focus()
}

function goToLine(line: number) {
  const l = view.state.doc.line(Math.min(Math.max(1, line), view.state.doc.lines))
  view.dispatch({ selection: { anchor: l.from }, effects: EditorView.scrollIntoView(l.from, { y: 'center' }) })
  view.focus()
}

async function save() {
  if (!root) return
  if (currentPath) states.set(currentPath, view.state)
  const toSave = [...dirty]
  for (const path of toSave) {
    const text = states.get(path)!.doc.toString()
    await api.writeFile(root, path, text)
    dirty.delete(path)
    indexProjectText(path, text)
  }
  // comment and suggestion positions match the text just saved
  await persistReview()
  renderFileList()
}

function scheduleAutoSave() {
  clearTimeout(autoSaveTimer)
  autoSaveTimer = window.setTimeout(async () => {
    await save()
    maybeCompile(false)
  }, 1500)
}

async function newFile() {
  if (!root) return
  let name = await prompt('New file name (e.g. chapters/intro.tex)')
  if (!name) return
  name = name.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!/\.[a-z0-9]+$/i.test(name)) name += '.tex'
  // never clobber an existing file; just open it
  if (!files.some(f => f.path === name)) await api.writeFile(root, name, '')
  await refreshFiles()
  await openFile(name)
}

// Electron has no window.prompt, so use a tiny inline dialog
function prompt(message: string, initial = ''): Promise<string | null> {
  const dlg = $<HTMLDialogElement>('prompt')
  const input = $<HTMLInputElement>('prompt-input')
  $('prompt-message').textContent = message
  input.value = initial
  // returnValue survives between openings, and Escape doesn't reset it
  dlg.returnValue = ''
  dlg.showModal()
  input.select()
  return new Promise(resolve => {
    dlg.onclose = () => resolve(dlg.returnValue === 'ok' ? input.value.trim() || null : null)
  })
}

// ---------- templates ----------

function showTemplates() {
  const dlg = $<HTMLDialogElement>('template-dialog')
  $('template-target').textContent = root
    ? `Files will be created in ${root}`
    : 'You will be asked to choose a folder for the new project.'
  // under headings: General, Journals and conferences, University
  const groups = [...new Set(TEMPLATES.map(t => t.group ?? 'General'))]
  $('template-list').replaceChildren(
    ...groups.flatMap(g => [Object.assign(document.createElement('h4'), { className: 'template-group', textContent: g }), ...cards(TEMPLATES.filter(t => (t.group ?? 'General') === g))])
  )
  dlg.showModal()

  function cards(list: Template[]) {
    return list.map(t => {
      const card = document.createElement('button')
      card.type = 'button'
      card.className = 'template-card'
      const title = document.createElement('strong')
      title.textContent = t.name
      const desc = document.createElement('span')
      desc.textContent = t.description
      const fileList = document.createElement('code')
      fileList.textContent = Object.keys(t.files).join(', ')
      card.append(title, desc, fileList)
      card.onclick = async () => {
        dlg.close()
        await createFromTemplate(t)
      }
      return card
    })
  }
}

async function createFromTemplate(t: Template) {
  if (!root) {
    const dir = await api.chooseProject()
    if (!dir) return
    await openProject(dir, false)
  }
  await save()
  const existing = Object.keys(t.files).filter(p => files.some(f => f.path === p))
  if (existing.length && !confirm(`These files already exist and will be replaced:\n\n${existing.join('\n')}\n\nContinue?`)) {
    return
  }
  for (const [path, content] of Object.entries(t.files)) {
    await api.writeFile(root!, path, content)
    states.delete(path)
    dirty.delete(path)
    indexProjectText(path, content)
  }
  await refreshFiles()
  mainFile = t.main
  settings.mainFiles = { ...settings.mainFiles, [root!]: t.main }
  await api.setSettings({ mainFiles: settings.mainFiles })
  currentPath = null
  await openFile(t.main)
  compile()
}

// ---------- outline ----------

const SECTION_LEVELS: Record<string, number> = {
  part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5,
}

function renderOutline() {
  const list = $('outline')
  if (!currentPath?.endsWith('.tex')) return list.replaceChildren()
  const doc = view.state.doc
  const cursorLine = doc.lineAt(view.state.selection.main.head).number
  const items: { level: number; title: string; line: number }[] = []
  for (let i = 1; i <= doc.lines; i++) {
    const m = doc.line(i).text.match(/^\s*\\(part|chapter|section|subsection|subsubsection|paragraph)\*?\s*(?:\[[^\]]*\])?\{((?:[^{}]|\{[^{}]*\})*)\}/)
    if (m) items.push({ level: SECTION_LEVELS[m[1]], title: m[2], line: i })
  }
  const minLevel = Math.min(...items.map(i => i.level))
  const current = [...items].reverse().find(i => i.line <= cursorLine)
  list.replaceChildren(
    ...items.map(item => {
      const li = document.createElement('li')
      li.textContent = item.title
      li.style.paddingLeft = `${12 + (item.level - minLevel) * 14}px`
      if (item === current) li.classList.add('active')
      li.onclick = () => goToLine(item.line)
      return li
    })
  )
}

// ---------- compile ----------

const pdf = new PdfViewer($('pdf'))
pdf.onScaleChange = s => ($('zoom-level').textContent = `${Math.round(s * 100)}%`)
// the file last handed to TeX (the main file, or the document that \input's it)
let compiledRoot: string | null = null

pdf.onDoubleClick = async (page, x, y) => {
  const target = compiledRoot ?? mainFile
  if (!root || !target) return
  const loc = await api.synctex(root, target, { direction: 'reverse', page, x, y })
  if (loc && files.some(f => f.path === loc.file)) openFile(loc.file, loc.line)
}

function maybeCompile(explicit: boolean) {
  if (explicit || settings.autoCompile) compile()
}

async function compile() {
  if (!root) return
  if (!mainFile) {
    setStatus('No main document — open a .tex file and use Build → Set as Main', 'error')
    return
  }
  if (compiling) {
    compileQueued = true
    return
  }
  compiling = true
  const btn = $('compile-btn')
  btn.classList.add('busy')
  btn.lastChild!.textContent = 'Stop'
  btn.title = 'Stop compiling'
  setStatus('Compiling…')
  // MiKTeX and the built-in engine download missing packages on first use, which can take minutes
  const slowTimer = window.setTimeout(
    () => setStatus('Still compiling… LaTeX packages this document needs are being downloaded (first use only)', 'warn'),
    12000
  )
  try {
    await save()
    // pull fixes made in Zotero into the cited entries (quiet, at most ~3s, skipped if Zotero isn't running)
    if (shouldSyncOnCompile()) {
      await syncBeforeCompile(host)
      await save()
    }
    const target = await resolveRootDoc()
    if (!target) {
      compileQueued = false
      return setStatus(`${mainFile} has no \\documentclass and no other file includes it, so there is nothing to compile`, 'error')
    }
    compiledRoot = target
    const started = performance.now()
    const result = await api.compile(root, target)
    if (result.missingTex) {
      compileQueued = false
      setStatus('No TeX engine yet: set one up to make PDFs (Help → Getting Started).', 'error')
      // offer once per session; after that the status line is enough
      if (!texHelpShown) (texHelpShown = true), void offerTexSetup(() => void compile())
      return
    }
    if (result.cancelled) {
      compileQueued = false
      if (!result.timedOut) return setStatus('Compile stopped', 'warn')
      // show what TeX got through before it stalled; the last error is usually the culprit
      logEntries = new LatexParser(result.log, { ignoreDuplicates: true }).parse().all
      renderLogs(result.log)
      toggleLogs(true)
      return setStatus('Compile timed out after 3 minutes (TeX may be stuck in a loop) · see logs', 'error')
    }
    const parsed = new LatexParser(result.log, { ignoreDuplicates: true }).parse()
    logEntries = parsed.all
    renderLogs(result.log)
    refreshDiagnostics()
    if (result.pdf) await pdf.load(new Uint8Array(result.pdf))
    const secs = ((performance.now() - started) / 1000).toFixed(1)
    const errs = parsed.errors.length
    const warns = parsed.warnings.length + parsed.typesetting.length
    if (result.hint && (errs || !result.pdf)) setStatus(result.hint, 'error')
    else if (errs) setStatus(`${errs} error${errs > 1 ? 's' : ''}, ${warns} warnings · ${result.engine} · ${secs}s`, 'error')
    else if (!result.pdf) setStatus(`Compile failed · see logs`, 'error')
    else setStatus(`Compiled · ${warns} warnings · ${result.engine} · ${secs}s`, warns ? 'warn' : 'ok')
    $('log-count').textContent = String(errs || warns || '')
    $('log-count').className = errs ? 'badge error' : warns ? 'badge warn' : 'badge'
    const ok = !!result.pdf && !errs
    compiledListeners.forEach(cb => cb(ok))
  } catch (e) {
    setStatus(`Compile failed: ${e}`, 'error')
  } finally {
    clearTimeout(slowTimer)
    compiling = false
    btn.classList.remove('busy')
    btn.lastChild!.textContent = 'Recompile'
    btn.title = 'Recompile (Ctrl+Enter)'
    if (compileQueued) {
      compileQueued = false
      compile()
    }
  }
}

function setStatus(text: string, kind: 'ok' | 'warn' | 'error' | '' = '') {
  const el = $('status')
  el.textContent = text
  el.className = kind
  if (kind === 'ok' || kind === 'error') {
    // restart the flash animation even if the class was already there
    void el.offsetWidth
    el.classList.add('flash')
  }
}

/** Map a path as printed in the TeX log ("./chapters/intro.tex") to a project path. */
function logFileToProject(file: string | undefined) {
  const base = compiledRoot ?? mainFile
  if (!file || !root || !base) return base
  // TeX prints paths relative to the compiled document's folder
  const mainDir = base.includes('/') ? base.slice(0, base.lastIndexOf('/') + 1) : ''
  let p = file.replace(/\\/g, '/').replace(/^\.\//, '')
  const rootNorm = root.replace(/\\/g, '/') + '/'
  if (p.toLowerCase().startsWith(rootNorm.toLowerCase())) return p.slice(rootNorm.length)
  if (/^[a-z]:\//i.test(p) || p.startsWith('/')) return null // a system package file
  return mainDir + p
}

function diagnosticsFor(path: string | null, state: EditorState): Diagnostic[] {
  if (!path) return []
  const out: Diagnostic[] = []
  for (const e of logEntries) {
    if (logFileToProject(e.file) !== path || !e.line) continue
    const lineNo = Math.min(Number(e.line), state.doc.lines)
    if (!lineNo) continue
    const line = state.doc.line(lineNo)
    out.push({
      from: line.from,
      to: line.to,
      severity: e.level === 'error' ? 'error' : e.level === 'warning' ? 'warning' : 'info',
      message: e.message + (e.content ? `\n${e.content.trim()}` : ''),
    })
  }
  // AI notes (proofreading, flow, fact check…), found by their text so they track edits
  const text = state.doc.toString()
  for (const [source, items] of aiDiagnostics.get(path) ?? []) {
    for (const d of items) {
      const at = d.find ? text.indexOf(d.find) : -1
      if (at >= 0) out.push({ from: at, to: at + d.find.length, severity: d.severity ?? 'info', source, message: d.message })
    }
  }
  return out
}

type AiNote = { find: string; message: string; severity?: 'info' | 'warning' | 'error' }
// per file, per producer ("AI", "Flow", "Fact check"…) so one feature's run doesn't wipe another's notes
const aiDiagnostics = new Map<string, Map<string, AiNote[]>>()

function refreshDiagnostics() {
  view.dispatch(setDiagnostics(view.state, diagnosticsFor(currentPath, view.state)))
}

function renderLogs(raw: string) {
  const list = $('log-entries')
  const order = { error: 0, warning: 1, typesetting: 2 }
  const sorted = [...logEntries].sort((a, b) => order[a.level] - order[b.level])
  list.replaceChildren(
    ...sorted.map(e => {
      const div = document.createElement('div')
      div.className = `log-entry ${e.level}`
      const file = logFileToProject(e.file)
      const head = document.createElement('div')
      head.className = 'log-head'
      head.textContent = `${e.message}`
      const loc = document.createElement('span')
      loc.className = 'log-loc'
      loc.textContent = file ? `${file}${e.line ? `:${e.line}` : ''}` : ''
      head.appendChild(loc)
      div.appendChild(head)
      if (e.content) {
        const pre = document.createElement('pre')
        pre.textContent = e.content.trim()
        div.appendChild(pre)
      }
      if (file && files.some(f => f.path === file)) {
        div.onclick = () => openFile(file, e.line ? Number(e.line) : undefined)
      }
      if (e.level === 'error') {
        const fix = document.createElement('button')
        fix.className = 'log-fix'
        fix.textContent = '✦ Explain & fix'
        fix.title = 'Ask the AI what this error means and propose a fix you can review'
        fix.onclick = ev => {
          ev.stopPropagation()
          explainError(e, file)
        }
        div.appendChild(fix)
      }
      return div
    })
  )
  $('raw-log').textContent = raw
}

async function syncForward() {
  const target = compiledRoot ?? mainFile
  if (!root || !target || !currentPath) return
  await save()
  const head = view.state.selection.main.head
  const line = view.state.doc.lineAt(head)
  const res = await api.synctex(root, target, {
    direction: 'forward',
    file: currentPath,
    line: line.number,
    column: head - line.from,
  })
  if (res) pdf.highlight(res.page, res.h, res.v, res.W, res.H)
  else setStatus('No PDF location for this line (recompile first?)', 'warn')
}

// ---------- layout & wiring ----------

function toggleLogs(force?: boolean) {
  const panel = $('logs')
  panel.hidden = force === undefined ? !panel.hidden : !force
}

function initSplitter() {
  const splitter = $('splitter')
  const editorPane = $('editor-pane')
  // settings.split is the editor's share (%) of the space beside the file sidebar. It's applied in pixels:
  // a % flex-basis would be a share of the whole row (sidebar included), putting the divider off the mouse.
  const available = () => $('workspace').clientWidth - $('sidebar').offsetWidth - splitter.offsetWidth
  const apply = () => {
    if (available() > 0) editorPane.style.flexBasis = `${Math.round((available() * (settings.split ?? 50)) / 100)}px`
  }
  // also when the window is resized, or the workspace first appears
  new ResizeObserver(apply).observe($('workspace'))
  splitter.addEventListener('pointerdown', ev => {
    ev.preventDefault()
    splitter.setPointerCapture(ev.pointerId)
    // where on the divider it was grabbed, so it doesn't jump by that much
    const grab = ev.clientX - splitter.getBoundingClientRect().left
    document.body.classList.add('resizing')
    const move = (e: PointerEvent) => {
      const width = e.clientX - grab - editorPane.getBoundingClientRect().left
      settings.split = Math.min(80, Math.max(20, (width / available()) * 100))
      apply()
    }
    const up = () => {
      splitter.removeEventListener('pointermove', move)
      document.body.classList.remove('resizing')
      api.setSettings({ split: settings.split })
    }
    splitter.addEventListener('pointermove', move)
    splitter.addEventListener('lostpointercapture', up, { once: true })
  })
}

/** File → Import Document: a Word / Google Docs / LibreOffice / Markdown / HTML file becomes a new .tex file. */
async function importDoc() {
  const picked = await api.importChoose()
  if (!picked) return
  if (!root) {
    // no project yet: the imported document needs a folder to live in
    setStatus('Choose a folder to keep the imported document in')
    const dir = await api.chooseProject()
    if (!dir) return setStatus('')
    await openProject(dir, false)
    if (!root) return
  }
  const stem = picked.name.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'imported'
  let name = `${stem}.tex`
  for (let n = 2; files.some(f => f.path === name); n++) name = `${stem}-${n}.tex`
  setStatus(`Importing ${picked.name}…`)
  try {
    const bytes = Uint8Array.from(atob(picked.base64), c => c.charCodeAt(0))
    const result = await importDocument(picked.name, bytes, `figures/${name.replace(/\.tex$/, '')}`)
    for (const img of result.images) await api.writeBinary(root, img.path, img.base64)
    for (const img of result.linked)
      await api.importCopyImage(img.src, root, img.path).catch(() => result.warnings.push(`Copy ${img.src} into the project as ${img.path} so its figure shows.`))
    await api.writeFile(root, name, result.tex)
    await refreshFiles()
    // into a project with no document yet, the import becomes the main document and is compiled
    const keepMain = !!mainFile && mainFile !== name && files.some(f => f.path === mainFile)
    if (!keepMain) {
      mainFile = name
      settings.mainFiles = { ...settings.mainFiles, [root]: name }
      await api.setSettings({ mainFiles: settings.mainFiles })
    }
    await openFile(name)
    const notes = [keepMain ? 'To compile it, use Build → Set Current File as Main Document.' : '', ...result.warnings].filter(Boolean).join(' ')
    setStatus(`Imported ${picked.name} as ${name}.${notes ? ' ' + notes : ''}`, result.warnings.length ? 'warn' : 'ok')
    if (!keepMain) compile()
  } catch (e) {
    setStatus(`Couldn't import ${picked.name}: ${(e as Error).message}`, 'error')
  }
}

async function chooseAndOpen() {
  const dir = await api.chooseProject()
  if (dir) openProject(dir)
}

async function setMain() {
  if (!root || !currentPath?.endsWith('.tex')) return
  let chosen = currentPath
  // a chapter file can't be compiled on its own; offer the document that includes it
  if (!hasDocumentClass(view.state.doc.toString())) {
    const previous = mainFile
    mainFile = currentPath
    const rootDoc = await resolveRootDoc()
    mainFile = previous
    const msg = rootDoc
      ? `${currentPath} has no \\documentclass, so it can't be compiled on its own.\n\nUse ${rootDoc} (which includes it) as the main document instead?`
      : `${currentPath} has no \\documentclass, so it can't be compiled on its own, and no other file includes it.\n\nSet it as the main document anyway?`
    if (rootDoc && confirm(msg)) chosen = rootDoc
    else if (!rootDoc && !confirm(msg)) return
  }
  mainFile = chosen
  settings.mainFiles = { ...settings.mainFiles, [root]: chosen }
  await api.setSettings({ mainFiles: settings.mainFiles })
  renderFileList()
  compile()
}

api.onMenu(channel => {
  switch (channel) {
    case 'open-folder': return chooseAndOpen()
    case 'new-file': return newFile()
    case 'templates': return showTemplates()
    case 'save': return save()
    case 'compile': return compile()
    case 'set-main': return setMain()
    case 'sync-forward': return syncForward()
    case 'toggle-logs': return toggleLogs()
    case 'export': return void exportForSubmission()
    case 'export-word': return void exportToWord()
    case 'getting-started': return gettingStarted()
    case 'learn': return void openLearn()
    case 'import': return void importDoc()
    case 'about': return void showAbout()
    case 'check-updates': return void checkForUpdates()
    case 'add-comment': return void startComment()
    case 'toggle-suggest': return void toggleSuggest()
    case 'accept-all': return acceptChanges(view, reviewOf(view.state).changes.map(c => c.id))
    case 'reject-all': return rejectChanges(view, reviewOf(view.state).changes.map(c => c.id))
    case 'show-comments': return showPanel('comments')
    case 'toggle-visual': return setEditorMode(visualOn() ? 'code' : 'visual')
    case 'settings': return openAiSettings()
    case 'toggle-spell': {
      settings.spellCheck = settings.spellCheck === false
      setSpellEnabled(view, settings.spellCheck)
      setStatus(`Spell check ${settings.spellCheck ? 'on' : 'off'}`, 'ok')
      return api.setSettings({ spellCheck: settings.spellCheck })
    }
    case 'reveal': return root && api.reveal(root)
  }
})

$('compile-btn').onclick = () => (compiling ? api.cancelCompile() : compile())
$('open-btn').onclick = $('empty-open').onclick = () => chooseAndOpen()
$('new-file-btn').onclick = () => newFile()
$('templates-btn').onclick = $('empty-template').onclick = () => showTemplates()
$('empty-import').onclick = () => void importDoc()
$('logs-btn').onclick = () => toggleLogs()
$('logs-close').onclick = () => toggleLogs(false)
$('sync-btn').onclick = () => syncForward()
$('zoom-in').onclick = () => pdf.zoom(1.15)
$('zoom-out').onclick = () => pdf.zoom(1 / 1.15)
$('zoom-fit').onclick = () => pdf.fit()
$('raw-toggle').onclick = () => ($('raw-log').hidden = !$('raw-log').hidden)
const autoBox = $<HTMLInputElement>('auto-compile')
autoBox.onchange = () => {
  settings.autoCompile = autoBox.checked
  api.setSettings({ autoCompile: autoBox.checked })
}

window.addEventListener('beforeunload', () => {
  if (dirty.size) save()
})

// ---------- feature host (AI, tasks, research, history plug in through this) ----------

const compiledListeners: ((ok: boolean) => void)[] = []
const projectListeners: (() => void)[] = []

/** Replace a file's text: through the editor when it's open (undoable), else its buffer, else disk. */
async function applyFileText(path: string, text: string) {
  if (!root) return
  // narrow the change to the differing middle so the cursor, undo history, comments and suggestions stay sensible
  const narrowed = (old: string) => {
    let start = 0
    while (start < old.length && start < text.length && old[start] === text[start]) start++
    let endOld = old.length
    let endNew = text.length
    while (endOld > start && endNew > start && old[endOld - 1] === text[endNew - 1]) endOld--, endNew--
    return { from: start, to: endOld, insert: text.slice(start, endNew) }
  }
  if (path === currentPath) {
    view.dispatch({ changes: narrowed(view.state.doc.toString()), userEvent: 'input.ai', scrollIntoView: true })
    return
  }
  const state = states.get(path)
  if (state) {
    states.set(path, state.update({ changes: narrowed(state.doc.toString()), userEvent: 'input.ai' }).state)
    dirty.add(path)
    await save()
  } else {
    await api.writeFile(root, path, text)
  }
  if (!files.some(f => f.path === path)) await refreshFiles()
  indexProjectText(path, text)
  renderFileList()
}

const host: AppHost = {
  view,
  format: formatContext,
  root: () => root,
  currentPath: () => currentPath,
  mainFile: () => mainFile,
  files: () => files,
  refreshFiles,
  openFile,
  save,
  compile,
  setStatus,
  logEntries: () => logEntries,
  logFileToProject,
  fileText,
  applyFileText,
  fileExists: path => files.some(f => f.path === path),
  onCompiled: cb => compiledListeners.push(cb),
  onProjectOpened: cb => projectListeners.push(cb),
  setAiDiagnostics: (path, items, source = 'AI') => {
    if (!aiDiagnostics.has(path)) aiDiagnostics.set(path, new Map())
    aiDiagnostics.get(path)!.set(source, items)
    if (path === currentPath) refreshDiagnostics()
  },
  readProjectFile: rel => (root ? api.readFileOptional(root, rel) : Promise.resolve(null)),
  writeProjectFile: async (rel, text) => {
    if (root) await api.writeFile(root, rel, text)
  },
  deleteAppData: async rel => {
    if (root) await api.deleteAppData(root, rel)
  },
}
type ExportReport = { zipPath: string; files: string[]; bytes: number; warnings: string[]; compiled: boolean; errors: string[] }

/** File → Export for Submission: compile first (for a fresh .bbl), zip, and report what happened. */
async function exportForSubmission(zipPath?: string): Promise<ExportReport | null> {
  if (!root) return null
  await save()
  await compile()
  const target = (await resolveRootDoc()) ?? mainFile
  if (!target) return null
  setStatus('Building submission zip…')
  const report: ExportReport | null = (await api.exportSubmission(root, target, zipPath)) as ExportReport | null
  if (!report) return null
  const dlg = document.createElement('dialog')
  dlg.className = 'wide export-report'
  dlg.innerHTML = `<h3></h3><p class="muted"></p><ul class="ex-files"></ul><div class="ex-warn"></div><menu><button class="primary">OK</button></menu>`
  dlg.querySelector('h3')!.textContent = report.compiled ? '✓ Submission zip ready, and it compiles on its own' : '⚠ Zip written, but it did not compile cleanly on its own'
  dlg.querySelector('p')!.textContent = `${report.zipPath} · ${report.files.length} files · ${(report.bytes / 1024).toFixed(0)} KB`
  dlg.querySelector('.ex-files')!.replaceChildren(...report.files.map(f => Object.assign(document.createElement('li'), { textContent: f })))
  dlg.querySelector('.ex-warn')!.replaceChildren(
    ...[...report.warnings, ...report.errors.map(e => `Compile error: ${e}`)].map(w => Object.assign(document.createElement('div'), { className: 'dr-problem', textContent: `⚠ ${w}` }))
  )
  dlg.querySelector('button')!.onclick = () => (dlg.close(), dlg.remove())
  document.body.appendChild(dlg)
  dlg.showModal()
  setStatus(report.compiled ? 'Submission zip exported' : 'Submission zip exported with problems', report.compiled ? 'ok' : 'warn')
  return report
}
;(window as unknown as { __texdeskExport: unknown }).__texdeskExport = exportForSubmission

/** File → Export to Word, for the document that gets compiled. */
async function exportToWord(savePath?: string) {
  const target = (await resolveRootDoc()) ?? mainFile
  if (!root || !target) return null
  try {
    return await exportWord(host, target, savePath)
  } catch (e) {
    setStatus(`Couldn't export to Word: ${(e as Error).message}`, 'error')
    return null
  }
}
// UI-test hook
;(window as unknown as { __texdeskExportWord: unknown }).__texdeskExportWord = exportToWord

/** Give the equation preview the root document's \newcommand macros. */
async function refreshMacros() {
  const rootDoc = await resolveRootDoc().catch(() => null)
  if (!rootDoc) return
  const text = await fileText(rootDoc)
  const end = text.indexOf('\\begin{document}')
  setPreambleMacros(end < 0 ? text : text.slice(0, end))
}
compiledListeners.push(() => void refreshMacros())
projectListeners.push(() => void refreshMacros())

// UI-test hook: open the review dialog for a change to the current file, without needing an AI model
;(window as unknown as { __texdeskReview: unknown }).__texdeskReview = (before: string, after: string) =>
  reviewChanges('Review changes', [{ file: currentPath!, before, after }], host)

;(async () => {
  settings = await api.getSettings()
  autoBox.checked = settings.autoCompile ?? true
  settings.autoCompile = autoBox.checked
  initSplitter()
  initPanels()
  initUpdates(save)
  initAiPanel(host)
  initTasks(host)
  initResearch(host)
  initHistory(host)
  initReferences(host, { syncOnCompile: settings.zoteroSyncOnCompile !== false, persist: on => api.setSettings({ zoteroSyncOnCompile: on }) })
  initLibrary(host)
  initReview(host)
  initProof(host)
  initComments(host, {
    stateOf: p => (p === currentPath ? view.state : states.get(p)),
    // the name in Settings, else the Windows user name
    author: async () => (await api.getSettings()).authorName?.trim() || (await api.appInfo()).user || 'Me',
  })
  $('comment-btn').onclick = () => void startComment()
  $('suggest-btn').onclick = () => void toggleSuggest()
  initLearn({
    sandbox: () => api.learnFolder('practice'),
    readFileOptional: (dir, rel) => api.readFileOptional(dir, rel),
    writeFile: (dir, rel, text) => api.writeFile(dir, rel, text),
    writeBinary: (dir, rel, b64) => api.writeBinary(dir, rel, b64),
    compile: (dir, file) => api.compile(dir, file),
    done: () => settings.learnDone ?? [],
    setDone: ids => {
      settings.learnDone = ids
      void api.setSettings({ learnDone: ids })
    },
    showPanel: name => showPanel(name as PanelName),
    ensureProject: async () => {
      if (root) return true
      // no project yet: the tour shows a small sample document
      const dir = await api.learnFolder('tour')
      if (!(await api.readFileOptional(dir, 'main.tex'))) await api.writeFile(dir, 'main.tex', TOUR_SAMPLE)
      await openProject(dir, false)
      return !!root
    },
  })
  $('learn-btn').onclick = () => void openLearn()
  setZoteroSource(libraryItems, key => void ensureInBib(host, [key]).then(added => added.length && setStatus(`Added ${key} to the bibliography from Zotero`, 'ok')))
  refreshLibrary().catch(() => {})
  initSpell(settings.learnedWords ?? [], words => api.setSettings({ learnedWords: words }))
  if (settings.spellCheck === false) setSpellEnabled(view, false)
  $('ai-settings-btn').onclick = () => openAiSettings()
  for (const b of $('mode-switch').querySelectorAll<HTMLButtonElement>('button')) b.onclick = () => setEditorMode(b.dataset.mode as 'code' | 'visual')
  // point unconfigured AI features at installed local models (free, private) without blocking startup
  applyRecommendedDefaults().catch(() => {})
  if (settings.lastProject) {
    try {
      await openProject(settings.lastProject)
    } catch {
      $('empty').hidden = false
    }
  } else if (!settings.welcomed) {
    // first launch: choose Visual or Code, and see what this computer still needs
    settings.welcomed = true
    void api.setSettings({ welcomed: true })
    gettingStarted(true)
  }
})()
