// Renderer side of the Zotero integration: a cached copy of the library for instant search and \cite
// completion, plus the operations every panel shares (cite from Zotero, save to Zotero, sync).
import { addEntries, syncFromZotero } from './bib-project'
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

/** Make sure the project's .bib has entries for these Zotero keys. Returns the keys that were added. */
export async function ensureInBib(host: AppHost, keys: string[]) {
  if (!keys.length) return []
  const bib = await zotero.exportBib(keys)
  return addEntries(host, bib)
}

/** Put \cite{key} at the cursor, or add the key to a \cite{…} the cursor is already inside. */
export function insertCite(host: AppHost, key: string) {
  const view = host.view
  const pos = view.state.selection.main.head
  const line = view.state.doc.lineAt(pos)
  const before = line.text.slice(0, pos - line.from)
  const inside = /\\cite[a-z]*\*?(\[[^\]]*\])*\{[^}]*$/.test(before) && line.text.slice(pos - line.from).includes('}')
  const insert = inside ? (/[{,]\s*$/.test(before) ? key : `,${key}`) : `\\cite{${key}}`
  view.dispatch({ changes: { from: pos, insert }, selection: { anchor: pos + insert.length }, scrollIntoView: true })
  view.focus()
}

/** Cite a Zotero item: insert \cite and add its BibTeX to the project. */
export async function citeFromZotero(host: AppHost, key: string) {
  insertCite(host, key)
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
