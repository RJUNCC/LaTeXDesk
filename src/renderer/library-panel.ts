// The Library tab: your Zotero library (search, cite with one click) and "Ask my library", which answers
// questions from the PDFs in Zotero using local embeddings + the local model, citing the papers it used.
import { featureReady, runAi } from './ai-client'
import type { AppHost } from './host'
import { panelEl, whenShown } from './panels'
import { Passage, ZItem, ZStorage, authorLine, citeFromZotero, libraryItems, onLibraryChange, refreshLibrary, searchLibrary, zotero, zoteroStatus } from './zotero-client'

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
        <h4>Search your library</h4>
        <div class="rs-row"><input class="lib-search" placeholder="Title, author, year or citation key"></div>
        <div class="lib-results"></div>
      </section>
    </div>`
  $<HTMLInputElement>('.lib-search').oninput = () => renderResults()
  $('.lib-ask').onclick = () => (asking ? stop() : void ask())
  $<HTMLTextAreaElement>('.lib-q').onkeydown = ev => {
    if (ev.key === 'Enter' && !ev.shiftKey) (ev.preventDefault(), void ask())
  }
  zotero.onIndexProgress(p => ($('.lib-index').textContent = `Indexing your library… ${p.done} papers (${p.title.slice(0, 50)})`))
  onLibraryChange(renderResults)
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
  const found = searchLibrary(q)
  const list = $('.lib-results')
  if (!libraryItems().length) return list.replaceChildren(Object.assign(document.createElement('div'), { className: 'muted', textContent: 'Your Zotero library will appear here.' }))
  list.replaceChildren(
    Object.assign(document.createElement('div'), { className: 'muted lib-count', textContent: q ? `${found.length} match${found.length === 1 ? '' : 'es'}` : `${libraryItems().length} items` }),
    ...found.slice(0, 60).map(item)
  )
}

function item(i: ZItem) {
  const div = document.createElement('div')
  div.className = 'rs-paper'
  const title = Object.assign(document.createElement('div'), { className: 'rs-title', textContent: i.title })
  const meta = Object.assign(document.createElement('div'), { className: 'muted rs-meta', textContent: `${authorLine(i)} · ` })
  meta.append(Object.assign(document.createElement('code'), { textContent: i.citekey }))
  const acts = document.createElement('div')
  acts.className = 'rs-row'
  acts.append(button('Cite', () => void citeFromZotero(host, i.citekey), 'primary'), button('Show in Zotero', () => window.open(`zotero://select/library/items/${i.itemKey}`)))
  div.append(title, meta, acts)
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
