// Project bibliography helpers shared by the References tab, the Library tab, \cite autocomplete and
// Zotero sync: which keys are cited where, which entries the .bib files hold, adding and replacing entries.
import type { AppHost } from './host'

export type BibEntry = { key: string; type: string; file: string; start: number; end: number; raw: string; fields: Record<string, string> }
export type CiteUse = { file: string; line: number }

const CITE_RE = /\\(?:no)?cite[a-zA-Z]*\*?(?:\[[^\]]*\]){0,2}\{([^}]*)\}/g

/** Split a .bib file into entries (balanced braces), skipping @comment/@string/@preamble. */
export function parseBib(text: string, file = ''): BibEntry[] {
  const out: BibEntry[] = []
  const re = /@(\w+)\s*\{\s*([^,\s]+)\s*,/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const type = m[1].toLowerCase()
    let depth = 0
    let end = m.index
    for (let i = text.indexOf('{', m.index); i < text.length; i++) {
      if (text[i] === '{') depth++
      else if (text[i] === '}' && --depth === 0) {
        end = i + 1
        break
      }
    }
    if (end <= m.index) break
    re.lastIndex = end
    if (['comment', 'string', 'preamble'].includes(type)) continue
    const raw = text.slice(m.index, end)
    out.push({ key: m[2], type, file, start: m.index, end, raw, fields: parseFields(raw) })
  }
  return out
}

/** Field values of one entry: {…} (nested), "…", or bare (numbers, macros). */
export function parseFields(raw: string): Record<string, string> {
  const fields: Record<string, string> = {}
  const body = raw.slice(raw.indexOf(',') + 1, raw.lastIndexOf('}'))
  const re = /([A-Za-z][\w-]*)\s*=\s*/g
  let m: RegExpExecArray | null
  while ((m = re.exec(body))) {
    let i = re.lastIndex
    let value = ''
    if (body[i] === '{') {
      let depth = 0
      const start = i
      for (; i < body.length; i++) {
        if (body[i] === '{') depth++
        else if (body[i] === '}' && --depth === 0) break
      }
      value = body.slice(start + 1, i)
      i++
    } else if (body[i] === '"') {
      const end = body.indexOf('"', i + 1)
      value = body.slice(i + 1, end)
      i = end + 1
    } else {
      const end = body.slice(i).search(/[,\n}]/)
      value = body.slice(i, end < 0 ? undefined : i + end).trim()
      i = end < 0 ? body.length : i + end
    }
    fields[m[1].toLowerCase()] = value
    re.lastIndex = i
  }
  return fields
}

/** Every citation key used in the project's .tex files, with where it's cited. */
export async function citedKeys(host: AppHost) {
  const uses = new Map<string, CiteUse[]>()
  for (const f of host.files()) {
    if (!f.path.endsWith('.tex')) continue
    const text = await host.fileText(f.path)
    for (const m of text.matchAll(CITE_RE)) {
      // ignore citations inside % comments
      const lineStart = text.lastIndexOf('\n', m.index!) + 1
      if (/(^|[^\\])%/.test(text.slice(lineStart, m.index!))) continue
      const line = text.slice(0, m.index!).split('\n').length
      for (const key of m[1].split(',').map(k => k.trim()).filter(Boolean)) {
        if (!uses.has(key)) uses.set(key, [])
        uses.get(key)!.push({ file: f.path, line })
      }
    }
  }
  return uses
}

/** All entries in all of the project's .bib files, by key (first definition wins, like BibTeX). */
export async function bibEntries(host: AppHost) {
  const entries = new Map<string, BibEntry>()
  for (const f of host.files()) {
    if (!f.path.endsWith('.bib')) continue
    for (const e of parseBib(await host.fileText(f.path), f.path)) if (!entries.has(e.key)) entries.set(e.key, e)
  }
  return entries
}

/**
 * The source an error in the generated reference list (.bbl) comes from: the entry of the last \bibitem at or
 * before the reported line. BibTeX copies each entry's text into the .bbl, so the fix belongs in the .bib.
 */
export async function bblSource(host: AppHost, bbl: string, line: number) {
  const upTo = bbl.split('\n').slice(0, line || undefined).join('\n')
  const key = [...upTo.matchAll(/\\bibitem\s*(?:\[(?:[^[\]]|\[[^\]]*\])*\])?\s*\{([^}]+)\}/g)].at(-1)?.[1].trim()
  return key ? (await bibEntries(host)).get(key) ?? null : null
}

/** The .bib file the main document uses (\bibliography / \addbibresource), else refs.bib. */
export async function bibTarget(host: AppHost) {
  const rootDoc = host.mainFile()
  const text = rootDoc && host.fileExists(rootDoc) ? await host.fileText(rootDoc) : ''
  const named = text.match(/\\bibliography\{([^}]+)\}/)?.[1].split(',')[0].trim() ?? text.match(/\\addbibresource\{([^}]+)\}/)?.[1].trim()
  const dir = rootDoc?.includes('/') ? rootDoc.slice(0, rootDoc.lastIndexOf('/') + 1) : ''
  const file = named ? dir + (named.endsWith('.bib') ? named : `${named}.bib`) : 'refs.bib'
  return { file, declared: !!named }
}

/** Make sure the main document prints a bibliography from `bibPath`. */
export async function declareBibliography(host: AppHost, bibPath: string) {
  const rootDoc = host.mainFile()
  if (!rootDoc || !host.fileExists(rootDoc)) return
  const text = await host.fileText(rootDoc)
  if (/\\bibliography\{|\\printbibliography/.test(text)) return
  const end = text.lastIndexOf('\\end{document}')
  if (end < 0) return
  const name = bibPath.replace(/^.*\//, '').replace(/\.bib$/, '')
  await host.applyFileText(rootDoc, `${text.slice(0, end)}\\bibliographystyle{plain}\n\\bibliography{${name}}\n\n${text.slice(end)}`)
}

/** Append entries (BibTeX text) whose keys aren't in the project yet. Returns the keys added. */
export async function addEntries(host: AppHost, bibtex: string) {
  const existing = await bibEntries(host)
  const fresh = parseBib(bibtex).filter(e => !existing.has(e.key))
  if (!fresh.length) return []
  const { file, declared } = await bibTarget(host)
  const before = host.fileExists(file) ? await host.fileText(file) : ''
  await host.applyFileText(file, `${before.replace(/\s*$/, '')}${before.trim() ? '\n\n' : ''}${fresh.map(e => e.raw).join('\n\n')}\n`)
  if (!declared) await declareBibliography(host, file)
  return fresh.map(e => e.key)
}

/** Replace one entry's text where it is (editing a source keeps its key, so citations stay valid). */
export async function replaceEntry(host: AppHost, entry: BibEntry, raw: string) {
  const text = await host.fileText(entry.file)
  const at = parseBib(text, entry.file).find(e => e.key === entry.key)
  if (!at) throw new Error(`${entry.key} is no longer in ${entry.file}`)
  await host.applyFileText(entry.file, text.slice(0, at.start) + raw + text.slice(at.end))
}

/** Remove entries by key from whichever .bib files hold them (used for "remove unused"). */
export async function removeEntriesText(host: AppHost, keys: Set<string>) {
  const changes: { file: string; before: string; after: string }[] = []
  for (const f of host.files()) {
    if (!f.path.endsWith('.bib')) continue
    const before = await host.fileText(f.path)
    const drop = parseBib(before, f.path).filter(e => keys.has(e.key))
    if (!drop.length) continue
    let after = before
    for (const e of drop.sort((a, b) => b.start - a.start)) after = after.slice(0, e.start) + after.slice(e.end).replace(/^\s*\n/, '')
    changes.push({ file: f.path, before, after: after.replace(/\n{3,}/g, '\n\n') })
  }
  return changes
}

// fields that matter when deciding whether a project entry is out of date with Zotero
const COMPARED = ['title', 'author', 'editor', 'year', 'date', 'journal', 'journaltitle', 'booktitle', 'volume', 'number', 'pages', 'doi', 'publisher']
const norm = (s = '') => s.replace(/[{}\\]/g, '').replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim().toLowerCase()

/**
 * Refresh the project's entries for cited keys that exist in Zotero, and add cited keys missing from
 * the .bib. Entries not in Zotero are never touched. `exportBib` returns Better BibTeX's export.
 */
export async function syncFromZotero(host: AppHost, zoteroKeys: Set<string>, exportBib: (keys: string[]) => Promise<string>) {
  const cited = await citedKeys(host)
  const keys = [...cited.keys()].filter(k => zoteroKeys.has(k))
  if (!keys.length) return { updated: [] as string[], added: [] as string[] }
  const fresh = new Map(parseBib(await exportBib(keys)).map(e => [e.key, e]))
  const current = await bibEntries(host)
  const updated: string[] = []
  // group replacements per file, applied from the end so offsets stay valid
  const perFile = new Map<string, BibEntry[]>()
  for (const [key, z] of fresh) {
    const mine = current.get(key)
    if (!mine) continue
    const differs = COMPARED.some(f => norm(mine.fields[f]) !== norm(z.fields[f]))
    if (!differs) continue
    if (!perFile.has(mine.file)) perFile.set(mine.file, [])
    perFile.get(mine.file)!.push({ ...mine, raw: z.raw })
    updated.push(key)
  }
  for (const [file, list] of perFile) {
    let text = await host.fileText(file)
    const original = parseBib(text, file)
    for (const e of list.sort((a, b) => b.start - a.start)) {
      const at = original.find(o => o.key === e.key)!
      text = text.slice(0, at.start) + e.raw + text.slice(at.end)
    }
    await host.applyFileText(file, text)
  }
  const missing = [...fresh.values()].filter(e => !current.has(e.key))
  const added = missing.length ? await addEntries(host, missing.map(e => e.raw).join('\n\n')) : []
  return { updated, added }
}
