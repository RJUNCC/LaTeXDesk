// The Library tab: your Zotero library, shown by Zotero folder or as this project's papers (search, cite with one
// click, or tick several to cite or add together), and "Ask my library", which answers
// questions from the PDFs in Zotero using local embeddings + the local model, citing the papers it used.
import { featureReady, runAi } from './ai-client'
import type { AppHost } from './host'
import { panelEl, whenShown } from './panels'
import { BibEntry, bibEntries } from './bib-project'
import { plain } from './bib-sources'
import { openPaper } from './paper-reader'
import { Passage, ZFolder, ZItem, ZStorage, authorLine, citeCommandFor, citeFromZotero, ensureInBib, insertCite, libraryItems, mayHavePdf, onLibraryChange, refreshLibrary, saveToZotero, zotero, zoteroItemFor, zoteroStatus } from './zotero-client'

let host: AppHost
let asking: { cancel: () => void } | null = null
const $ = <T extends HTMLElement>(sel: string) => panelEl('library').querySelector<T>(sel)!

export function initLibrary(h: AppHost) {
  host = h
  panelEl('library').innerHTML = `
    <div class="lib-body">
      <div class="lib-status muted"></div>
      <div class="lib-storage muted"></div>
      <section class="rs-section">
        <h4>Ask my library</h4>
        <div class="rs-row">
          <textarea class="lib-q" rows="2" placeholder="e.g. Which papers model vaccination in SEIR models, and what do they assume?"></textarea>
          <button class="primary lib-ask">Ask</button>
        </div>
        <div class="lib-index muted"></div>
        <div class="lib-answer"></div>
      </section>
      <section class="rs-section">
        <h4>Your library</h4>
        <div class="rs-row lib-filter">
          <select class="lib-folder" aria-label="Show papers from"></select>
          <input class="lib-search" placeholder="Search: title, author, year or citation key">
        </div>
        <div class="lib-remembered muted"></div>
        <div class="lib-bulk" hidden>
          <span class="lib-bulk-count"></span>
          <button class="primary lib-cite-selected" title="One \\cite{…} with all of them, at the cursor">Cite together</button>
          <button class="lib-add-selected" title="Add them to the project's .bib without citing yet">Add to project</button>
          <button class="lib-clear">Clear</button>
        </div>
        <div class="lib-results"></div>
      </section>
    </div>`
  $<HTMLInputElement>('.lib-search').oninput = () => renderResults()
  $<HTMLSelectElement>('.lib-folder').onchange = ev => void choose((ev.target as HTMLSelectElement).value)
  $('.lib-cite-selected').onclick = () => void citeSelected(true)
  $('.lib-add-selected').onclick = () => void citeSelected(false)
  $('.lib-clear').onclick = () => (selected.clear(), renderResults())
  host.onProjectOpened(() => void projectOpened())
  // a compile or a cite can change which papers the project uses
  host.onCompiled(() => void refreshProject())
  $('.lib-ask').onclick = () => (asking ? stop() : void ask())
  $<HTMLTextAreaElement>('.lib-q').onkeydown = ev => {
    if (ev.key === 'Enter' && !ev.shiftKey) (ev.preventDefault(), void ask())
  }
  zotero.onIndexProgress(p => ($('.lib-index').textContent = `Indexing your library… ${p.done} papers (${p.title.slice(0, 50)})`))
  onLibraryChange(() => (matchProject(), renderFolders(), renderResults()))
  whenShown('library', () => void show())
}

async function show() {
  const st = await zoteroStatus(true)
  const el = $('.lib-status')
  if (!st.running) el.textContent = 'Zotero is not running. Start Zotero to search and cite your library.'
  else if (!st.betterBibtex) el.textContent = 'Zotero is running, but the Better BibTeX plugin is not installed.'
  else if (!st.localApi) el.textContent = 'Turn on Zotero → Settings → Advanced → "Allow other applications on this computer to communicate with Zotero" for Ask my library.'
  else el.textContent = ''
  zotero.storage().then(showStorage, () => ($('.lib-storage').textContent = ''))
  await refreshLibrary()
  if (st.localApi) folders = await zotero.collections().catch(() => folders)
  renderFolders()
  if (currentFolder() && !folderItems) await choose(view, false)
  renderResults()
}

// ---------- which papers are shown: all, this project's, or one of your Zotero folders ----------

let folders: ZFolder[] = []
/** 'all', 'project', or a Zotero collection key */
let view = 'all'
/** item keys in the chosen folder and its subfolders */
let folderItems: Set<string> | null = null
/** citation keys in the project's .bib files */
let projectKeys = new Set<string>()
let projectEntries: BibEntry[] = []
/** Zotero item key → the key the project cites that paper by (Zotero's own key can differ: see zoteroItemFor) */
let projectByItem = new Map<string, string>()
const inProject = (i: ZItem) => projectByItem.has(i.itemKey)
const selected = new Set<string>()

type ViewSettings = { libraryViews?: Record<string, string> }
const settingsBridge = (window as unknown as { texdesk: { getSettings(): Promise<ViewSettings>; setSettings(p: ViewSettings): Promise<void> } }).texdesk

const currentFolder = () => folders.find(f => f.key === view)

/** The folder and everything under it (Zotero shows subfolders' papers in a parent folder too). */
function withSubfolders(key: string): string[] {
  return [key, ...folders.filter(f => f.parent === key).flatMap(f => withSubfolders(f.key))]
}

async function refreshProject() {
  const entries: Map<string, BibEntry> = await bibEntries(host).catch(() => new Map())
  projectKeys = new Set(entries.keys())
  projectEntries = [...entries.values()]
  matchProject()
  if (panelEl('library').offsetParent) renderResults()
}

function matchProject() {
  projectByItem = new Map()
  for (const e of projectEntries) {
    const z = zoteroItemFor(e.key, e.fields)
    if (z) projectByItem.set(z.itemKey, e.key)
  }
}

/** The key to cite a Zotero paper by: the project's own key when the project already has it. */
const keyFor = (i: ZItem) => projectByItem.get(i.itemKey) ?? i.citekey

/** A project opens on the view last used with it, else on its own papers if it has any. */
async function projectOpened() {
  selected.clear()
  folderItems = null
  await refreshProject()
  const root = host.root()
  const saved = root ? (await settingsBridge.getSettings()).libraryViews?.[root] : undefined
  view = saved ?? (projectKeys.size ? 'project' : 'all')
  renderFolders()
  if (panelEl('library').offsetParent) await choose(view, false)
}

async function choose(v: string, remember = true) {
  view = v
  folderItems = null
  renderFolders()
  if (currentFolder()) {
    $('.lib-results').replaceChildren(Object.assign(document.createElement('div'), { className: 'muted', textContent: 'Loading the folder…' }))
    try {
      folderItems = new Set((await Promise.all(withSubfolders(v).map(k => zotero.collectionItems(k)))).flat())
    } catch (e) {
      folderItems = new Set()
      host.setStatus(`Couldn’t read that Zotero folder: ${(e as Error).message}`, 'error')
    }
  }
  const root = host.root()
  if (remember && root) {
    const views = (await settingsBridge.getSettings()).libraryViews ?? {}
    await settingsBridge.setSettings({ libraryViews: { ...views, [root]: v } })
  }
  renderResults()
}

function renderFolders() {
  const select = $<HTMLSelectElement>('.lib-folder')
  const options: HTMLOptionElement[] = [new Option(`All papers (${libraryItems().length})`, 'all'), new Option(`This project (${projectEntries.length})`, 'project')]
  // folders as a tree, indented under their parents
  const add = (parent: string | null, depth: number) => {
    for (const f of folders.filter(f => f.parent === parent).sort((a, b) => a.name.localeCompare(b.name))) {
      options.push(new Option(`${' '.repeat(depth)}${depth ? '└ ' : '📁 '}${f.name}`, f.key))
      add(f.key, depth + 1)
    }
  }
  add(null, 0)
  select.replaceChildren(...options)
  select.value = options.some(o => o.value === view) ? view : 'all'
  const root = host.root()
  $('.lib-remembered').textContent = root && currentFolder() ? `This project opens the Library on “${currentFolder()!.name}”.` : ''
}

function matches(i: ZItem, q: string) {
  const hay = `${i.citekey} ${i.title} ${i.authors.join(' ')} ${i.year ?? ''}`.toLowerCase()
  return q.toLowerCase().split(/\s+/).filter(Boolean).every(w => hay.includes(w))
}

/** Cite the ticked papers together (one \cite{a,b}), or only add them to the project's .bib. */
async function citeSelected(cite: boolean) {
  const keys = [...selected].map(k => {
    const i = libraryItems().find(i => i.citekey === k)
    return i ? keyFor(i) : k
  })
  if (!keys.length) return
  if (cite) insertCite(host, keys.join(','), await citeCommandFor(host))
  const added = await ensureInBib(host, keys.filter(k => !projectKeys.has(k)))
  host.setStatus(
    cite
      ? `Cited ${keys.length} paper${keys.length === 1 ? '' : 's'}${added.length ? `, ${added.length} added to the bibliography` : ''}`
      : added.length
        ? `Added ${added.length} paper${added.length === 1 ? '' : 's'} to the project’s bibliography`
        : 'Those papers are already in the project’s bibliography',
    'ok'
  )
  selected.clear()
  await refreshProject()
  renderFolders()
  renderResults()
}

const mb = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1073741824).toFixed(1)} GB` : `${Math.round(bytes / 1048576)} MB`)

/** Where the PDFs live, and a warning before Zotero's free 300 MB of file sync runs out. */
function showStorage(s: ZStorage) {
  const el = $('.lib-storage')
  const free = s.freeBytes != null ? ` · ${mb(s.freeBytes)} free on that drive` : ''
  el.textContent = `${s.files} attachment files (${mb(s.bytes)}) in ${s.dataDir}${free} · file sync ${s.fileSync ? 'on' : 'off'}`
  el.classList.toggle('lib-warn', s.fileSync && s.bytes > 250 * 1048576)
  if (s.fileSync && s.bytes > 250 * 1048576)
    el.textContent += ". You're close to Zotero's free 300 MB of file sync. Turn off “Sync attachment files” in Zotero → Settings → Sync to keep the PDFs on this PC only (paper info still syncs, free and unlimited)."
}

function renderResults() {
  if (!host) return
  const q = $<HTMLInputElement>('.lib-search').value
  const list = $('.lib-results')
  renderBulk()
  if (!libraryItems().length && view !== 'project') return list.replaceChildren(Object.assign(document.createElement('div'), { className: 'muted', textContent: 'Your Zotero library will appear here.' }))
  const folder = currentFolder()
  const pool = view === 'project' ? libraryItems().filter(inProject) : folder ? libraryItems().filter(i => folderItems?.has(i.itemKey)) : libraryItems()
  const found = q.trim() ? pool.filter(i => matches(i, q)) : pool
  const where = view === 'project' ? 'in this project' : folder ? `in ${folder.name}` : 'in your library'
  let count = q.trim() ? `${found.length} match${found.length === 1 ? '' : 'es'} ${where}` : `${pool.length} paper${pool.length === 1 ? '' : 's'} ${where}`
  // the project's own sources that aren't in Zotero, so This project lists all of its papers
  const outside = view === 'project' ? projectEntries.filter(e => !zoteroItemFor(e.key, e.fields)) : []
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  const outsideFound = outside.filter(e => words.every(w => `${e.key} ${plain(e.fields.title)} ${plain(e.fields.author)} ${e.fields.year ?? ''}`.toLowerCase().includes(w)))
  if (view === 'project')
    count = `${q.trim() ? `${found.length + outsideFound.length} matches` : `${pool.length + outside.length} papers`} in this project${outside.length ? ` · ${outside.length} not in Zotero yet` : ''}`
  const rows: HTMLElement[] = found.slice(0, 100).map(item)
  if (outsideFound.length) rows.push(Object.assign(document.createElement('h5'), { className: 'lib-outside-head', textContent: 'Not in your Zotero library yet' }), ...outsideFound.map(projectSource))
  // nothing here: offer the same search over the whole library
  if (q.trim() && !found.length && view !== 'all') {
    const elsewhere = libraryItems().filter(i => matches(i, q)).length
    if (elsewhere) {
      const all = button(`Search all papers (${elsewhere} match${elsewhere === 1 ? '' : 'es'})`, () => void choose('all', false), 'lib-search-all')
      rows.push(all)
    }
  }
  if (!pool.length && !outside.length) {
    const empty = view === 'project' ? 'No papers from Zotero in this project yet. Cite one, or tick some and click Add to project.' : folder ? 'This folder is empty.' : ''
    if (empty) rows.push(Object.assign(document.createElement('div'), { className: 'muted lib-empty', textContent: empty }))
  }
  list.replaceChildren(Object.assign(document.createElement('div'), { className: 'muted lib-count', textContent: count }), ...rows)
}

function renderBulk() {
  $('.lib-bulk').hidden = selected.size === 0
  $('.lib-bulk-count').textContent = `${selected.size} selected`
}

function item(i: ZItem) {
  const div = document.createElement('div')
  div.className = `rs-paper lib-item${selected.has(i.citekey) ? ' selected' : ''}`
  const tick = Object.assign(document.createElement('input'), { type: 'checkbox', checked: selected.has(i.citekey), className: 'lib-tick', title: 'Select, to cite or add several at once' })
  tick.setAttribute('aria-label', `Select ${i.title}`)
  // only this row and the bar change, so the list keeps its scroll position while you tick down it
  tick.onchange = () => {
    if (tick.checked) selected.add(i.citekey)
    else selected.delete(i.citekey)
    div.classList.toggle('selected', tick.checked)
    renderBulk()
  }
  const body = document.createElement('div')
  body.className = 'lib-item-body'
  const title = Object.assign(document.createElement('div'), { className: 'rs-title', textContent: i.title })
  if (view !== 'project' && inProject(i)) title.append(Object.assign(document.createElement('span'), { className: 'lib-in-project', textContent: 'in project' }))
  const meta = Object.assign(document.createElement('div'), { className: 'muted rs-meta', textContent: `${authorLine(i)} · ` })
  meta.append(Object.assign(document.createElement('code'), { textContent: i.citekey }))
  const acts = document.createElement('div')
  acts.className = 'rs-row'
  acts.append(
    button('Cite', () => void cite(i), 'primary'),
    button('📄 Read', () => void openPaper({ key: keyFor(i), title: i.title, fields: { doi: i.doi ?? '', url: i.url ?? '' }, zoteroItemKey: i.itemKey })),
    button('Show in Zotero', () => window.open(`zotero://select/library/items/${i.itemKey}`))
  )
  body.append(title, meta, acts)
  div.append(tick, body)
  return div
}

/** Cite a library paper: by the project's key when the project already has it under another one. */
async function cite(i: ZItem) {
  const key = keyFor(i)
  if (projectKeys.has(key)) {
    insertCite(host, key, await citeCommandFor(host))
    host.setStatus(`Cited ${key}`, 'ok')
  } else await citeFromZotero(host, key)
  await refreshProject()
  renderFolders()
}

/** One of the project's sources that isn't in Zotero: cite it, save it there, or read it. */
function projectSource(e: BibEntry) {
  const div = document.createElement('div')
  div.className = 'rs-paper lib-item lib-outside'
  const body = document.createElement('div')
  body.className = 'lib-item-body'
  const authors = plain(e.fields.author)
    .split(/\s+and\s+/)
    .filter(Boolean)
    .map(a => (a.includes(',') ? a.split(',')[0] : a.split(' ').pop()!))
  const meta = Object.assign(document.createElement('div'), { className: 'muted rs-meta', textContent: `${authorLine({ authors, year: Number(e.fields.year?.match(/\d{4}/)?.[0]) || null })} · ` })
  meta.append(Object.assign(document.createElement('code'), { textContent: e.key }))
  const acts = document.createElement('div')
  acts.className = 'rs-row'
  const save = button('Save to Zotero', async () => {
    save.disabled = true
    save.textContent = 'Saving…'
    try {
      host.setStatus(await saveToZotero(e), 'ok')
    } catch (err) {
      save.disabled = false
      save.textContent = 'Save to Zotero'
      host.setStatus(`Couldn't save to Zotero: ${(err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`, 'error')
    }
  })
  acts.append(button('Cite', async () => (insertCite(host, e.key, await citeCommandFor(host)), host.setStatus(`Cited ${e.key}`, 'ok')), 'primary'), save)
  if (mayHavePdf(e.fields)) acts.append(button('📄 Read', () => void openPaper({ key: e.key, title: plain(e.fields.title) || e.key, fields: e.fields })))
  body.append(Object.assign(document.createElement('div'), { className: 'rs-title', textContent: plain(e.fields.title) || e.key }), meta, acts)
  div.append(body)
  return div
}

function stop() {
  asking?.cancel()
  asking = null
  $('.lib-ask').textContent = 'Ask'
}

async function ask() {
  const question = $<HTMLTextAreaElement>('.lib-q').value.trim()
  if (!question || asking) return
  const out = $('.lib-answer')
  const idx = $('.lib-index')
  if (!(await zoteroStatus(true)).localApi) return void (idx.textContent = 'Zotero (with the local API on) must be running.')
  if (!(await featureReady('review'))) return void (idx.textContent = 'Pick a model for "Review, chat" in ⚙ (AI settings).')

  out.replaceChildren()
  idx.textContent = 'Finding relevant passages…'
  let found: { passages: Passage[]; method: string }
  try {
    found = await zotero.retrieve(question, 8)
  } catch (e) {
    idx.textContent = `⚠ ${(e as Error).message}`
    return
  }
  if (!found.passages.length) return void (idx.textContent = 'No readable PDFs found in your Zotero library yet.')
  idx.textContent = `Answering from ${new Set(found.passages.map(p => p.citekey)).size} papers (${found.method === 'embeddings' ? 'semantic search' : 'keyword search'})…`

  const context = found.passages.map((p, n) => `[${p.citekey}] (${p.title}, ${p.year ?? 'n.d.'}), passage ${n + 1}:\n${p.text}`).join('\n\n')
  const answer = document.createElement('div')
  answer.className = 'ai-msg assistant lib-answer-text streaming'
  out.append(answer)
  $('.lib-ask').textContent = 'Stop'
  const job = runAi(
    {
      feature: 'review',
      system:
        'You answer questions using ONLY the passages provided from the user\'s own paper library. ' +
        'Cite every claim with the citation key in square brackets, e.g. [smith2020model]. ' +
        'If the passages do not answer the question, say so plainly. Be concise.',
      messages: [{ role: 'user', content: `Passages:\n\n${context}\n\nQuestion: ${question}` }],
      maxTokens: 1500,
    },
    (_c, soFar) => (answer.textContent = soFar)
  )
  asking = job
  try {
    const r = await job.result
    answer.dataset.meta = `${r.model}${r.usage.output ? ` · ${r.usage.output} tokens` : ''}`
    idx.textContent = ''
  } catch (e) {
    const msg = (e as Error).message
    answer.textContent = /abort/i.test(msg) ? '(stopped)' : `⚠ ${msg}`
  } finally {
    answer.classList.remove('streaming')
    asking = null
    $('.lib-ask').textContent = 'Ask'
  }
  out.append(sources(found.passages, answer.textContent ?? ''))
}

/** The papers behind the answer, those it actually cited first, each with Cite / Show. */
function sources(passages: Passage[], answer: string) {
  const byKey = new Map<string, Passage[]>()
  for (const p of passages) byKey.set(p.citekey, [...(byKey.get(p.citekey) ?? []), p])
  const keys = [...byKey.keys()].sort((a, b) => Number(answer.includes(`[${b}`)) - Number(answer.includes(`[${a}`)))
  const box = document.createElement('div')
  box.className = 'lib-sources'
  box.append(Object.assign(document.createElement('h4'), { textContent: 'Sources' }))
  for (const key of keys) {
    const ps = byKey.get(key)!
    const used = answer.includes(`[${key}`) || answer.includes(`${key}]`) || answer.includes(`${key},`)
    const card = document.createElement('div')
    card.className = `lib-source${used ? ' used' : ''}`
    const head = Object.assign(document.createElement('div'), { className: 'rs-title' })
    head.append(Object.assign(document.createElement('code'), { textContent: key }), ` ${ps[0].title} (${ps[0].year ?? 'n.d.'})`)
    const snippet = Object.assign(document.createElement('div'), { className: 'rs-abstract', textContent: ps[0].text, title: 'Click to expand' })
    snippet.onclick = () => snippet.classList.toggle('open')
    const z = libraryItems().find(i => i.citekey === key)
    const acts = document.createElement('div')
    acts.className = 'rs-row'
    acts.append(button('Cite', () => void citeFromZotero(host, key), 'primary'))
    if (z) acts.append(button('Show in Zotero', () => window.open(`zotero://select/library/items/${z.itemKey}`)))
    if (!used) acts.append(Object.assign(document.createElement('span'), { className: 'muted', textContent: 'retrieved, not cited in the answer' }))
    card.append(head, snippet, acts)
    box.append(card)
  }
  return box
}

function button(label: string, onClick: () => void, cls = '') {
  const b = document.createElement('button')
  b.textContent = label
  b.className = cls
  b.onclick = onClick
  return b
}
