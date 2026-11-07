// Notes on the paper in the Paper tab: one Markdown file per paper in the project's notes/ folder, so they travel
// with the project. Selected text in the PDF can be quoted in with its page number, and the AI can draft the
// paper's key points or how it relates to the document being written (always as an editable draft in the note).
import { featureReady, runAi } from './ai-client'
import type { AppHost } from './host'
import type { PdfViewer } from './pdf-viewer'
import { citeCommandFor } from './zotero-client'

export type NotesPaper = { key: string; title: string }

let host: AppHost
let pane: HTMLElement
let paper: NotesPaper | null = null
let viewer: PdfViewer | null = null
let template = ''
let saveTimer = 0
let job: { cancel(): void } | null = null

const q = <T extends HTMLElement>(sel: string) => pane.querySelector<T>(sel)!
const text = () => q<HTMLTextAreaElement>('.reader-notes-text')

export const notesPath = (key: string) => `notes/${key.replace(/[^A-Za-z0-9_.-]+/g, '-')}.md`

/** Build the notes pane inside `el` (under the PDF in the Paper tab). */
export function initPaperNotes(h: AppHost, el: HTMLElement) {
  host = h
  pane = el
  pane.innerHTML = `
    <div class="reader-notes-bar">
      <span class="reader-notes-file muted"></span>
      <div class="spacer"></div>
      <button class="reader-ai-points" title="The AI drafts the paper’s question, method, findings and limitations into your note">✨ Key points</button>
      <button class="reader-ai-relate" title="The AI reads the paper and your document, and drafts how they connect and where to cite it">✨ How it relates to my work</button>
      <button class="reader-ai-stop" hidden>Stop</button>
    </div>
    <div class="reader-notes-status muted" hidden></div>
    <textarea class="reader-notes-text" spellcheck="true" placeholder="Your notes on this paper. Select text in the PDF and press “Add to notes” to quote it with its page number."></textarea>`
  text().addEventListener('input', () => {
    clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => void saveNotes(), 700)
  })
  q('.reader-ai-points').onclick = () => void keyPoints()
  q('.reader-ai-relate').onclick = () => void relate()
  q('.reader-ai-stop').onclick = () => job?.cancel()
  q('.reader-notes-file').onclick = () => {
    if (paper && host.fileExists(notesPath(paper.key))) void saveNotes().then(() => host.openFile(notesPath(paper!.key)))
  }
}

function status(msg: string) {
  const s = q('.reader-notes-status')
  s.textContent = msg
  s.hidden = !msg
}

/** Show the notes for this paper (its saved note, or a fresh one with its title). */
export async function showNotes(p: NotesPaper | null, v: PdfViewer) {
  await saveNotes()
  job?.cancel()
  paper = p
  viewer = v
  status('')
  const t = text()
  const root = host.root()
  t.disabled = !root || !p
  q<HTMLButtonElement>('.reader-ai-points').disabled = q<HTMLButtonElement>('.reader-ai-relate').disabled = !p
  if (!p) return
  const file = notesPath(p.key)
  q('.reader-notes-file').textContent = root ? `📝 ${file}` : '📝 Notes'
  q('.reader-notes-file').title = root ? 'Saved in the project as you type. Click to open it in the editor.' : ''
  if (!root) {
    t.value = ''
    t.placeholder = 'Open a project to keep notes on this paper (they’re saved in its notes folder).'
    return
  }
  template = `# ${p.title}\n\n`
  t.value = host.fileExists(file) ? await host.fileText(file) : template
}

/** Write the note to the project (nothing is written for a note that is still just its title). */
export async function saveNotes() {
  clearTimeout(saveTimer)
  if (!paper || !host?.root()) return
  const file = notesPath(paper.key)
  const value = text().value
  if (!host.fileExists(file) && (value === template || !value.trim())) return
  if (host.fileExists(file) && (await host.fileText(file)) === value) return
  await host.applyFileText(file, value)
}

/** Put a quote from the PDF at the end of the note, with its page number. */
export function addQuote(quote: string, page: number | null) {
  const t = text()
  if (t.disabled) return
  const clean = quote
    .replace(/(\w)-\s*\n\s*(\w)/g, '$1$2') // a word split across lines
    .replace(/\s+/g, ' ')
    .trim()
  if (!clean) return
  t.value = `${t.value.replace(/\s*$/, '')}\n\n> ${clean}${page ? ` (p. ${page})` : ''}\n\n`
  t.scrollTop = t.scrollHeight
  void saveNotes()
}

const PAPER_CHARS = 40000
const DOC_CHARS = 30000

/** The paper's text for the AI, or null (with a reason shown) when there's none. */
async function paperText() {
  if (!(await featureReady('review'))) {
    status('No AI model is set up yet. Open ⚙ (AI settings) to pick one.')
    return null
  }
  const got = await viewer?.text(PAPER_CHARS)
  if (!got?.total) {
    status('There’s no PDF open for the AI to read. Open its page or choose a PDF above first.')
    return null
  }
  if (!got.text.replace(/\[page \d+\]/g, '').trim()) {
    status('This PDF has no text the AI can read (it may be a scan).')
    return null
  }
  return { ...got, note: got.pages < got.total ? `\n\n_(From the first ${got.pages} of ${got.total} pages.)_` : '' }
}

/** Stream the AI's answer into the note under a heading, then save it. */
async function draft(heading: string, system: string, prompt: string, footer: string) {
  const t = text()
  const base = `${t.value.replace(/\s*$/, '')}\n\n## ${heading} (AI draft: check it against the paper)\n\n`
  t.readOnly = true
  q('.reader-ai-stop').hidden = false
  q<HTMLButtonElement>('.reader-ai-points').disabled = q<HTMLButtonElement>('.reader-ai-relate').disabled = true
  status('The AI is writing…')
  const r = runAi({ feature: 'review', system, maxTokens: 1500, messages: [{ role: 'user', content: prompt }] }, (_c, soFar) => {
    t.value = base + soFar
    t.scrollTop = t.scrollHeight
  })
  job = r
  try {
    const res = await r.result
    t.value = `${base}${res.text.trim()}${footer}\n`
    status('')
  } catch (e) {
    status(`The AI stopped: ${String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`)
  } finally {
    job = null
    t.readOnly = false
    q('.reader-ai-stop').hidden = true
    q<HTMLButtonElement>('.reader-ai-points').disabled = q<HTMLButtonElement>('.reader-ai-relate').disabled = false
    await saveNotes()
  }
}

const SYSTEM =
  'You help a student understand research papers. Use only the texts given, never outside knowledge. Write plain, clear English for someone new to the field. Answer in Markdown, without a top-level heading.'

async function keyPoints() {
  if (!paper || job) return
  const p = await paperText()
  if (!p) return
  await draft(
    'Key points',
    SYSTEM,
    `The paper "${paper.title}" (its text, with [page N] markers):\n\n${p.text}\n\n` +
      'Write its key points as short bullet lists under these headings: ### Question, ### Method, ### Findings, ### Limitations. ' +
      'Then ### Words to know: up to five technical terms from the paper, each with a one-line meaning. ' +
      'After each point, give the page it comes from, like (p. 3).',
    p.note
  )
}

async function relate() {
  if (!paper || job) return
  const main = host.mainFile()
  if (!main) {
    status('Open the project you’re writing first: the AI compares the paper with it.')
    return
  }
  const p = await paperText()
  if (!p) return
  let doc = ''
  for (const f of [main, ...host.files().map(f => f.path).filter(f => /\.tex$/i.test(f) && f !== main)]) {
    if (doc.length > DOC_CHARS) break
    doc += `\nFile ${f}:\n${(await host.fileText(f)).slice(0, DOC_CHARS - doc.length)}\n`
  }
  const cite = `\\${await citeCommandFor(host)}{${paper.key}}`
  const cited = doc.includes(paper.key)
  await draft(
    'How it relates to my work',
    SYSTEM,
    `My document (LaTeX):\n${doc}\n\nThe paper I'm reading, "${paper.title}" (its text, with [page N] markers):\n\n${p.text}\n\n` +
      'First work out what kind of document mine is (for example a research paper, review article, lab report, essay or thesis) from its content. Then write:\n' +
      '### My document: one line saying what kind of document it is and what it is about.\n' +
      '### How the paper connects: two to four bullets.\n' +
      `### Where to use it: for each place in my document where the paper supports, contradicts or adds to what I wrote, quote a few words of my sentence so I can find it, say which of the three it is and why, give the paper's page, and show the citation to add (${cite}). ` +
      'For a lab report, also say where my method or results can be compared with the paper’s.\n' +
      (cited ? `My document already cites this paper (${paper.key}): say whether those sentences describe the paper accurately.\n` : '') +
      '### Worth adding: up to three points from the paper my document doesn’t cover yet, if they fit its topic.\n' +
      'If the paper and my document are unrelated, say so plainly instead.',
    p.note
  )
}
