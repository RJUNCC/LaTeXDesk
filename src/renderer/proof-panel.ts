// The Proof tab: state a theorem, build its proof as ordered steps (AI or a no-AI skeleton), edit and reorder
// the steps, check them in order (order → algebra → logic), then insert the proof or turn the gaps into tasks.
// "Check my proof" reads the proof at the cursor and underlines the steps that don't hold.
import katex from 'katex'
import { featureReady } from './ai-client'
import { reviewChanges } from './diff-review'
import type { AppHost } from './host'
import type { Job } from './knowledge'
import { mathOf } from './latex-math'
import { panelEl, showPanel, whenShown } from './panels'
import { KINDS, Proof, Step, StepKind, Strategy, buildSteps, checkProof, emptyProof, expandStep, loadProof, newId, parseProof, proofLatex, refLabel, saveProof, skeleton, theoremAt, withLabels } from './proof'
import { addTasks } from './tasks'

let host: AppHost
let proof: Proof = emptyProof()
let job: Job | null = null
let editing: string | null = null
const $ = <T extends HTMLElement>(sel: string) => panelEl('proof').querySelector<T>(sel)!

export function initProof(h: AppHost) {
  host = h
  panelEl('proof').innerHTML = `
    <div class="pf-body">
      <section class="rs-section">
        <h4>Theorem</h4>
        <textarea class="pf-statement" rows="3" placeholder="What to prove, e.g. For every integer $n \\geq 1$, $\\sum_{i=1}^{n} (2i-1) = n^2$."></textarea>
        <div class="rs-row">
          <button class="pf-from-doc" title="Use the selected text, or the theorem the cursor is in">From editor</button>
          <select class="pf-strategy" title="Proof method">
            <option value="auto">Method: choose for me</option><option value="direct">Direct</option><option value="contradiction">Contradiction</option>
            <option value="contrapositive">Contrapositive</option><option value="induction">Induction</option><option value="cases">Cases</option>
          </select>
        </div>
        <div class="rs-row">
          <button class="primary pf-build">Build steps</button>
          <button class="pf-skeleton" title="An empty outline for the chosen method, no AI">Skeleton</button>
          <button class="pf-check-doc" title="Split the proof at the cursor into steps and check them">Check my proof</button>
        </div>
      </section>
      <div class="pf-given"></div>
      <div class="pf-summary"></div>
      <div class="pf-steps"></div>
      <div class="rs-row pf-footer">
        <button class="primary pf-check">Check steps</button>
        <button class="pf-add" title="Add a step at the end">+ Step</button>
        <button class="pf-insert">Insert proof</button>
        <button class="pf-tasks" title="Unproved steps become tasks the AI can work on">Add to Tasks</button>
      </div>
      <div class="pf-status muted"></div>
    </div>`
  $('.pf-from-doc').onclick = fromEditor
  $('.pf-build').onclick = () => (job ? stop() : void build())
  $('.pf-skeleton').onclick = () => {
    const statement = $<HTMLTextAreaElement>('.pf-statement').value.trim()
    setProof({ ...skeleton(statement, strategy()), source: proof.source?.inDocument ? undefined : proof.source })
  }
  $('.pf-check-doc').onclick = () => (job ? stop() : void checkDocument())
  $('.pf-check').onclick = () => (job ? stop() : void check())
  $('.pf-add').onclick = () => {
    proof.steps.push({ id: newId(), kind: 'derive', claim: '…', justification: '', uses: [], status: 'unchecked', notes: [] })
    editing = proof.steps[proof.steps.length - 1].id
    changed()
  }
  $('.pf-insert').onclick = () => void insert()
  $('.pf-tasks').onclick = () => void toTasks()
  $<HTMLTextAreaElement>('.pf-statement').onchange = () => {
    proof.statement = $<HTMLTextAreaElement>('.pf-statement').value
    void persist()
  }
  host.onProjectOpened(async () => setProof((await loadProof(host)) ?? emptyProof(), false))
  whenShown('proof', () => render())
}

const strategy = () => $<HTMLSelectElement>('.pf-strategy').value as Strategy
const status = (text: string) => ($('.pf-status').textContent = text)
const persist = () => saveProof(host, proof).catch(() => {})

function setProof(p: Proof, save = true) {
  proof = p
  editing = null
  $<HTMLTextAreaElement>('.pf-statement').value = p.statement
  if (p.strategy !== 'auto') $<HTMLSelectElement>('.pf-strategy').value = p.strategy
  render()
  if (save) void persist()
}

/** After an edit: results are stale until the next check. */
function changed() {
  for (const s of proof.steps) if (s.status !== 'unchecked') (s.status = 'unchecked'), (s.notes = [])
  render()
  void persist()
}

function fromEditor() {
  const view = host.view
  const sel = view.state.selection.main
  const doc = view.state.doc.toString()
  const file = host.currentPath() ?? ''
  if (!sel.empty) {
    $<HTMLTextAreaElement>('.pf-statement').value = doc.slice(sel.from, sel.to).trim()
    proof.source = undefined
  } else {
    const thm = theoremAt(doc, sel.head)
    if (!thm) return status('Select the statement, or put the cursor inside a theorem/lemma environment.')
    $<HTMLTextAreaElement>('.pf-statement').value = doc.slice(thm.bodyFrom, thm.bodyTo).trim()
    // a proof built for this theorem goes right after it
    proof.source = { file, inDocument: false, theoremEnd: thm.to }
  }
  proof.statement = $<HTMLTextAreaElement>('.pf-statement').value
  status('')
  void persist()
}

function stop() {
  if (!job) return
  job.stopped = true
  job.cancel?.()
}

function busy(on: boolean, label = '') {
  for (const sel of ['.pf-build', '.pf-check', '.pf-check-doc']) {
    const b = $<HTMLButtonElement>(sel)
    if (on) b.dataset.label ??= b.textContent ?? ''
    b.textContent = on ? (sel === label ? 'Stop' : b.dataset.label!) : b.dataset.label ?? b.textContent ?? ''
    b.disabled = on && sel !== label
  }
}

async function needAi() {
  if (await featureReady('proof')) return true
  status('Choose a model for Proofs in AI settings (⚙) first. Skeleton works without AI.')
  return false
}

async function build() {
  const statement = $<HTMLTextAreaElement>('.pf-statement').value.trim()
  if (!statement) return status('Write the theorem to prove first.')
  if (!(await needAi())) return
  job = { stopped: false }
  busy(true, '.pf-build')
  status('Building the proof… (the model reasons first, which can take a minute or two)')
  const keep = proof.source && !proof.source.inDocument ? proof.source : undefined
  try {
    const built = await buildSteps(statement, strategy(), job)
    if (!job.stopped) {
      setProof({ ...built, source: keep })
      status(`${built.steps.length} steps. Check steps to verify them.`)
    }
  } catch (e) {
    if (!job.stopped) status(`⚠ ${(e as Error).message}`)
  } finally {
    job = null
    busy(false)
    render()
  }
}

async function check() {
  if (!proof.steps.length) return status('Build steps, start from a skeleton, or use Check my proof first.')
  if (!(await needAi())) return
  await runCheck('.pf-check')
}

async function runCheck(button: string) {
  job = { stopped: false }
  busy(true, button)
  const started = Date.now()
  try {
    const broken = await checkProof(proof, job, msg => (status(msg), render()))
    render()
    await persist()
    const secs = Math.round((Date.now() - started) / 1000)
    if (job.stopped) status('Stopped. Steps already checked keep their results.')
    else if (broken >= 0) status(`Step ${broken + 1} is the first that doesn’t hold (${secs}s).`)
    else if (proof.steps.some(s => s.status === 'partly')) status(`No step fails, but some only partly follow (${secs}s).`)
    else status(`Every step checks out (${secs}s).`)
    if (proof.source?.inDocument) underline()
  } catch (e) {
    status(`⚠ ${(e as Error).message}`)
  } finally {
    job = null
    busy(false)
    render()
  }
}

async function checkDocument() {
  const view = host.view
  const file = host.currentPath()
  if (!file) return
  const parsed = parseProof(view.state.doc.toString(), view.state.selection.main.head, file)
  if (!parsed) return status('Put the cursor inside a proof environment (or the theorem just before it).')
  if (!parsed.steps.length) return status('That proof is empty.')
  // keep earlier verdicts for steps that haven't changed
  parsed.logicCache = proof.logicCache
  setProof(parsed)
  if (!(await needAi())) return
  await runCheck('.pf-check-doc')
}

function underline() {
  const file = proof.source?.file
  if (!file) return
  host.setAiDiagnostics(
    file,
    proof.steps
      .filter(s => s.text && (s.status === 'fail' || s.status === 'partly'))
      .map(s => ({ find: s.text!, message: s.notes.join(' ') || 'This step may not follow.', severity: s.status === 'fail' ? ('error' as const) : ('warning' as const) })),
    'Proof'
  )
}

async function insert() {
  if (!proof.steps.length) return status('Nothing to insert yet.')
  if (proof.source?.inDocument) return status('This proof is already in your document.')
  const file = proof.source?.file || host.currentPath()
  if (!file) return
  const before = await host.fileText(file)
  const afterTheorem = proof.source?.theoremEnd != null && file === proof.source.file
  const at = afterTheorem ? proof.source!.theoremEnd! : host.view.state.doc.lineAt(host.view.state.selection.main.head).to
  const block = proofLatex(proof, !afterTheorem)
  const after = `${before.slice(0, at)}\n${block}\n${before.slice(at)}`
  const applied = await reviewChanges('Insert proof', [{ file, before, after }], host)
  if (applied > 0) {
    host.format.ensurePackage('amsmath')
    host.format.ensurePackage('amsthm')
    host.format.ensurePackage('enumitem')
    if (!afterTheorem) host.format.ensurePreamble('\\newtheorem{theorem}{Theorem}', /\\newtheorem\s*\{theorem\}/)
    status('Inserted. Ctrl+Z in the editor undoes it.')
  }
}

async function toTasks() {
  const open = proof.steps.map((s, i) => ({ s, i })).filter(({ s }) => s.status !== 'ok')
  if (!open.length) return status('Every step is verified: nothing to add.')
  const name = plain(proof.statement).slice(0, 60) || 'the theorem'
  await addTasks(open.map(({ s, i }) => `Proof of “${name}”: justify Step ${i + 1}: ${plain(s.claim)}${s.notes.length ? ` (${s.notes[s.notes.length - 1]})` : ''}`))
  status(`Added ${open.length} task${open.length > 1 ? 's' : ''}, in proof order.`)
  showPanel('tasks')
}

const plain = (s: string) => s.replace(/\s+/g, ' ').trim()

// ---------- rendering ----------

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

/** Text with $…$ / \(…\) / \[…\] maths rendered by KaTeX; a bare formula is rendered whole. */
function mixed(text: string) {
  const tex = (src: string, display: boolean) => katex.renderToString(src, { displayMode: display, throwOnError: false, strict: 'ignore' })
  if (!/\$|\\\(|\\\[|\\begin\{/.test(text) && mathOf(text).length) return tex(text, false)
  return text
    .split(/(\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\$[^$]+\$|\\\([\s\S]+?\\\)|\\begin\{(?:equation|align|gather)\*?\}[\s\S]*?\\end\{(?:equation|align|gather)\*?\})/)
    .map(part => {
      if (/^\$\$/.test(part)) return tex(part.slice(2, -2), true)
      if (/^\\\[/.test(part)) return tex(part.slice(2, -2), true)
      if (/^\$/.test(part)) return tex(part.slice(1, -1), false)
      if (/^\\\(/.test(part)) return tex(part.slice(2, -2), false)
      if (/^\\begin/.test(part)) {
        const body = part.replace(/^\\begin\{(\w+)\*?\}|\\end\{\w+\*?\}$/g, '')
        return tex(/align/.test(part) ? `\\begin{aligned}${body}\\end{aligned}` : body, true)
      }
      return esc(part)
    })
    .join('')
}

function render() {
  if (!host) return
  $('.pf-given').innerHTML =
    proof.hypotheses.length || proof.goal
      ? `${proof.hypotheses.map((h, i) => `<div><b>H${i + 1}</b> ${mixed(h.text)}</div>`).join('')}${proof.goal ? `<div><b>Goal</b> ${mixed(proof.goal)}</div>` : ''}`
      : ''
  const counts = { ok: 0, partly: 0, fail: 0 }
  for (const s of proof.steps) if (s.status in counts) counts[s.status as keyof typeof counts]++
  const firstBad = proof.steps.findIndex(s => s.status === 'fail')
  $('.pf-summary').innerHTML = proof.steps.length
    ? `${proof.intro ? `<div class="pf-intro">${mixed(proof.intro)}</div>` : ''}<div class="pf-chips"><span class="pf-chip ok">${counts.ok} follow</span><span class="pf-chip partly">${counts.partly} partly</span><span class="pf-chip fail">${counts.fail} fail</span>${firstBad >= 0 ? `<span class="pf-first">First broken step: ${firstBad + 1}</span>` : ''}</div>`
    : '<div class="muted">State a theorem and press <b>Build steps</b>, start from a <b>Skeleton</b>, or put the cursor in a proof and press <b>Check my proof</b>.</div>'
  $('.pf-steps').replaceChildren(...proof.steps.map((s, i) => (editing === s.id ? editor(s, i) : card(s, i))))
  $<HTMLButtonElement>('.pf-insert').hidden = !!proof.source?.inDocument
}

function card(s: Step, i: number) {
  const el = document.createElement('div')
  el.className = `pf-step ${s.status}`
  const uses = s.uses.length ? `<span class="pf-uses">uses ${s.uses.map(u => esc(refLabel(proof, u))).join(', ')}</span>` : ''
  const algebra = s.algebra?.status === 'ok' ? '<span class="pf-alg" title="Every equation and inequality in this step held at 20 random points">algebra ✓</span>' : ''
  el.innerHTML = `
    <div class="pf-head"><span class="pf-dot" title="${s.status}"></span><b>Step ${i + 1}</b><span class="pf-kind">${s.kind}</span>${uses}${algebra}<span class="pf-tools"></span></div>
    <div class="pf-claim">${mixed(s.claim)}</div>
    ${s.justification ? `<div class="pf-just">because ${mixed(withLabels(proof, s.justification))}</div>` : ''}
    ${s.notes.length ? `<ul class="pf-notes">${s.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}`
  const tools = el.querySelector('.pf-tools')!
  const tool = (label: string, title: string, fn: () => void, disabled = false) => {
    const b = document.createElement('button')
    b.className = 'pf-tool'
    b.textContent = label
    b.title = title
    b.disabled = disabled || !!job
    b.onclick = fn
    tools.append(b)
  }
  const doc = proof.source?.inDocument
  tool('↑', 'Move up', () => move(i, -1), i === 0 || doc)
  tool('↓', 'Move down', () => move(i, 1), i === proof.steps.length - 1 || doc)
  tool('✎', 'Edit', () => ((editing = s.id), render()), doc)
  tool('⤵', 'Expand into smaller steps (AI)', () => void expand(i), doc)
  tool('+', 'Add a step after this one', () => {
    proof.steps.splice(i + 1, 0, { id: newId(), kind: 'derive', claim: '…', justification: '', uses: [s.id], status: 'unchecked', notes: [] })
    editing = proof.steps[i + 1].id
    changed()
  }, doc)
  tool('✕', 'Delete', () => {
    proof.steps.splice(i, 1)
    for (const t of proof.steps) t.uses = t.uses.filter(u => u !== s.id)
    changed()
  }, doc)
  if (doc && s.text) {
    const claim = el.querySelector<HTMLElement>('.pf-claim')!
    claim.classList.add('pf-jump')
    claim.title = 'Show in the editor'
    claim.onclick = () => jump(s.text!)
  }
  return el
}

function jump(text: string) {
  const at = host.view.state.doc.toString().indexOf(text)
  if (at >= 0) (host.view.dispatch({ selection: { anchor: at, head: at + text.length }, scrollIntoView: true }), host.view.focus())
}

function move(i: number, d: number) {
  const [s] = proof.steps.splice(i, 1)
  proof.steps.splice(i + d, 0, s)
  changed()
}

async function expand(i: number) {
  if (!(await needAi())) return
  job = { stopped: false }
  busy(true)
  status(`Expanding Step ${i + 1}…`)
  try {
    await expandStep(proof, i, job)
    changed()
    status(`Step ${i + 1} expanded.`)
  } catch (e) {
    status(`⚠ ${(e as Error).message}`)
  } finally {
    job = null
    busy(false)
    render()
  }
}

function editor(s: Step, i: number) {
  const el = document.createElement('div')
  el.className = 'pf-step pf-editing'
  const labelToId = (label: string) => {
    const t = label.trim()
    const step = /^(step\s*)?(\d+)$/i.exec(t)
    if (step) return proof.steps[Number(step[2]) - 1]?.id ?? t
    const hyp = /^h(\d+)$/i.exec(t)
    if (hyp) return proof.hypotheses[Number(hyp[1]) - 1]?.id ?? t
    return t
  }
  el.innerHTML = `
    <div class="pf-head"><b>Step ${i + 1}</b>
      <select class="pf-e-kind">${KINDS.map(k => `<option${k === s.kind ? ' selected' : ''}>${k}</option>`).join('')}</select></div>
    <textarea class="pf-e-claim" rows="3" placeholder="The claim; maths in $…$, or a bare formula">${esc(s.claim)}</textarea>
    <input class="pf-e-just" placeholder="Because… (definition, theorem, algebra, Step 2…)" value="${esc(withLabels(proof, s.justification))}">
    <input class="pf-e-uses" placeholder="Uses, e.g. 1, 3, H1" value="${esc(s.uses.map(u => refLabel(proof, u).replace(/^Step /, '')).join(', '))}">
    <div class="rs-row"><button class="primary pf-e-save">Save</button><button class="pf-e-cancel">Cancel</button></div>`
  const q = <T extends HTMLElement>(c: string) => el.querySelector<T>(c)!
  q('.pf-e-save').onclick = () => {
    s.kind = q<HTMLSelectElement>('.pf-e-kind').value as StepKind
    s.claim = q<HTMLTextAreaElement>('.pf-e-claim').value.trim() || '…'
    s.justification = q<HTMLInputElement>('.pf-e-just').value.trim()
    s.uses = q<HTMLInputElement>('.pf-e-uses').value.split(',').map(labelToId).filter(Boolean)
    editing = null
    changed()
  }
  q('.pf-e-cancel').onclick = () => ((editing = null), render())
  setTimeout(() => q<HTMLTextAreaElement>('.pf-e-claim').focus())
  return el
}
