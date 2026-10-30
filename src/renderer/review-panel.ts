// The Review tab: one "Analyze" run (grammar → flow → claims → fact check → argument → bias), each step
// incremental and saved as it goes, shown as four views: Writing · Fact check · Argument · Bias.
import { EditorState } from '@codemirror/state'
import { LanguageSupport } from '@codemirror/language'
import { LaTeXLanguage } from '../overleaf/latex-language'
import { extractJson, featureReady, runAi } from './ai-client'
import { applyEdits } from './ai-panel'
import { ArgIssue, analyseArgument } from './argument'
import { Matrix, ROWS, biasMatrix } from './bias'
import { factCheck, needsCheck, readable } from './factcheck'
import { GrammarIssue, checkDocument, grammarAvailable, lt, refreshGrammar } from './grammar'
import type { AppHost } from './host'
import { Claim, FlowIssue, Graph, Job, allClaims, loadGraph, locate, projectParagraphs, saveGraph, updateClaims } from './knowledge'
import { panelEl, setBadge, whenShown } from './panels'
import { plainText } from './prose'
import { citeFromZotero } from './zotero-client'

type View = 'writing' | 'facts' | 'argument' | 'bias'

let host: AppHost
let graph: Graph | null = null
let job: Job | null = null
let view: View = 'writing'
let grammar: (GrammarIssue & { file: string })[] = []
let argIssues: ArgIssue[] = []
let matrix: Matrix | null = null
let selectedCell: { section: string; row: string } | null = null
let lastRun = ''

const $ = <T extends HTMLElement>(sel: string) => panelEl('review').querySelector<T>(sel)!
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = '') => Object.assign(document.createElement(tag), { className: cls, textContent: text })

export function initReview(h: AppHost) {
  host = h
  panelEl('review').innerHTML = `
    <div class="pane-title rv-bar">
      <button class="primary rv-analyze">Analyze</button>
      <span class="rv-progress muted"></span>
    </div>
    <div class="rv-scores"></div>
    <nav class="rv-views">
      <button data-view="writing" class="active">Writing</button>
      <button data-view="facts">Fact check</button>
      <button data-view="argument">Argument</button>
      <button data-view="bias">Bias</button>
    </nav>
    <div class="rv-body"></div>`
  $('.rv-analyze').onclick = () => (job ? stop() : void analyze())
  for (const b of panelEl('review').querySelectorAll<HTMLButtonElement>('.rv-views button'))
    b.onclick = () => {
      view = b.dataset.view as View
      panelEl('review').querySelectorAll('.rv-views button').forEach(x => x.classList.toggle('active', x === b))
      render()
    }
  host.onProjectOpened(async () => {
    graph = await loadGraph(host)
    grammar = []
    argIssues = []
    matrix = null
    render()
  })
  whenShown('review', render)
  lt.onInstallProgress(p => ($('.rv-progress').textContent = p.stage === 'download' ? `Downloading LanguageTool… ${Math.round((p.fraction ?? 0) * 100)}%` : 'Unpacking LanguageTool…'))
}

function progress(msg: string) {
  $('.rv-progress').textContent = msg
}

function stop() {
  if (!job) return
  job.stopped = true
  job.cancel?.()
}

/** Open a file and select a piece of its text. */
async function jumpTo(file: string, text: string) {
  await host.openFile(file)
  const doc = host.view.state.doc.toString()
  const at = doc.indexOf(text)
  if (at < 0) return
  host.view.dispatch({ selection: { anchor: at, head: at + text.length }, scrollIntoView: true })
  host.view.focus()
}

// ---------- the pipeline ----------

async function analyze() {
  if (!host.root()) return
  if (!(await featureReady('analysis'))) return progress('Pick a model for "Writing analysis" in ⚙ (AI settings).')
  job = { stopped: false }
  const btn = $<HTMLButtonElement>('.rv-analyze')
  btn.textContent = 'Stop'
  btn.classList.remove('primary')
  const started = performance.now()
  try {
    await host.save()
    graph ??= await loadGraph(host)
    const g = graph

    // 1. grammar (LanguageTool) across every .tex file
    grammar = []
    if (await grammarAvailable()) {
      for (const f of host.files().filter(f => f.path.endsWith('.tex'))) {
        const state = EditorState.create({ doc: await host.fileText(f.path), extensions: [new LanguageSupport(LaTeXLanguage)] })
        const issues = await checkDocument(state, (d, t) => progress(`Grammar: ${f.path} paragraph ${d}/${t}`))
        grammar.push(...issues.map(i => ({ ...i, file: f.path })))
      }
    }
    render()

    // 2. claims + links (also refreshes which paragraphs exist)
    await updateClaims(host, g, job, progress)
    await saveGraph(host, g)
    if (job.stopped) return

    // 3. flow, per paragraph with its neighbours as context
    await checkFlow(g, job)
    await saveGraph(host, g)
    render()
    if (job.stopped) return

    // 4. fact check
    await factCheck(host, g, job, progress, { web: true })
    await saveGraph(host, g)
    render()
    if (job.stopped) return

    // 5. argument
    argIssues = await analyseArgument(g, job, progress)
    await saveGraph(host, g)
    if (job.stopped) return

    // 6. bias
    matrix = await biasMatrix(host, g, job, progress)
    await saveGraph(host, g)
    lastRun = `Analyzed in ${((performance.now() - started) / 1000).toFixed(0)}s`
  } catch (e) {
    const msg = (e as Error).message || String(e)
    if (!/abort/i.test(msg)) progress(`⚠ ${msg}`)
  } finally {
    const stopped = job?.stopped
    job = null
    btn.textContent = 'Analyze'
    btn.classList.add('primary')
    progress(stopped ? 'Stopped. What finished is saved; Analyze continues from there.' : lastRun)
    publishDiagnostics()
    render()
  }
}

async function checkFlow(g: Graph, job: Job) {
  const ps = await projectParagraphs(host)
  const todo = ps.filter(p => g.paras[p.key] && !g.paras[p.key].flow)
  const states = new Map<string, EditorState>()
  const stateFor = async (file: string) => {
    if (!states.has(file)) states.set(file, EditorState.create({ doc: await host.fileText(file), extensions: [new LanguageSupport(LaTeXLanguage)] }))
    return states.get(file)!
  }
  for (const [n, p] of todo.entries()) {
    if (job.stopped) return
    progress(`Flow: paragraph ${n + 1} of ${todo.length}`)
    const i = ps.indexOf(p)
    const plain = async (q?: typeof p) => (q ? plainText(await stateFor(q.file), q.from, q.to) : '')
    const r = runAi({
      feature: 'analysis',
      system: 'You are an editor improving the flow and clarity of academic writing. Answer with JSON only.',
      json: true,
      maxTokens: 1200,
      messages: [
        {
          role: 'user',
          content:
            `Previous paragraph: ${(await plain(ps[i - 1])) || '(none)'}\n\nParagraph to review (LaTeX source):\n<<<\n${p.text}\n>>>\n\nNext paragraph: ${(await plain(ps[i + 1])) || '(none)'}\n\n` +
            'Rate how well the paragraph reads and connects to its neighbours, and list concrete problems. Return {"flow_score": 0-100, "issues": ' +
            '[{"find": "exact text from the LaTeX source", "type": "unclear|non_sequitur|weak_transition|repetition|too_long", "message": "what is wrong", "rewrite": "improved LaTeX for exactly that text"}]}. ' +
            'Only real problems; at most 4; [] if it reads well.',
        },
      ],
    })
    job.cancel = r.cancel
    const v = extractJson<{ flow_score?: number; issues?: FlowIssue[] }>((await r.result).text)
    const issues = (v?.issues ?? [])
      .map(x => ({ ...x, find: locate(p.text, String(x.find ?? '')) ?? '' }))
      .filter(x => x.find && x.message)
    g.paras[p.key].flow = { score: typeof v?.flow_score === 'number' ? Math.max(0, Math.min(100, v.flow_score)) : 75, issues }
  }
}

/** Underlines in the editor: flow notes (info), fact-check problems (warning/error). */
function publishDiagnostics() {
  if (!graph) return
  const byFile = new Map<string, { flow: { find: string; message: string; severity?: 'info' | 'warning' | 'error' }[]; facts: { find: string; message: string; severity?: 'info' | 'warning' | 'error' }[] }>()
  const slot = (f: string) => (byFile.get(f) ?? byFile.set(f, { flow: [], facts: [] }).get(f))!
  for (const p of Object.values(graph.paras)) for (const i of p.flow?.issues ?? []) slot(p.file).flow.push({ find: i.find, message: `Flow · ${i.message}`, severity: 'info' })
  for (const c of allClaims(graph)) {
    const ev = graph.evidence[c.id]
    if (!ev || ev.verdict === 'supported' || ev.verdict === 'possible_source') continue
    slot(c.file).facts.push({ find: c.text, message: `Fact check · ${label(ev.verdict)}: ${ev.explanation}`, severity: ev.verdict === 'contradicted' ? 'error' : 'warning' })
  }
  for (const f of host.files().filter(f => f.path.endsWith('.tex'))) {
    host.setAiDiagnostics(f.path, byFile.get(f.path)?.flow ?? [], 'Flow')
    host.setAiDiagnostics(f.path, byFile.get(f.path)?.facts ?? [], 'Fact check')
  }
}

const label = (v: string) =>
  ({ supported: 'supported', partial: 'partly supported', not_found: 'not found in the source', contradicted: 'contradicted', needs_citation: 'needs a citation', possible_source: 'source available' })[v] ?? v

// ---------- rendering ----------

function scores() {
  const g = graph
  const box = $('.rv-scores')
  if (!g || !Object.keys(g.paras).length) return box.replaceChildren(el('div', 'muted rv-hint', 'Analyze checks grammar, flow, claims against your sources, the argument and bias. Everything runs locally and free.'))
  const paras = Object.values(g.paras)
  const words = paras.reduce((n, p) => n + (p.text.match(/[A-Za-z]{2,}/g)?.length ?? 0), 0) || 1
  const correctness = 100 - Math.min(100, Math.round((grammar.filter(i => i.kind === 'correctness').length / words) * 100 * 25))
  const flowed = paras.filter(p => p.flow)
  const flow = flowed.length ? Math.round(flowed.reduce((s, p) => s + p.flow!.score, 0) / flowed.length) : null
  const unclear = flowed.reduce((n, p) => n + p.flow!.issues.filter(i => i.type === 'unclear' || i.type === 'too_long').length, 0)
  const clarity = flowed.length ? Math.max(0, 100 - Math.round((unclear / flowed.length) * 50)) : null
  const checked = allClaims(g).filter(c => needsCheck(c) && g.evidence[c.id])
  const evidence = checked.length ? Math.round((checked.filter(c => g.evidence[c.id].verdict === 'supported').length / checked.length) * 100) : null
  const chip = (name: string, text: string, color: string) => {
    const d = el('div', 'rv-chip')
    const n = el('div', 'rv-chip-n', text)
    n.style.color = color
    d.append(n, el('div', 'rv-chip-l', name))
    return d
  }
  // a 0–100 score: green ≥ 80, amber ≥ 60, red below
  const score = (name: string, v: number | null) =>
    chip(name, v == null ? '–' : String(v), v == null ? '' : v >= 80 ? '#6cc66c' : v >= 60 ? 'var(--warn)' : 'var(--error)')
  box.replaceChildren(
    score('Correctness', grammar.length || flowed.length ? correctness : null),
    score('Clarity', clarity),
    score('Flow', flow),
    score('Evidence', evidence),
    chip('Argument issues', String(argIssues.length), argIssues.some(i => i.severity === 'error') ? 'var(--error)' : argIssues.length ? 'var(--warn)' : '#6cc66c')
  )
  setBadge('review', argIssues.filter(i => i.severity === 'error').length + checked.filter(c => g.evidence[c.id].verdict === 'contradicted').length)
}

function render() {
  if (!host) return
  scores()
  const body = $('.rv-body')
  if (view === 'writing') body.replaceChildren(...writingView())
  else if (view === 'facts') body.replaceChildren(...factsView())
  else if (view === 'argument') body.replaceChildren(...argumentView())
  else body.replaceChildren(...biasView())
}

function writingView(): HTMLElement[] {
  const out: HTMLElement[] = []
  const ltBox = el('div', 'rv-lt')
  void grammarAvailable().then(ok => {
    if (ok) return void (ltBox.textContent = `Grammar & style: LanguageTool (local) · ${grammar.filter(i => i.kind === 'correctness').length} grammar, ${grammar.filter(i => i.kind === 'style').length} style issues`)
    ltBox.replaceChildren(
      el('span', 'muted', 'Grammar checking needs LanguageTool (free, ~250 MB, runs locally on Java). '),
      button('Install LanguageTool', async () => {
        try {
          await lt.install()
          await grammarAvailable(true)
          refreshGrammar(host.view)
          progress('LanguageTool installed.')
          render()
        } catch (e) {
          progress(`⚠ ${(e as Error).message}`)
        }
      }, 'primary')
    )
  })
  out.push(ltBox)
  const g = graph
  if (g) {
    const flowCards = Object.values(g.paras).filter(p => p.flow?.issues.length)
    if (flowCards.length) out.push(el('h4', 'rv-h', 'Flow & clarity'))
    for (const p of flowCards) {
      const card = el('div', 'rv-card')
      const head = el('div', 'rv-card-head')
      head.append(el('span', 'rv-score', `${p.flow!.score}`), el('span', 'muted', `${p.file} · ${p.section || 'untitled'}`))
      card.append(head)
      for (const i of p.flow!.issues) {
        const row = el('div', 'rv-issue')
        const t = el('div', 'rv-issue-type', i.type.replace('_', ' '))
        const m = el('div', '', i.message)
        const q = el('div', 'rv-quote', readable(i.find).slice(0, 160))
        q.onclick = () => void jumpTo(p.file, i.find)
        row.append(t, m, q)
        if (i.rewrite && i.rewrite !== i.find) row.append(button('Review fix', () => void applyEdits([{ file: p.file, find: i.find, replace: i.rewrite! }], 'Flow fix')))
        card.append(row)
      }
      out.push(card)
    }
  }
  if (grammar.length) {
    out.push(el('h4', 'rv-h', 'Grammar & style'))
    for (const i of grammar.slice(0, 80)) {
      const row = el('div', `rv-gram ${i.kind}`)
      const msg = el('div', '', i.message)
      row.append(el('span', 'rv-issue-type', i.kind), msg)
      row.onclick = async () => {
        await host.openFile(i.file)
        host.view.dispatch({ selection: { anchor: i.from, head: i.to }, scrollIntoView: true })
      }
      out.push(row)
    }
  }
  if (out.length === 1 && !graph) out.push(el('div', 'muted rv-hint', 'Live grammar underlines appear as you type. Click Analyze for flow, claims and the rest.'))
  return out
}

const VERDICT_ORDER = ['contradicted', 'not_found', 'partial', 'needs_citation', 'possible_source', 'supported']

function factsView(): HTMLElement[] {
  const g = graph
  if (!g) return [el('div', 'muted rv-hint', 'Click Analyze to check your claims against their sources.')]
  const checked = allClaims(g).filter(c => g.evidence[c.id])
  if (!checked.length) return [el('div', 'muted rv-hint', 'No claims checked yet.')]
  const out: HTMLElement[] = []
  for (const v of VERDICT_ORDER) {
    const group = checked.filter(c => g.evidence[c.id].verdict === v)
    if (!group.length) continue
    const details = document.createElement('details')
    details.open = v !== 'supported'
    details.append(Object.assign(document.createElement('summary'), { className: `rv-group ${v}`, textContent: `${label(v)} (${group.length})` }))
    for (const c of group) details.append(claimCard(c))
    out.push(details)
  }
  return out
}

function claimCard(c: Claim) {
  const ev = graph!.evidence[c.id]
  const card = el('div', `rv-card claim ${ev.verdict}`)
  const q = el('div', 'rv-quote', readable(c.text))
  q.onclick = () => void jumpTo(c.file, c.text)
  const src = el('div', 'muted rv-src')
  src.textContent = [
    ev.source === 'cited' ? 'Cited source' : ev.source === 'library' ? 'Your library' : ev.source === 'web' ? 'Web' : '',
    ev.citekey ?? '',
    ev.title ? `“${ev.title}”` : '',
    ev.abstractOnly ? '(abstract only)' : '',
  ].filter(Boolean).join(' · ')
  card.append(q, src)
  if (ev.quote) card.append(el('blockquote', 'rv-evidence', ev.quote))
  if (ev.explanation) card.append(el('div', '', ev.explanation))
  const acts = el('div', 'rs-row')
  if (ev.verdict === 'possible_source' && ev.source === 'library' && ev.citekey)
    acts.append(button(`Cite ${ev.citekey}`, async () => {
      await jumpTo(c.file, c.text)
      const sel = host.view.state.selection.main
      host.view.dispatch({ selection: { anchor: sel.to } })
      await citeFromZotero(host, ev.citekey!)
    }, 'primary'))
  if (ev.url) acts.append(button('Open source', () => window.open(ev.url)))
  if (acts.childElementCount) card.append(acts)
  return card
}

function argumentView(): HTMLElement[] {
  const g = graph
  if (!g || !allClaims(g).length) return [el('div', 'muted rv-hint', 'Click Analyze to map how your claims support each other.')]
  const byId = new Map(allClaims(g).map(c => [c.id, c]))
  const out: HTMLElement[] = [argumentMap(g, new Set(argIssues.flatMap(i => i.claims)))]
  out.push(el('h4', 'rv-h', argIssues.length ? `${argIssues.length} issue${argIssues.length > 1 ? 's' : ''}` : 'No argument issues found'))
  for (const i of argIssues) {
    const card = el('div', `rv-card arg ${i.severity}`)
    card.append(el('div', 'rv-issue-type', i.type.replace(/_/g, ' ')), el('div', '', i.message))
    const first = byId.get(i.claims[0])
    if (first) card.onclick = () => void jumpTo(first.file, first.text)
    out.push(card)
  }
  return out
}

/** Claims as nodes in columns by section; green arrows support, red lines contradict. */
function argumentMap(g: Graph, flagged: Set<string>) {
  const NS = 'http://www.w3.org/2000/svg'
  const claims = allClaims(g)
  const sections = [...new Set(claims.map(c => c.section || 'Untitled'))]
  const colW = 170
  const rowH = 54
  const pos = new Map<string, { x: number; y: number }>()
  let maxRows = 0
  sections.forEach((s, si) => {
    const col = claims.filter(c => (c.section || 'Untitled') === s)
    maxRows = Math.max(maxRows, col.length)
    col.forEach((c, ri) => pos.set(c.id, { x: 20 + si * colW, y: 40 + ri * rowH }))
  })
  const W = 40 + sections.length * colW
  const H = 60 + maxRows * rowH
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`)
  svg.setAttribute('class', 'rv-map')
  svg.style.minWidth = `${Math.min(W, 1200)}px`
  const mk = (tag: string, attrs: Record<string, string | number>, parent: Element = svg) => {
    const e = document.createElementNS(NS, tag)
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v))
    parent.appendChild(e)
    return e
  }
  const defs = mk('defs', {})
  const marker = mk('marker', { id: 'rv-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto' }, defs)
  mk('path', { d: 'M0,0 L10,5 L0,10 z', fill: '#6cc66c' }, marker)
  sections.forEach((s, si) => {
    const t = mk('text', { x: 20 + si * colW, y: 20, class: 'rv-map-sec' })
    t.textContent = s.length > 22 ? s.slice(0, 21) + '…' : s
  })
  for (const e of g.edges) {
    const a = pos.get(e.from)
    const b = pos.get(e.to)
    if (!a || !b) continue
    mk('line', { x1: a.x + 75, y1: a.y + 18, x2: b.x + 75, y2: b.y + 18, class: e.rel === 'supports' ? 'rv-edge-sup' : 'rv-edge-con', 'marker-end': e.rel === 'supports' ? 'url(#rv-arrow)' : '' })
  }
  for (const c of claims) {
    const p = pos.get(c.id)!
    const ev = g.evidence[c.id]
    const cls = ['rv-node', c.kind, flagged.has(c.id) ? 'flagged' : '', ev?.verdict ?? ''].join(' ')
    const grp = mk('g', { class: cls, transform: `translate(${p.x},${p.y})` })
    mk('rect', { width: 150, height: 36, rx: 6 }, grp)
    const t = mk('text', { x: 6, y: 15 }, grp)
    t.textContent = readable(c.text).slice(0, 26)
    const k = mk('text', { x: 6, y: 29, class: 'rv-node-kind' }, grp)
    k.textContent = `${c.kind}${c.citekeys.length ? ' · cited' : ''}`
    const title = mk('title', {}, grp)
    title.textContent = readable(c.text)
    grp.addEventListener('click', () => void jumpTo(c.file, c.text))
  }
  const wrap = el('div', 'rv-map-wrap')
  wrap.append(svg)
  return wrap
}

function biasView(): HTMLElement[] {
  if (!matrix || !matrix.sections.length) return [el('div', 'muted rv-hint', 'Click Analyze to build the bias matrix (sections × research-bias types).')]
  const table = el('table', 'rv-bias')
  const head = table.insertRow()
  head.insertCell()
  for (const s of matrix.sections) head.insertCell().textContent = s
  for (const r of ROWS) {
    const tr = table.insertRow()
    const name = tr.insertCell()
    name.textContent = r.label
    name.title = r.how
    for (const s of matrix.sections) {
      const cell = matrix.cells[s][r.id]
      const td = tr.insertCell()
      td.className = 'rv-bias-cell'
      const v = cell.score ?? 0
      td.style.background = `hsla(${120 - v * 1.2}, 60%, 40%, ${0.25 + v / 160})`
      td.innerHTML = `<b>${cell.score ?? '–'}%</b><span>${cell.kind === 'measured' ? 'measured' : cell.kind === 'ai' ? 'AI' : 'mixed'}</span>`
      if (selectedCell?.section === s && selectedCell.row === r.id) td.classList.add('sel')
      td.onclick = () => ((selectedCell = { section: s, row: r.id }), render())
    }
  }
  const out: HTMLElement[] = [el('div', 'rv-map-wrap', ''), el('p', 'muted rv-hint', 'Higher = more bias. Click a cell for how it was scored and the evidence behind it.')]
  out[0].append(table)
  if (selectedCell) {
    const r = ROWS.find(x => x.id === selectedCell!.row)!
    const cell = matrix.cells[selectedCell.section]?.[r.id]
    if (cell) {
      const box = el('div', 'rv-card')
      box.append(el('div', 'rv-issue-type', `${r.label} · ${selectedCell.section} · ${cell.score}%`), el('div', 'muted', r.how))
      const ul = el('ul', 'rv-ev-list')
      for (const e of cell.evidence.filter(Boolean)) ul.append(el('li', '', e))
      box.append(ul)
      out.push(box)
    }
  }
  return out
}

function button(text: string, onClick: () => void, cls = '') {
  const b = el('button', cls, text)
  b.onclick = ev => (ev.stopPropagation(), onClick())
  return b
}
