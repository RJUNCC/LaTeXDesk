// Renderer side of the Zotero integration: a cached copy of the library for instant search and \cite
// completion, plus the operations every panel shares (cite from Zotero, save to Zotero, sync).
import { BibEntry, addEntries, syncFromZotero } from './bib-project'
import { plain } from './bib-sources'
import { citeCommand } from './bib-style'
import type { AppHost } from './host'

export type ZItem = { citekey: string; itemKey: string; title: string; authors: string[]; year: number | null; type?: string; doi?: string; url?: string; abstract?: string }
export type ZStatus = { running: boolean; localApi: boolean; betterBibtex: boolean; version: string | null }
/** A Zotero collection (folder); `items` counts only what is directly in it. */
export type ZFolder = { key: string; name: string; parent: string | null; items: number }
export type Passage ={ citekey: string; title: string; year: number | null; text: string; score: number }

type Bridge = {
  status(): Promise<ZStatus>
  search(q: string): Promise<ZItem[]>
  exportBib(keys: string[]): Promise<string>
  save(payload: { entryType: string; fields: Record<string, string>; tag?: string }): Promise<ZItem>
  saveTarget(): Promise<{ name: string; isFolder: boolean; editable: boolean }>
  index(): Promise<{ papers: number; chunks: number; embeddings: boolean; updated: number }>
  retrieve(question: string, k?: number, citekeys?: string[]): Promise<{ passages: Passage[]; method: string }>
  onIndexProgress(cb: (p: { done: number; title: string }) => void): void
  storage(): Promise<ZStorage>
  collections(): Promise<ZFolder[]>
  collectionItems(key: string): Promise<string[]>
  collections(): Promise<{ key: string; name: string; parent: string | null; items: number }[]>
  collectionItems(key: string): Promise<string[]>
  missingText(): Promise<{ key: string; file: string }[]>
  pdfBytes(key: string): Promise<Uint8Array>
  saveText(key: string, text: string): Promise<void>
}
export type ZStorage = { dataDir: string; files: number; bytes: number; freeBytes: number | null; fileSync: boolean }
const bridge: Bridge = (window as unknown as { texdesk: { zotero: Bridge } }).texdesk.zotero

let textChecked = 0
/** Zotero hasn't extracted text from some PDFs yet: read those with pdf.js so Ask my library and fact check see them. */
async function fillMissingText() {
  if (Date.now() - textChecked < 300000) return
  textChecked = Date.now()
  const missing = await bridge.missingText().catch(() => [])
  if (!missing.length) return
  const pdfjs = await import('pdfjs-dist')
  pdfjs.GlobalWorkerOptions.workerSrc ||= './pdf.worker.min.mjs'
  for (const m of missing) {
    let text = ''
    try {
      const doc = await pdfjs.getDocument({ data: await bridge.pdfBytes(m.key) }).promise
      for (let p = 1; p <= Math.min(doc.numPages, 100); p++) {
        const content = await (await doc.getPage(p)).getTextContent()
        text += content.items.map(i => ('str' in i ? i.str + (i.hasEOL ? '\n' : ' ') : '')).join('') + '\n'
      }
      await doc.destroy()
    } catch {} // a scanned or broken PDF: store empty text so it isn't retried every time
    await bridge.saveText(m.key, text).catch(() => {})
  }
}

export const zotero: Bridge = {
  ...bridge,
  index: async () => (await fillMissingText(), bridge.index()),
  retrieve: async (question, k, citekeys) => (await fillMissingText(), bridge.retrieve(question, k, citekeys)),
}

let items: ZItem[] = []
let fetched = 0
let statusCache: ZStatus | null = null
const listeners: (() => void)[] = []

export const libraryItems = () => items
export const libraryKeys = () => new Set(items.map(i => i.citekey))
export const onLibraryChange = (cb: () => void) => listeners.push(cb)

/** Is Zotero usable (running with Better BibTeX)? Cached for a few seconds. */
export async function zoteroStatus(refresh = false) {
  if (refresh || !statusCache) {
    statusCache = await zotero.status().catch(() => ({ running: false, localApi: false, betterBibtex: false, version: null }))
    setTimeout(() => (statusCache = null), 5000)
  }
  return statusCache
}

/** Refresh the cached library (at most every 2 minutes unless forced). */
export async function refreshLibrary(force = false) {
  if (!force && Date.now() - fetched < 120000 && items.length) return items
  const st = await zoteroStatus()
  if (!st.betterBibtex) return items
  try {
    items = await zotero.search('')
    fetched = Date.now()
    listeners.forEach(cb => cb())
  } catch {}
  return items
}

/** Client-side search over the cached library: every word must match key, title, author or year. */
export function searchLibrary(q: string) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return items.slice(0, 50)
  return items.filter(i => {
    const hay = `${i.citekey} ${i.title} ${i.authors.join(' ')} ${i.year ?? ''}`.toLowerCase()
    return words.every(w => hay.includes(w))
  })
}

export const authorLine = (i: Pick<ZItem, 'authors' | 'year'>) =>
  `${i.authors.length > 2 ? `${i.authors[0]} et al.` : i.authors.join(' & ')}${i.year ? ` ${i.year}` : ''}`

const squash = (s = '') => plain(s).toLowerCase().replace(/[^a-z0-9]+/g, '')
const DOI_PREFIX = /^https?:\/\/(dx\.)?doi\.org\//i
/** The arXiv id in a link (arXiv, alphaXiv, Hugging Face Papers…) or an arXiv DOI. */
const arxivIn = (s = '') => s.match(/(?:arxiv\.org\/(?:abs|pdf|html)\/|alphaxiv\.org\/(?:abs|pdf|overview)\/|huggingface\.co\/papers\/|10\.48550\/arxiv\.)(\d{4}\.\d{4,5})/i)?.[1]
export const arxivOf = (f: Record<string, string>) => (/^\d{4}\.\d{4,5}/.test(f.eprint ?? '') ? f.eprint.slice(0, 10).replace(/v.*$/, '') : arxivIn(`${f.url ?? ''} ${f.howpublished ?? ''} ${f.doi ?? ''}`))

/**
 * The Zotero item for a project source: the same citation key, else the same DOI, arXiv paper or title. Zotero's
 * Better BibTeX gives a paper its own key (smithSleepMemory2020), so a source saved from LaTeXDesk keeps the
 * project's key (smith2020sleep) and is found this way.
 */
export function zoteroItemFor(key: string, f?: Record<string, string>): ZItem | undefined {
  const byKey = items.find(i => i.citekey === key)
  if (byKey || !f) return byKey
  const doi = f.doi?.replace(DOI_PREFIX, '').toLowerCase()
  const arxiv = arxivOf(f)
  const title = squash(f.title)
  const year = f.year?.match(/\d{4}/)?.[0]
  return items.find(
    i =>
      (!!doi && i.doi?.toLowerCase() === doi) ||
      (!!arxiv && arxivIn(`${i.url ?? ''} ${i.doi ?? ''}`) === arxiv) ||
      (title.length > 12 && squash(i.title) === title && (!year || !i.year || String(i.year) === year))
  )
}

/** Could this source have a PDF to read: on arXiv, a DOI, a direct .pdf link, or in Zotero (which may have the PDF). */
export const mayHavePdf = (f: Record<string, string>, inZotero = false) => inZotero || !!arxivOf(f) || !!f.doi || /\.pdf(\?|$)/i.test(f.url ?? '')

/** Save a project source to Zotero (into the folder selected in Zotero). Returns a status line for the user. */
export async function saveToZotero(entry: BibEntry) {
  const target = await zotero.saveTarget().catch(() => null)
  if (target && !target.editable) throw new Error(`“${target.name}” is selected in Zotero and can’t be changed. Select My Library or one of your folders in Zotero, then try again.`)
  // "Saved, but Better BibTeX has no key for it yet" is still a save: saving again would make a duplicate
  await zotero.save({ entryType: entry.type, fields: entry.fields }).catch(e => {
    if (!/Saved to Zotero/.test(String(e))) throw e
  })
  await refreshLibrary(true)
  return `Saved to Zotero${target ? `, in “${target.name}”` : ''}. Zotero puts new papers in the folder selected on its left; drag it to another folder there if you like.`
}

/** Make sure the project's .bib has entries for these Zotero keys. Returns the keys that were added. */
export async function ensureInBib(host: AppHost, keys: string[]) {
  if (!keys.length) return []
  const bib = await zotero.exportBib(keys)
  return addEntries(host, bib)
}

/** Put \cite{key} at the cursor, or add the key to a \cite{…} the cursor is already inside. */
export function insertCite(host: AppHost, key: string, command = 'cite') {
  const view = host.view
  const pos = view.state.selection.main.head
  const line = view.state.doc.lineAt(pos)
  const before = line.text.slice(0, pos - line.from)
  const inside = /\\cite[a-z]*\*?(\[[^\]]*\])*\{[^}]*$/.test(before) && line.text.slice(pos - line.from).includes('}')
  const insert = inside ? (/[{,]\s*$/.test(before) ? key : `,${key}`) : `${/\S$/.test(before) && command !== 'cite' ? ' ' : ''}\\${command}{${key}}`
  view.dispatch({ changes: { from: pos, insert }, selection: { anchor: pos + insert.length }, scrollIntoView: true })
  view.focus()
}

/** The citation command the document's reference style wants: \citep with natbib or apacite, else \cite. */
export async function citeCommandFor(host: AppHost) {
  const main = host.mainFile()
  return main && host.fileExists(main) ? citeCommand(await host.fileText(main)) : 'cite'
}

/** Cite a Zotero item: insert \cite (or \citep) and add its BibTeX to the project. */
export async function citeFromZotero(host: AppHost, key: string) {
  insertCite(host, key, await citeCommandFor(host))
  const added = await ensureInBib(host, [key])
  host.setStatus(added.length ? `Cited ${key} and added it to the bibliography` : `Cited ${key}`, 'ok')
}

/** Sync before compiling: quietly refresh cited entries from Zotero, never blocking for long. */
export async function syncBeforeCompile(host: AppHost, timeoutMs = 3000) {
  const work = (async () => {
    if (!(await zoteroStatus()).betterBibtex) return null
    await refreshLibrary()
    return syncFromZotero(host, libraryKeys(), keys => zotero.exportBib(keys))
  })()
  const result = await Promise.race([work, new Promise<null>(r => setTimeout(() => r(null), timeoutMs))]).catch(() => null)
  if (result && (result.updated.length || result.added.length)) {
    const parts = [result.updated.length && `updated ${result.updated.length}`, result.added.length && `added ${result.added.length}`].filter(Boolean)
    host.setStatus(`References from Zotero: ${parts.join(', ')}`, 'ok')
  }
  return result
}
