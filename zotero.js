// Zotero integration (main process), all local:
//  - Better BibTeX JSON-RPC (localhost:23119/better-bibtex/json-rpc): search, citation keys, BibTeX export
//  - Zotero's local API (localhost:23119/api, read-only): attachments, for "Ask my library"
//  - the connector (localhost:23119/connector): saving new items into the library
// "Ask my library" indexes the text Zotero already extracted from each PDF (.zotero-ft-cache) and embeds it
// with a local Ollama model, so nothing leaves the machine.
const fs = require('fs/promises')
const os = require('os')
const path = require('path')
const { fileURLToPath } = require('url')

const BASE = 'http://localhost:23119'
const EMBED_MODEL = 'nomic-embed-text'
const CHUNK = 1200
const OVERLAP = 200
const MAX_CHUNKS_PER_PAPER = 160

async function rpc(method, params, timeout = 15000) {
  const res = await fetch(`${BASE}/better-bibtex/json-rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
    signal: AbortSignal.timeout(timeout),
  })
  if (!res.ok) throw new Error(`Better BibTeX answered HTTP ${res.status}`)
  const data = await res.json()
  if (data.error) throw new Error(data.error.message)
  return data.result
}

async function localApi(pathAndQuery) {
  const res = await fetch(`${BASE}/api/users/0/${pathAndQuery}`, { signal: AbortSignal.timeout(15000) })
  if (res.status === 403) throw new Error('Zotero local API is off (Zotero → Settings → Advanced → "Allow other applications…")')
  if (!res.ok) throw new Error(`Zotero local API answered HTTP ${res.status}`)
  return { data: await res.json(), total: Number(res.headers.get('Total-Results') ?? 0) }
}

/** What's available: Zotero running, local API allowed, Better BibTeX installed. */
async function status() {
  const out = { running: false, localApi: false, betterBibtex: false, version: null }
  try {
    out.running = (await fetch(`${BASE}/connector/ping`, { signal: AbortSignal.timeout(1500) })).ok
  } catch {
    return out
  }
  try {
    const r = await rpc('api.ready', [], 3000)
    out.betterBibtex = true
    out.version = r.zotero
  } catch {}
  try {
    out.localApi = (await fetch(`${BASE}/api/users/0/items/top?limit=1`, { signal: AbortSignal.timeout(3000) })).ok
  } catch {}
  return out
}

/** CSL-JSON from Better BibTeX → a compact record. Attachments and notes (no citation key) are dropped. */
function toRecord(r) {
  const year = r.issued?.['date-parts']?.[0]?.[0] ?? null
  return {
    citekey: r.citekey,
    itemKey: String(r.id || '').split('/').pop(),
    title: r.title ?? '',
    authors: (r.author ?? []).map(a => a.family ?? a.literal ?? '').filter(Boolean),
    year,
    type: r.type,
    doi: r.DOI,
    url: r.URL,
    abstract: r.abstract,
  }
}

async function search(query = '') {
  const results = await rpc('item.search', [query])
  return results.filter(r => r.citekey).map(toRecord)
}

/** BibTeX for the given citation keys, as Better BibTeX exports it. */
async function exportBib(citekeys) {
  if (!citekeys.length) return ''
  return rpc('item.export', [citekeys, 'Better BibTeX'], 30000)
}

// ---------- saving into the library ----------

const ZOTERO_TYPE = { article: 'journalArticle', inproceedings: 'conferencePaper', conference: 'conferencePaper', book: 'book', incollection: 'bookSection', phdthesis: 'thesis', mastersthesis: 'thesis', techreport: 'report' }

const unTeX = s => (s ?? '').replace(/\\url\{([^}]*)\}/g, '$1').replace(/\\([&%$#_{}])/g, '$1').replace(/[{}]/g, '').replace(/\s+/g, ' ').trim()

/** BibTeX-style fields (from the citation creator) → a Zotero item for the connector. */
function toZoteroItem(entryType, f, tag) {
  const itemType = f.eprint && f.archiveprefix?.toLowerCase() === 'arxiv' && !f.journal ? 'preprint' : ZOTERO_TYPE[entryType] ?? (f.url ? 'webpage' : 'document')
  const creators = unTeX(f.author)
    .split(/\s+and\s+/i)
    .filter(Boolean)
    .map(name => {
      if (name.includes(',')) {
        const [lastName, firstName] = name.split(',').map(s => s.trim())
        return { firstName, lastName, creatorType: 'author' }
      }
      const parts = name.split(' ')
      return { firstName: parts.slice(0, -1).join(' '), lastName: parts.at(-1), creatorType: 'author' }
    })
  const item = {
    itemType,
    title: unTeX(f.title),
    creators,
    date: [f.year, f.month].filter(Boolean).join(' '),
    DOI: f.doi,
    url: f.url,
    publicationTitle: unTeX(f.journal || f.booktitle),
    volume: f.volume,
    issue: f.number,
    pages: f.pages?.replace('--', '-'),
    publisher: unTeX(f.publisher),
    ISBN: f.isbn,
    ...(f.eprint ? { archiveID: `arXiv:${f.eprint}`, repository: 'arXiv' } : {}),
    tags: tag ? [{ tag }] : [],
  }
  for (const k of Object.keys(item)) if (item[k] === undefined || item[k] === '') delete item[k]
  return item
}

/** Save a paper to Zotero (into the collection selected in Zotero) and return its Better BibTeX key. */
async function save({ entryType, fields, tag }) {
  const item = toZoteroItem(entryType, fields, tag)
  const res = await fetch(`${BASE}/connector/saveItems`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ ...item, id: `texdesk-${Date.now()}` }], uri: fields.url || (fields.doi ? `https://doi.org/${fields.doi}` : 'texdesk://save'), sessionID: `texdesk-${Date.now()}` }),
    signal: AbortSignal.timeout(20000),
  })
  if (!res.ok && res.status !== 201) throw new Error(`Zotero refused the item (HTTP ${res.status})`)
  // Better BibTeX assigns the key a moment later
  for (let attempt = 0; attempt < 15; attempt++) {
    await new Promise(r => setTimeout(r, 400))
    const hit = await findItem({ doi: fields.doi, title: item.title })
    if (hit) return hit
  }
  throw new Error('Saved to Zotero, but Better BibTeX has not assigned a key yet. Try again in a moment.')
}

/** Find a library item by DOI or exact title. (Better BibTeX's search doesn't index DOIs, so search by title.) */
async function findItem({ doi, title }) {
  const want = doi?.toLowerCase()
  const t = (title ?? '').toLowerCase()
  const hits = await search((title ?? '').split(/\s+/).slice(0, 6).join(' '))
  return hits.find(h => (want && h.doi?.toLowerCase() === want) || (t && h.title?.toLowerCase() === t)) ?? null
}

// ---------- where Zotero keeps its data (read from its prefs, never written) ----------

/** The prefs LaTeXDesk cares about, from the text of a Zotero prefs.js. */
function parsePrefs(text) {
  const pref = name => {
    const m = text.match(new RegExp(`user_pref\\("${name.replace(/\./g, '\\.')}",\\s*("(?:[^"\\\\]|\\\\.)*"|true|false|-?\\d+)\\);`))
    try {
      return m ? JSON.parse(m[1]) : undefined
    } catch {
      return undefined
    }
  }
  return { dataDir: pref('extensions.zotero.dataDir'), useDataDir: pref('extensions.zotero.useDataDir'), fileSync: pref('extensions.zotero.sync.storage.enabled') ?? true }
}

async function zoteroPrefs() {
  const profiles = path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Zotero', 'Zotero', 'Profiles')
  for (const dir of await fs.readdir(profiles).catch(() => [])) {
    const text = await fs.readFile(path.join(profiles, dir, 'prefs.js'), 'utf8').catch(() => null)
    if (text) return parsePrefs(text)
  }
  return { fileSync: true }
}

async function zoteroDataDir() {
  const p = await zoteroPrefs()
  return p.useDataDir !== false && p.dataDir ? p.dataDir : path.join(os.homedir(), 'Zotero')
}

/** How much the library stores, where, and whether PDFs count against the free 300 MB of Zotero file sync. */
/** The library's collections (Zotero's folders), with their parents, for the Library tab. */
async function collections() {
  const out = []
  for (let start = 0; ; start += 100) {
    const { data, total } = await localApi(`collections?limit=100&start=${start}`)
    out.push(...data.map(c => ({ key: c.key, name: c.data.name, parent: c.data.parentCollection || null, items: c.meta?.numItems ?? 0 })))
    if (!data.length || out.length >= total) break
  }
  return out
}

/** The item keys directly in one collection (its subcollections are asked for separately). */
async function collectionItems(key) {
  if (!/^[A-Z0-9]{8}$/.test(key)) throw new Error('Not a Zotero collection key')
  const keys = []
  for (let start = 0; ; start += 100) {
    const res = await fetch(`${BASE}/api/users/0/collections/${key}/items/top?format=keys&limit=100&start=${start}`, { signal: AbortSignal.timeout(15000) })
    if (!res.ok) throw new Error(`Zotero local API answered HTTP ${res.status}`)
    const batch = (await res.text()).split('\n').filter(Boolean)
    keys.push(...batch)
    if (batch.length < 100) break
  }
  return keys
}

async function storage() {
  const prefs = await zoteroPrefs()
  const dataDir = prefs.useDataDir !== false && prefs.dataDir ? prefs.dataDir : path.join(os.homedir(), 'Zotero')
  let files = 0
  let bytes = 0
  for (const dir of await fs.readdir(path.join(dataDir, 'storage')).catch(() => []))
    for (const f of await fs.readdir(path.join(dataDir, 'storage', dir)).catch(() => []))
      if (!f.startsWith('.')) (files++, (bytes += (await fs.stat(path.join(dataDir, 'storage', dir, f)).catch(() => ({ size: 0 }))).size))
  const fsStat = await fs.statfs(dataDir).catch(() => null)
  return { dataDir, files, bytes, freeBytes: fsStat ? fsStat.bavail * fsStat.bsize : null, fileSync: prefs.fileSync }
}

// ---------- "Ask my library": index of the text Zotero extracted from attachments ----------

let indexFile = null
let index = null // { model, papers: { [attachmentKey]: { mtime, citekey, title, year, chunks: [{ text, vec }] } } }
// text LaTeXDesk extracted itself for PDFs Zotero hasn't indexed yet
const textCache = (userData, key) => path.join(userData, 'zotero-text', `${key}.txt`)

async function attachments(userData) {
  const storageDir = path.join(await zoteroDataDir(), 'storage')
  const out = []
  for (let start = 0; ; start += 100) {
    const { data, total } = await localApi(`items?itemType=attachment&limit=100&start=${start}`)
    for (const a of data) {
      const href = a.links?.enclosure?.href
      if (!href?.startsWith('file:') || !a.data.parentItem) continue
      // Zotero keeps extracted text under storage/<key>/ even for linked files that live elsewhere
      const caches = [path.join(storageDir, a.key, '.zotero-ft-cache'), path.join(path.dirname(fileURLToPath(href)), '.zotero-ft-cache'), textCache(userData, a.key)]
      out.push({ key: a.key, parent: a.data.parentItem, file: fileURLToPath(href), pdf: a.data.contentType === 'application/pdf', caches })
    }
    if (start + 100 >= total) break
  }
  return out
}

async function firstExisting(paths) {
  for (const p of paths) {
    const stat = await fs.stat(p).catch(() => null)
    if (stat) return { path: p, stat }
  }
  return null
}

/** PDFs with no extracted text anywhere: the renderer extracts them with pdf.js. */
async function missingText({ userData }) {
  const out = []
  for (const a of await attachments(userData)) if (a.pdf && !(await firstExisting(a.caches))) out.push({ key: a.key, file: path.basename(a.file) })
  return out
}

/** The bytes of one attachment's PDF (only files Zotero itself lists). */
async function pdfBytes({ userData, key }) {
  const a = (await attachments(userData)).find(x => x.key === key && x.pdf)
  if (!a) throw new Error('not a PDF attachment in your library')
  return fs.readFile(a.file)
}

async function saveText({ userData, key, text }) {
  if (!/^[A-Z0-9]{8}$/.test(key)) throw new Error('bad attachment key')
  await fs.mkdir(path.join(userData, 'zotero-text'), { recursive: true })
  await fs.writeFile(textCache(userData, key), String(text))
}

function chunk(text) {
  const clean = text.replace(/\s+/g, ' ').trim()
  const out = []
  for (let i = 0; i < clean.length && out.length < MAX_CHUNKS_PER_PAPER; i += CHUNK - OVERLAP) out.push(clean.slice(i, i + CHUNK))
  return out
}

async function embed(ollamaUrl, inputs) {
  const res = await fetch(`${ollamaUrl.replace(/\/$/, '')}/api/embed`, {
    method: 'POST',
    body: JSON.stringify({ model: EMBED_MODEL, input: inputs, truncate: true }),
    signal: AbortSignal.timeout(120000),
  })
  if (!res.ok) throw new Error(`embedding failed (HTTP ${res.status}): is ${EMBED_MODEL} installed in Ollama?`)
  return (await res.json()).embeddings.map(v => v.map(x => Math.round(x * 1e4) / 1e4))
}

/** Bring the index up to date: only new or changed attachments are (re)embedded. */
async function updateIndex({ userData, ollamaUrl, onProgress = () => {} }) {
  indexFile ??= path.join(userData, 'zotero-index.json')
  if (!index) index = JSON.parse(await fs.readFile(indexFile, 'utf8').catch(() => 'null')) ?? { model: EMBED_MODEL, papers: {} }
  const byItem = new Map((await search('')).map(r => [r.itemKey, r]))
  const atts = await attachments(userData)
  const seen = new Set()
  let useEmbeddings = true
  let done = 0
  for (const a of atts) {
    seen.add(a.key)
    const found = await firstExisting(a.caches)
    const stat = found?.stat
    const meta = byItem.get(a.parent)
    if (!stat || !meta) continue
    const cached = index.papers[a.key]
    if (cached && cached.mtime === stat.mtimeMs && (cached.chunks[0]?.vec || !useEmbeddings)) {
      Object.assign(cached, { citekey: meta.citekey, title: meta.title, year: meta.year })
      continue
    }
    const pieces = chunk(await fs.readFile(found.path, 'utf8'))
    let vecs = []
    if (useEmbeddings) {
      try {
        for (let i = 0; i < pieces.length; i += 32) vecs.push(...(await embed(ollamaUrl, pieces.slice(i, i + 32).map(p => `search_document: ${p}`))))
      } catch {
        useEmbeddings = false // fall back to keyword search for everything
        vecs = []
      }
    }
    index.papers[a.key] = { mtime: stat.mtimeMs, citekey: meta.citekey, title: meta.title, year: meta.year, chunks: pieces.map((text, i) => ({ text, vec: vecs[i] })) }
    onProgress({ done: ++done, title: meta.title })
  }
  for (const k of Object.keys(index.papers)) if (!seen.has(k)) delete index.papers[k]
  await fs.writeFile(indexFile, JSON.stringify(index))
  const papers = Object.values(index.papers)
  return { papers: papers.length, chunks: papers.reduce((n, p) => n + p.chunks.length, 0), embeddings: papers.some(p => p.chunks[0]?.vec), updated: done }
}

const cosine = (a, b) => {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) (dot += a[i] * b[i]), (na += a[i] * a[i]), (nb += b[i] * b[i])
  return dot / (Math.sqrt(na * nb) || 1)
}

/** Keyword fallback: a simple BM25 over the chunks. */
function keywordScores(chunks, question) {
  const terms = [...new Set(question.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])]
  const avg = chunks.reduce((n, c) => n + c.text.length, 0) / (chunks.length || 1)
  const df = new Map(terms.map(t => [t, chunks.filter(c => c.lower.includes(t)).length]))
  return chunks.map(c => {
    let score = 0
    for (const t of terms) {
      const tf = c.lower.split(t).length - 1
      if (!tf) continue
      const idf = Math.log(1 + (chunks.length - df.get(t) + 0.5) / (df.get(t) + 0.5))
      score += (idf * tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * (c.text.length / avg)))
    }
    return score
  })
}

/** The passages most relevant to a question, at most `perPaper` from any one paper. */
async function retrieve({ userData, ollamaUrl, question, k = 8, perPaper = 3, citekeys = null }) {
  await updateIndex({ userData, ollamaUrl })
  // optionally only look inside specific papers (fact-checking a claim against what it cites)
  const only = citekeys?.length ? new Set(citekeys) : null
  const chunks = Object.values(index.papers)
    .filter(p => !only || only.has(p.citekey))
    .flatMap(p => p.chunks.map(c => ({ ...c, citekey: p.citekey, title: p.title, year: p.year, lower: c.text.toLowerCase() })))
  if (!chunks.length) return { passages: [], method: 'none' }
  let scores
  let method = 'embeddings'
  try {
    if (!chunks[0].vec) throw new Error('no vectors')
    const [q] = await embed(ollamaUrl, [`search_query: ${question}`])
    scores = chunks.map(c => (c.vec ? cosine(q, c.vec) : 0))
  } catch {
    scores = keywordScores(chunks, question)
    method = 'keywords'
  }
  const ranked = chunks.map((c, i) => ({ c, s: scores[i] })).sort((a, b) => b.s - a.s)
  const perKey = new Map()
  const passages = []
  for (const { c, s } of ranked) {
    if (passages.length >= k) break
    if ((perKey.get(c.citekey) ?? 0) >= perPaper) continue
    perKey.set(c.citekey, (perKey.get(c.citekey) ?? 0) + 1)
    passages.push({ citekey: c.citekey, title: c.title, year: c.year, text: c.text, score: Math.round(s * 1000) / 1000 })
  }
  return { passages, method }
}

module.exports = { status, search, exportBib, save, findItem, updateIndex, retrieve, toZoteroItem, embed, storage, collections, collectionItems, missingText, pdfBytes, saveText, parsePrefs }
