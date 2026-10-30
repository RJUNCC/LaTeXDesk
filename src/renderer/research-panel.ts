// The Research tab: citation creator (DOI / arXiv / ISBN / URL → BibTeX + \cite), paper search,
// and Screenshot → LaTeX (vision model).
import katex from 'katex'
import { featureReady, runAi } from './ai-client'
import { insertRawBlock } from './format'
import type { AppHost } from './host'
import { panelEl, showPanel } from './panels'
import { addEntries, bibEntries, bibTarget } from './bib-project'
import { citeFromZotero, insertCite, libraryItems, refreshLibrary, zotero, zoteroStatus } from './zotero-client'

type Cited = { key: string; kind: string; type: string; bibtex: string; fields: Record<string, string> }
type Paper = {
  title: string
  authors: string[]
  year: number | null
  venue?: string
  abstract?: string
  citations?: number | null
  doi?: string
  arxiv?: string
  url?: string
  source: string
}
type ResearchBridge = { cite(input: string): Promise<Cited>; search(q: string): Promise<Paper[]> }
const research = (window as unknown as { texdesk: { research: ResearchBridge } }).texdesk.research

let host: AppHost
const $ = <T extends HTMLElement>(sel: string) => panelEl('research').querySelector<T>(sel)!

export function initResearch(h: AppHost) {
  host = h
  panelEl('research').innerHTML = `
    <div class="research-body">
      <section class="rs-section">
        <h4>Add a citation</h4>
        <div class="rs-row">
          <input class="rs-cite-input" placeholder="DOI, arXiv id, ISBN or URL, e.g. 10.1103/PhysRev.47.777">
          <button class="primary rs-cite-btn">Look up</button>
        </div>
        <div class="rs-cite-out"></div>
      </section>
      <section class="rs-section">
        <h4>Search papers <span class="muted rs-source"></span></h4>
        <div class="rs-row">
          <input class="rs-search-input" placeholder="Topic, title or author">
          <button class="rs-search-btn">Search</button>
        </div>
        <div class="rs-results"></div>
      </section>
      <section class="rs-section">
        <h4>Screenshot → LaTeX</h4>
        <div class="rs-drop" tabindex="0">Paste (Ctrl+V) or drop an image of an equation, matrix or table here.<br>
          <span class="muted">You can also paste an image straight into the editor.</span></div>
        <div class="rs-vision-out"></div>
      </section>
    </div>`

  const citeInput = $<HTMLInputElement>('.rs-cite-input')
  $('.rs-cite-btn').onclick = () => void lookup(citeInput.value)
  citeInput.onkeydown = ev => ev.key === 'Enter' && void lookup(citeInput.value)
  const searchInput = $<HTMLInputElement>('.rs-search-input')
  $('.rs-search-btn').onclick = () => void search(searchInput.value)
  searchInput.onkeydown = ev => ev.key === 'Enter' && void search(searchInput.value)

  const drop = $('.rs-drop')
  drop.onpaste = ev => {
    const file = imageFrom(ev.clipboardData)
    if (file) (ev.preventDefault(), void imageToLatex(file))
  }
  drop.ondragover = ev => (ev.preventDefault(), drop.classList.add('over'))
  drop.ondragleave = () => drop.classList.remove('over')
  drop.ondrop = ev => {
    ev.preventDefault()
    drop.classList.remove('over')
    const file = imageFrom(ev.dataTransfer)
    if (file) void imageToLatex(file)
  }
}

/** For the editor's paste handler: an image with no text means "convert this screenshot". */
export function imageFrom(data: DataTransfer | null) {
  if (!data) return null
  if (data.getData('text/plain')) return null
  return [...data.files].find(f => f.type.startsWith('image/')) ?? null
}

// ---------- citations ----------

/** An entry already in the project's .bib files, or in Zotero, matching by DOI, arXiv id or key. */
async function findExisting(c: Cited) {
  const doi = c.fields.doi?.toLowerCase()
  const eprint = c.fields.eprint?.toLowerCase()
  for (const e of (await bibEntries(host)).values()) {
    const f = e.fields
    if (e.key === c.key || (doi && f.doi?.toLowerCase() === doi) || (eprint && (f.eprint?.toLowerCase() === eprint || f.doi?.toLowerCase().endsWith(eprint))))
      return { key: e.key, where: e.file }
  }
  if ((await zoteroStatus()).betterBibtex) {
    // a fresh copy: the paper may have been added to Zotero a moment ago
    await refreshLibrary(true)
    const z = libraryItems().find(i => (doi && i.doi?.toLowerCase() === doi) || (eprint && i.doi?.toLowerCase().endsWith(eprint)))
    if (z) return { key: z.citekey, where: 'your Zotero library' }
  }
  return null
}

async function lookup(input: string) {
  const out = $('.rs-cite-out')
  if (!input.trim()) return
  out.textContent = 'Looking up…'
  out.className = 'rs-cite-out muted'
  try {
    const c = await research.cite(input)
    const existing = await findExisting(c)
    const zoteroOn = (await zoteroStatus()).betterBibtex
    out.className = 'rs-cite-out'
    const pre = document.createElement('pre')
    pre.className = 'rs-bib'
    pre.textContent = c.bibtex
    const actions = document.createElement('div')
    actions.className = 'rs-row'
    if (existing) {
      const note = document.createElement('span')
      note.className = 'muted'
      note.textContent = `Already in ${existing.where} as “${existing.key}”.`
      actions.append(note, button('Cite it', () => void citeFromZotero(host, existing.key), 'primary'))
    } else if (zoteroOn) {
      // with Zotero: save it there first so the key is Better BibTeX's and the paper is in your library
      actions.append(
        button('Save to Zotero & cite', () => void saveAndCite(c), 'primary'),
        button('Cite without saving', () => void addCitation(c)),
        button('Copy BibTeX', () => navigator.clipboard.writeText(c.bibtex))
      )
    } else {
      actions.append(button(`Add to bibliography & cite`, () => void addCitation(c), 'primary'), button('Copy BibTeX', () => navigator.clipboard.writeText(c.bibtex)))
    }
    out.replaceChildren(pre, actions)
  } catch (e) {
    out.className = 'rs-cite-out error'
    out.textContent = (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
  }
}

function citeDone(note: string) {
  $('.rs-cite-out').replaceChildren(Object.assign(document.createElement('div'), { className: 'muted', textContent: `✓ ${note}` }))
  $<HTMLInputElement>('.rs-cite-input').value = ''
  host.setStatus(note, 'ok')
}

async function addCitation(c: Cited) {
  const added = await addEntries(host, c.bibtex)
  insertCite(host, c.key)
  const { file } = await bibTarget(host)
  citeDone(added.length ? `Added “${c.key}” to ${file} and cited it` : `Cited “${c.key}”`)
}

async function saveAndCite(c: Cited) {
  $('.rs-cite-out').textContent = 'Saving to Zotero…'
  try {
    const item = await zotero.save({ entryType: c.type, fields: c.fields })
    await refreshLibrary(true)
    await citeFromZotero(host, item.citekey)
    citeDone(`Saved to Zotero as “${item.citekey}” and cited it`)
  } catch (e) {
    $('.rs-cite-out').textContent = `Couldn't save to Zotero: ${(e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`
  }
}

/** Save a search result straight to Zotero (looks the paper up first for full metadata). */
async function saveResult(id: string, btn: HTMLButtonElement) {
  btn.disabled = true
  btn.textContent = 'Saving…'
  try {
    const c = await research.cite(id)
    const existing = await findExisting(c)
    if (existing) {
      btn.textContent = `In ${existing.where === 'your Zotero library' ? 'Zotero' : 'project'} ✓`
      return
    }
    const item = await zotero.save({ entryType: c.type, fields: c.fields })
    await refreshLibrary(true)
    btn.textContent = `Saved ✓ (${item.citekey})`
  } catch (e) {
    btn.textContent = 'Save failed'
    btn.title = (e as Error).message
    btn.disabled = false
  }
}

// ---------- search ----------

async function search(query: string) {
  const list = $('.rs-results')
  if (!query.trim()) return
  list.replaceChildren(Object.assign(document.createElement('div'), { className: 'muted', textContent: 'Searching…' }))
  try {
    const papers = await research.search(query)
    $('.rs-source').textContent = papers[0] ? `via ${papers[0].source}` : ''
    list.replaceChildren(...(papers.length ? papers.map(paperCard) : [Object.assign(document.createElement('div'), { className: 'muted', textContent: 'No results.' })]))
  } catch (e) {
    list.replaceChildren(Object.assign(document.createElement('div'), { className: 'error', textContent: (e as Error).message }))
  }
}

function paperCard(p: Paper) {
  const card = document.createElement('div')
  card.className = 'rs-paper'
  const title = document.createElement('div')
  title.className = 'rs-title'
  title.textContent = p.title
  const meta = document.createElement('div')
  meta.className = 'muted rs-meta'
  const authors = p.authors.length > 3 ? `${p.authors.slice(0, 3).join(', ')} et al.` : p.authors.join(', ')
  meta.textContent = [authors, p.year, p.venue, p.citations != null ? `${p.citations} citations` : ''].filter(Boolean).join(' · ')
  const abs = document.createElement('div')
  abs.className = 'rs-abstract'
  abs.textContent = p.abstract ?? ''
  abs.title = 'Click to expand'
  abs.onclick = () => abs.classList.toggle('open')
  const out = document.createElement('div')
  out.className = 'rs-summary'
  const id = p.doi || (p.arxiv ? `arXiv:${p.arxiv}` : '')
  const actions = document.createElement('div')
  actions.className = 'rs-row'
  if (id)
    actions.append(
      button('Cite', () => {
        $<HTMLInputElement>('.rs-cite-input').value = id
        void lookup(id)
        $('.rs-cite-input').scrollIntoView({ behavior: 'smooth', block: 'center' })
      }, 'primary')
    )
  if (id) {
    const save = button('Save to Zotero', () => void saveResult(id, save))
    void zoteroStatus().then(st => (save.hidden = !st.betterBibtex))
    actions.append(save)
  }
  if (p.url) actions.append(button('Open', () => window.open(p.url)))
  if (p.abstract) actions.append(button('Summarize', () => void summarize(p, out)))
  card.append(title, meta, abs, actions, out)
  return card
}

async function summarize(p: Paper, out: HTMLElement) {
  if (!(await featureReady('review'))) {
    out.textContent = 'Pick a model in ⚙ (AI settings) to summarize.'
    return
  }
  out.textContent = '…'
  const job = runAi(
    {
      feature: 'review',
      messages: [
        {
          role: 'user',
          content: `Summarize this paper for a researcher deciding whether to read it. Three short bullet points: the question, the method, the key finding. Only use the abstract.\n\nTitle: ${p.title}\n\nAbstract: ${p.abstract}`,
        },
      ],
      maxTokens: 400,
    },
    (_c, soFar) => (out.textContent = soFar)
  )
  try {
    await job.result
  } catch (e) {
    out.textContent = `⚠ ${(e as Error).message}`
  }
}

// ---------- Screenshot → LaTeX ----------

export async function imageToLatex(file: File) {
  showPanel('research')
  const out = $('.rs-vision-out')
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
  const img = document.createElement('img')
  img.src = dataUrl
  img.className = 'rs-thumb'
  const status = document.createElement('div')
  status.className = 'muted'
  out.replaceChildren(img, status)
  $('.rs-drop').scrollIntoView({ behavior: 'smooth', block: 'center' })
  if (!(await featureReady('vision'))) {
    status.textContent = 'Pick a vision model in ⚙ (AI settings) first.'
    return
  }
  status.textContent = 'Reading the image…'
  const [, mediaType, base64] = (await upscaleForVision(dataUrl)).match(/^data:([^;]+);base64,(.*)$/) ?? []
  try {
    const r = await runAi(
      {
        feature: 'vision',
        images: [{ mediaType, base64 }],
        messages: [
          {
            role: 'user',
            content:
              'Convert this image to LaTeX. Reply with ONLY one ```latex code block, nothing else.\n' +
              '- An equation or matrix: give display math as \\[ ... \\] (pmatrix/bmatrix for matrices, \\begin{array} with | for block matrices).\n' +
              '- A table: a tabular environment.\n- Text: plain LaTeX.',
          },
        ],
        maxTokens: 2000,
      },
      (_c, soFar) => (status.textContent = `Reading the image… ${soFar.length} characters`)
    ).result
    const code = asInsertable((r.text.match(/```(?:latex|tex)?\s*([\s\S]*?)```/)?.[1] ?? r.text).trim())
    showVisionResult(out, img, code)
  } catch (e) {
    status.textContent = `⚠ ${(e as Error).message}`
  }
}

/**
 * Vision models read small screenshots badly; scale anything narrower than ~900px up (crisply,
 * on a white background) before sending it.
 */
async function upscaleForVision(dataUrl: string): Promise<string> {
  const img = new Image()
  img.src = dataUrl
  await img.decode()
  const scale = Math.min(4, Math.max(1, Math.ceil(900 / img.naturalWidth)))
  if (scale === 1) return dataUrl
  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth * scale
  canvas.height = img.naturalHeight * scale
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/png')
}

/** Models sometimes drop the requested \[ … \]: wrap bare math so it can be inserted into text safely. */
/** Preamble lines from a full document the model transcribed; added to the project's preamble on insert. */
let visionPreamble: string[] = []

/** A screenshot of source code comes back as a whole document: keep its body, remember its packages. */
function documentBody(code: string) {
  visionPreamble = []
  const begin = code.indexOf('\\begin{document}')
  if (begin < 0 && !/\\documentclass/.test(code)) return code
  const preamble = begin < 0 ? code : code.slice(0, begin)
  visionPreamble = preamble.match(/^\s*\\(usepackage|usetikzlibrary)\s*(\[[^\]]*\])?\{[^}]+\}/gm)?.map(l => l.trim()) ?? []
  if (begin < 0) return code.replace(/^\s*\\(documentclass|usepackage|usetikzlibrary)\s*(\[[^\]]*\])?\{[^}]+\}.*$/gm, '')
  const end = code.indexOf('\\end{document}', begin)
  return code.slice(begin + '\\begin{document}'.length, end < 0 ? undefined : end)
}

function asInsertable(code: string) {
  const s = documentBody(code).trim()
  if (/^(\\\[|\$\$|\\begin\{(equation|align|gather|multline|table|tabular|figure|itemize|enumerate))/.test(s)) return s
  if (/^\$[^$]/.test(s) && s.endsWith('$')) return `\\[ ${s.slice(1, -1).trim()} \\]`
  const looksMathy = /\\(frac|begin\{[pbvBV]?matrix\}|begin\{array\}|sum|int|sqrt|alpha|beta|cdot|leq|geq|mathbb)|[_^]\{?|=/.test(s)
  const looksTexty = /\\(textbf|section|item)\b/.test(s) || (s.split(/\s+/).length > 12 && !/[\\=_^]/.test(s))
  return looksMathy && !looksTexty ? `\\[\n  ${s.replace(/\n/g, '\n  ')}\n\\]` : s
}

function showVisionResult(out: HTMLElement, img: HTMLImageElement, code: string) {
  const preview = document.createElement('div')
  preview.className = 'rs-preview'
  const edit = document.createElement('textarea')
  edit.className = 'rs-code'
  edit.value = code
  edit.rows = Math.min(14, code.split('\n').length + 1)
  const renderPreview = () => {
    const src = edit.value.trim()
    const math = src.match(/^\\\[([\s\S]*)\\\]$/)?.[1] ?? src.match(/^\$\$([\s\S]*)\$\$$/)?.[1]
    if (math == null) {
      preview.textContent = 'Preview is shown for equations; tables and text appear after you compile.'
      preview.classList.add('muted')
      return
    }
    preview.classList.remove('muted')
    katex.render(math, preview, { displayMode: true, throwOnError: false, strict: 'ignore' })
  }
  edit.oninput = renderPreview
  renderPreview()
  const actions = document.createElement('div')
  actions.className = 'rs-row'
  actions.append(
    button('Insert at cursor', () => {
      const text = edit.value.trim()
      insertRawBlock(host.view, text)
      if (/\\begin\{(p|b|v|B|V)?matrix\}|\\begin\{(align|gather)/.test(text)) host.format.ensurePackage('amsmath')
      // amsmath matrices stop at 10 columns unless MaxMatrixCols is raised
      const widest = Math.max(0, ...[...text.matchAll(/\\begin\{([pbvBV]?matrix)\}([\s\S]*?)\\end\{\1\}/g)].flatMap(m => m[2].split('\\\\').map(row => row.split('&').length)))
      if (widest > 10) host.format.ensurePreamble(`\\setcounter{MaxMatrixCols}{${Math.max(20, widest)}}`, /\\setcounter\s*\{MaxMatrixCols\}/)
      for (const line of visionPreamble) {
        const m = line.match(/\\(usepackage|usetikzlibrary)\s*(?:\[([^\]]*)\])?\{([^}]+)\}/)!
        for (const name of m[3].split(',').map(n => n.trim()).filter(Boolean)) {
          if (m[1] === 'usepackage') host.format.ensurePackage(name, m[2])
          else host.format.ensurePreamble(`\\usetikzlibrary{${name}}`, new RegExp(`\\\\usetikzlibrary\\s*\\{[^}]*\\b${name}\\b`))
        }
      }
      host.setStatus('Inserted LaTeX from the image', 'ok')
    }, 'primary'),
    button('Copy', () => navigator.clipboard.writeText(edit.value))
  )
  out.replaceChildren(img, preview, edit, actions)
}

function button(label: string, onClick: () => void, cls = '') {
  const b = document.createElement('button')
  b.textContent = label
  b.className = cls
  b.onclick = onClick
  return b
}
