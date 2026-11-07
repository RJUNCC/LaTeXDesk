// The AI tab: chat with document context, one-click reviews, proofreading, and "Explain & fix" for errors.
// Anything that changes files comes back as find/replace edits and goes through the diff review.
import type { LatexLogEntry } from '../overleaf/latex-log-parser'
import { AiRequest, extractJson, featureReady, runAi } from './ai-client'
import type { BibEntry } from './bib-project'
import { plain, unsafeFields } from './bib-sources'
import { FindReplace, editsToChanges, reviewChanges } from './diff-review'
import type { AppHost } from './host'
import { panelEl, setBadge, showPanel } from './panels'

export const SYSTEM =
  'You are a careful LaTeX and academic-writing assistant inside the LaTeXDesk editor. ' +
  'Be concise and concrete. Never invent citations, data or results. Answer in plain text unless asked for JSON.'

// The contract for every request that edits files. Exact `find` text is what makes edits safe to apply.
export const EDIT_RULES = `Respond with JSON only, in this shape:
{"summary": "one or two sentences", "edits": [{"file": "path", "find": "exact text", "replace": "new text", "why": "short reason"}]}
Rules:
- "find" must be copied EXACTLY from the file (same spacing and line breaks), long enough to be unique, and as short as possible.
- Keep each edit small and local. Never rewrite text you were not asked to change.
- If nothing needs changing, return "edits": [].`

type Context = 'selection' | 'file' | 'project' | 'none'
type Edit = FindReplace & { why?: string }

let host: AppHost
let busy: { cancel: () => void } | null = null

const $ = <T extends HTMLElement>(sel: string) => panelEl('ai').querySelector<T>(sel)!

export function initAiPanel(h: AppHost) {
  host = h
  const panel = panelEl('ai')
  panel.innerHTML = `
    <div class="pane-title ai-actions">
      <button data-act="review" title="Suggest improvements for the whole open file">Review document</button>
      <button data-act="check" title="Proofread the section around the cursor">Check this section</button>
      <button data-act="tighten" title="Rewrite the selected text more concisely">Tighten selection</button>
      <button data-act="summarize">Summarize</button>
      <button data-act="structure">Suggest structure</button>
    </div>
    <div class="ai-log"><div class="ai-empty muted">Ask about your document, or use a button above.<br>
      Runs on your local model by default: free and private. Change models with ⚙.</div></div>
    <div class="ai-input">
      <select class="ai-context" title="What the AI can see">
        <option value="selection">Selection</option>
        <option value="file" selected>This file</option>
        <option value="project">Whole project</option>
        <option value="none">No context</option>
      </select>
      <textarea class="ai-prompt" rows="2" placeholder="Ask anything… (Enter to send, Shift+Enter for a new line)"></textarea>
      <button class="primary ai-send">Send</button>
    </div>`
  $('.ai-actions').onclick = ev => {
    const act = (ev.target as HTMLElement).dataset.act
    if (act) void quickAction(act)
  }
  const prompt = $<HTMLTextAreaElement>('.ai-prompt')
  prompt.onkeydown = ev => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault()
      void send()
    }
  }
  $('.ai-send').onclick = () => (busy ? stop() : void send())
}

// ---------- conversation log ----------

const chat: { role: 'user' | 'assistant'; content: string }[] = []

function bubble(role: 'user' | 'assistant' | 'note', text = '') {
  $('.ai-empty')?.remove()
  const div = document.createElement('div')
  div.className = `ai-msg ${role}`
  div.textContent = text
  $('.ai-log').appendChild(div)
  div.scrollIntoView({ block: 'end' })
  return div
}

function setBusy(job: { cancel: () => void } | null) {
  busy = job
  const btn = $<HTMLButtonElement>('.ai-send')
  btn.textContent = job ? 'Stop' : 'Send'
  btn.classList.toggle('primary', !job)
  panelEl('ai').querySelectorAll<HTMLButtonElement>('.ai-actions button').forEach(b => (b.disabled = !!job))
}

function stop() {
  busy?.cancel()
  setBusy(null)
}

async function ensureReady(feature: 'review' | 'tasks') {
  if (await featureReady(feature)) return true
  bubble('note', 'No AI model is set up for this yet. Open ⚙ (AI settings) to pick one.')
  return false
}

/** Run a request, streaming into a bubble. Resolves to the full text (or null if it failed/was stopped). */
async function stream(req: AiRequest, into: HTMLElement, showText = true): Promise<string | null> {
  const job = runAi(req, (_c, soFar) => {
    if (showText) into.textContent = soFar
    into.scrollIntoView({ block: 'end' })
  })
  setBusy(job)
  into.classList.add('streaming')
  try {
    const r = await job.result
    const cost = r.cost ? ` · ≈$${r.cost.toFixed(4)}` : ''
    into.dataset.meta = `${r.model}${r.usage.output ? ` · ${r.usage.output} tokens` : ''}${cost}`
    return r.text
  } catch (e) {
    const msg = (e as Error).message || String(e)
    into.textContent = /abort/i.test(msg) ? '(stopped)' : `⚠ ${msg}`
    into.classList.add('error')
    return null
  } finally {
    into.classList.remove('streaming')
    setBusy(null)
  }
}

// ---------- context ----------

async function contextText(kind: Context) {
  const v = host.view
  const path = host.currentPath()
  if (kind === 'none') return ''
  if (kind === 'selection') {
    const sel = v.state.selection.main
    if (sel.empty) return ''
    return `Selected text from ${path}:\n\`\`\`latex\n${v.state.sliceDoc(sel.from, sel.to)}\n\`\`\``
  }
  if (kind === 'file' && path) return `File ${path}:\n\`\`\`latex\n${v.state.doc.toString()}\n\`\`\``
  // whole project: every .tex/.bib file, capped so local models keep up
  let out = ''
  for (const f of host.files()) {
    if (!/\.(tex|bib)$/i.test(f.path)) continue
    const t = await host.fileText(f.path)
    if (out.length + t.length > 60000) {
      out += `\n(… ${f.path} and further files omitted for length)`
      break
    }
    out += `\nFile ${f.path}:\n\`\`\`latex\n${t}\n\`\`\`\n`
  }
  return out
}

// ---------- free-form chat ----------

async function send() {
  const prompt = $<HTMLTextAreaElement>('.ai-prompt')
  const text = prompt.value.trim()
  if (!text || busy || !(await ensureReady('review'))) return
  prompt.value = ''
  bubble('user', text)
  const ctx = await contextText($<HTMLSelectElement>('.ai-context').value as Context)
  chat.push({ role: 'user', content: ctx ? `${ctx}\n\n${text}` : text })
  const out = bubble('assistant')
  const reply = await stream({ feature: 'review', system: SYSTEM, messages: chat.slice(-8), maxTokens: 2048 }, out)
  if (reply) chat.push({ role: 'assistant', content: reply })
  else chat.pop()
}

// ---------- structured actions ----------

/** Ask for edits, then offer them in the diff review. */
async function editRequest(label: string, instruction: string, context: string) {
  if (busy || !(await ensureReady('review'))) return
  showPanel('ai')
  bubble('user', label)
  const out = bubble('assistant', 'Working…')
  const text = await stream(
    { feature: 'review', system: SYSTEM, messages: [{ role: 'user', content: `${context}\n\n${instruction}\n\n${EDIT_RULES}` }], maxTokens: 4096, json: true },
    out,
    false
  )
  if (text == null) return
  const data = extractJson<{ summary?: string; explanation?: string; edits?: Edit[] }>(text)
  if (!data) {
    out.textContent = `The model's answer wasn't valid JSON, so there's nothing to apply. Raw answer:\n\n${text}`
    return
  }
  showEdits(out, data.explanation ?? data.summary ?? '', data.edits ?? [])
}

function showEdits(out: HTMLElement, summary: string, edits: Edit[]) {
  const path = host.currentPath()
  const clean = edits
    .filter(e => e && typeof e.replace === 'string' && typeof e.find === 'string' && e.find !== e.replace)
    .map(e => ({ ...e, file: e.file || path || '' }))
  out.textContent = summary || (clean.length ? '' : 'No changes suggested.')
  if (!clean.length) {
    if (!summary) out.textContent = 'No changes suggested.'
    return
  }
  const list = document.createElement('ol')
  list.className = 'ai-edits'
  for (const e of clean) {
    const li = document.createElement('li')
    const why = document.createElement('div')
    why.textContent = e.why || 'Suggested change'
    const diff = document.createElement('div')
    diff.className = 'ai-edit-diff'
    const del = document.createElement('del')
    del.textContent = e.find
    const ins = document.createElement('ins')
    ins.textContent = e.replace
    diff.append(del, ins)
    const one = document.createElement('button')
    one.textContent = 'Review'
    one.onclick = async () => {
      if (await applyEdits([e], 'Review suggestion')) done(one)
    }
    li.append(why, diff, one)
    list.appendChild(li)
  }
  const all = document.createElement('button')
  all.className = 'primary'
  all.textContent = `Review all ${clean.length} change${clean.length > 1 ? 's' : ''}`
  // an applied change can't be applied again: its button says so instead
  const done = (...buttons: HTMLButtonElement[]) =>
    buttons.forEach(b => {
      b.disabled = true
      b.textContent = '✓ Applied'
    })
  all.onclick = async () => {
    if (await applyEdits(clean, 'Review AI suggestions')) done(all, ...list.querySelectorAll('button'))
  }
  out.append(list, all)
  setBadge('ai', clean.length)
}

export async function applyEdits(edits: FindReplace[], title: string) {
  const { changes, problems } = await editsToChanges(edits, host)
  const applied = await reviewChanges(title, changes, host, problems)
  if (applied) host.setStatus(`Applied ${applied} AI change${applied > 1 ? 's' : ''} (Ctrl+Z to undo)`, 'ok')
  setBadge('ai', 0)
  return applied
}

/** The section the cursor is in: from its \section (or the document start) to the next one. */
function currentSection() {
  const state = host.view.state
  const text = state.doc.toString()
  const pos = state.selection.main.head
  const heads = [...text.matchAll(/^\s*\\(?:part|chapter|section|subsection)\*?\{/gm)].map(m => m.index!)
  const start = [...heads].reverse().find(h => h <= pos) ?? Math.max(0, text.indexOf('\\begin{document}'))
  const end = heads.find(h => h > pos) ?? (text.indexOf('\\end{document}') >= 0 ? text.indexOf('\\end{document}') : text.length)
  return text.slice(start, end)
}

async function quickAction(act: string) {
  const path = host.currentPath()
  if (!path) return
  if (act === 'review') {
    return editRequest(
      'Review this document',
      `Review ${path} for clarity, correctness, LaTeX best practice and consistency. Suggest at most 8 high-value edits.`,
      await contextText('file')
    )
  }
  if (act === 'check') return checkSection()
  if (act === 'tighten') {
    const ctx = await contextText('selection')
    if (!ctx) return bubble('note', 'Select some text first.')
    return editRequest('Tighten the selected text', `Rewrite the selected text in ${path} to be clearer and more concise without changing its meaning or LaTeX commands.`, ctx)
  }
  // plain-text answers
  if (busy || !(await ensureReady('review'))) return
  const question =
    act === 'summarize'
      ? 'Summarize this document in 5 bullet points: the question, the method, the main results, and the conclusions.'
      : 'Suggest a clearer section structure for this document as an outline, with a one-line note on what each section should contain. Point out anything missing (e.g. related work, limitations).'
  bubble('user', act === 'summarize' ? 'Summarize' : 'Suggest structure')
  const out = bubble('assistant')
  await stream({ feature: 'review', system: SYSTEM, messages: [{ role: 'user', content: `${await contextText('project')}\n\n${question}` }], maxTokens: 1500 }, out)
}

/** Proofread the current section; issues become editor underlines and reviewable edits. */
async function checkSection() {
  const path = host.currentPath()!
  if (busy || !(await ensureReady('review'))) return
  showPanel('ai')
  bubble('user', 'Check this section')
  const out = bubble('assistant', 'Checking…')
  const section = currentSection()
  const text = await stream(
    {
      feature: 'review',
      system: SYSTEM,
      messages: [
        {
          role: 'user',
          content:
            `Proofread this part of ${path}: spelling, grammar, unclear sentences, and LaTeX mistakes (wrong quotes, missing ~ before \\ref/\\cite, math typed as text, etc.).\n` +
            `\`\`\`latex\n${section}\n\`\`\`\n\n` +
            'Respond with JSON only: {"issues": [{"find": "exact text from the section", "replace": "corrected text", "message": "what is wrong"}]}. ' +
            'Copy "find" exactly and keep it short. Return {"issues": []} if it is fine.',
        },
      ],
      maxTokens: 3000,
      json: true,
    },
    out,
    false
  )
  if (text == null) return
  const data = extractJson<{ issues?: { find: string; replace: string; message: string }[] }>(text)
  const issues = (data?.issues ?? []).filter(i => i?.find && section.includes(i.find))
  host.setAiDiagnostics(path, issues.map(i => ({ find: i.find, message: `${i.message} → ${i.replace}` })))
  showEdits(
    out,
    issues.length ? `${issues.length} issue${issues.length > 1 ? 's' : ''} found (underlined in the editor).` : 'No issues found in this section.',
    issues.map(i => ({ file: path, find: i.find, replace: i.replace, why: i.message }))
  )
}

/**
 * "Explain & fix" for an error in the reference list. The .bbl is rebuilt from the .bib on every compile, so the
 * fix goes in the source's entry. Characters LaTeX reads as commands (^ & % # _) are escaped without asking the AI.
 */
export async function explainSourceError(entry: LatexLogEntry, src: BibEntry) {
  const name = `your source “${plain(src.fields.title) || src.key}” (${src.key}) in ${src.file}`
  const unsafe = unsafeFields(src.fields)
  if (unsafe.length) {
    showPanel('ai')
    bubble('user', `Explain & fix: ${entry.message}`)
    const shown = unsafe.map(f => f.name).join(' and ')
    showEdits(
      bubble('assistant'),
      `This error comes from ${name}. Its ${shown} has characters that LaTeX reads as commands (such as ^, &, %, # or _), so the reference list breaks where it reaches them. The fix escapes them so they print as they are.`,
      unsafe.map(f => ({ file: src.file, find: `{${f.value}}`, replace: `{${f.fixed}}`, why: `Escape the special characters in the ${f.name}` }))
    )
    return
  }
  return editRequest(
    `Explain & fix: ${entry.message}`,
    `LaTeX reported this ${entry.level} in the reference list, which it builds from ${name}:\n${entry.message}\n${entry.content ?? ''}\n\n` +
      'Explain in plain language what is wrong with this source (put it in "summary"), then give the smallest edits to the entry that fix it. ' +
      `Use "file": "${src.file}".`,
    `The entry in ${src.file}:\n\`\`\`bibtex\n${src.raw}\n\`\`\``
  )
}

/** "Explain & fix" from a compile-log entry. */
export async function explainError(entry: LatexLogEntry, file: string | null) {
  if (busy || !(await ensureReady('review'))) return showPanel('ai')
  const line = Number(entry.line) || 0
  let excerpt = ''
  if (file && host.fileExists(file)) {
    const lines = (await host.fileText(file)).split('\n')
    const from = Math.max(0, line - 26)
    excerpt = `Lines ${from + 1}-${Math.min(lines.length, line + 25)} of ${file} (the error is reported at line ${line}):\n\`\`\`latex\n${lines.slice(from, line + 25).join('\n')}\n\`\`\``
  }
  return editRequest(
    `Explain & fix: ${entry.message}`,
    `LaTeX reported this ${entry.level}${file ? ` in ${file}${line ? ` at line ${line}` : ''}` : ''}:\n${entry.message}\n${entry.content ?? ''}\n\n` +
      'Explain in plain language what is wrong (put it in "summary"), then give the smallest edits that fix it. ' +
      `Use "file": "${file ?? ''}". If the problem is a missing package, add the \\usepackage line next to the existing ones.`,
    excerpt
  )
}
