// The References tab: every reference in this project with its status (cited where, unused, missing,
// in Zotero or not) and one-click fixes.
import { BibEntry, CiteUse, bibEntries, citedKeys, removeEntriesText } from './bib-project'
import { reviewChanges } from './diff-review'
import type { AppHost } from './host'
import { panelEl, setBadge, whenShown } from './panels'
import { openPaper } from './paper-reader'
import { ZItem, authorLine, ensureInBib, mayHavePdf, refreshLibrary, saveToZotero, syncBeforeCompile, zoteroItemFor, zoteroStatus } from './zotero-client'

/** `z`: the paper in Zotero, found by key or by DOI, arXiv id or title (Zotero may know it under its own key) */
type Row = { key: string; entry?: BibEntry; uses: CiteUse[]; inZotero: boolean; z?: ZItem }

let host: AppHost
let rows: Row[] = []
let filter = ''
let syncOnCompile = true
let persistSync: (on: boolean) => void = () => {}

const $ = <T extends HTMLElement>(sel: string) => panelEl('references').querySelector<T>(sel)!

export function initReferences(h: AppHost, opts: { syncOnCompile: boolean; persist: (on: boolean) => void }) {
  host = h
  syncOnCompile = opts.syncOnCompile
  persistSync = opts.persist
  panelEl('references').innerHTML = `
    <div class="pane-title refs-bar">
      <input class="refs-filter" placeholder="Filter references…">
      <button class="refs-sync" title="Refresh every cited reference from Zotero now">⟳ Sync from Zotero</button>
    </div>
    <div class="refs-summary"></div>
    <div class="refs-actions"></div>
    <div class="refs-list"></div>
    <label class="refs-auto check"><input type="checkbox" class="refs-auto-box"> Update references from Zotero before each compile</label>`
  $<HTMLInputElement>('.refs-filter').oninput = ev => ((filter = (ev.target as HTMLInputElement).value.toLowerCase()), render())
  $('.refs-sync').onclick = async () => {
    const r = await syncBeforeCompile(host, 30000)
    if (r && !r.updated.length && !r.added.length) host.setStatus('References already match Zotero', 'ok')
    if (!r) host.setStatus('Zotero is not available (is it running, with Better BibTeX?)', 'warn')
    await refresh()
  }
  const auto = $<HTMLInputElement>('.refs-auto-box')
  auto.checked = syncOnCompile
  auto.onchange = () => ((syncOnCompile = auto.checked), persistSync(auto.checked))
  host.onProjectOpened(() => void refresh())
  host.onCompiled(() => void refresh())
  whenShown('references', () => void refresh())
}

export const shouldSyncOnCompile = () => syncOnCompile

export async function refresh() {
  if (!host?.root()) return
  await refreshLibrary()
  const [uses, entries] = await Promise.all([citedKeys(host), bibEntries(host)])
  const keys = new Set([...uses.keys(), ...entries.keys()])
  rows = [...keys].map(key => {
    const z = zoteroItemFor(key, entries.get(key)?.fields)
    return { key, entry: entries.get(key), uses: uses.get(key) ?? [], inZotero: !!z, z }
  })
  // problems first, then most-cited
  const rank = (r: Row) => (!r.entry ? 0 : !r.uses.length ? 1 : 2)
  rows.sort((a, b) => rank(a) - rank(b) || b.uses.length - a.uses.length || a.key.localeCompare(b.key))
  render()
}

function describe(r: Row) {
  const f = r.entry?.fields
  const z = r.z
  const title = (f?.title ?? z?.title ?? '').replace(/[{}]/g, '')
  const authors = f?.author
    ? f.author.replace(/[{}]/g, '').split(/\s+and\s+/i).map(a => (a.includes(',') ? a.split(',')[0] : a.trim().split(' ').pop()!))
    : z?.authors ?? []
  const year = Number(f?.year?.match(/\d{4}/)?.[0] ?? f?.date?.match(/\d{4}/)?.[0]) || z?.year || null
  return { title: title || '(no title)', who: authorLine({ authors, year }) }
}

function badge(text: string, cls: string, title = '') {
  return Object.assign(document.createElement('span'), { className: `ref-badge ${cls}`, textContent: text, title })
}

function render() {
  if (!host) return
  const missing = rows.filter(r => !r.entry)
  const unused = rows.filter(r => r.entry && !r.uses.length)
  const cited = rows.filter(r => r.uses.length)
  const notInZotero = rows.filter(r => r.entry && !r.inZotero)
  setBadge('refs', missing.length)
  void zoteroStatus().then(st => {
    const note = st.betterBibtex ? `Zotero ${st.version} connected` : st.running ? 'Zotero is running, but Better BibTeX is missing' : 'Zotero is not running'
    $('.refs-summary').textContent = `${cited.length} cited · ${rows.filter(r => r.entry).length} in bibliography · ${missing.length} missing · ${unused.length} unused · ${note}`
    $<HTMLButtonElement>('.refs-sync').disabled = !st.betterBibtex
  })
  // one-click fixes for the whole project
  const actions: HTMLElement[] = []
  const fixable = missing.filter(r => r.inZotero)
  if (fixable.length)
    actions.push(button(`Add ${fixable.length} missing from Zotero`, async () => {
      const added = await ensureInBib(host, fixable.map(r => r.key))
      host.setStatus(`Added ${added.length} reference${added.length === 1 ? '' : 's'} from Zotero`, 'ok')
      await refresh()
    }, 'primary'))
  if (unused.length)
    actions.push(button(`Remove ${unused.length} unused…`, async () => {
      const changes = await removeEntriesText(host, new Set(unused.map(r => r.key)))
      await reviewChanges('Remove unused references', changes, host)
      await refresh()
    }))
  if (notInZotero.length)
    actions.push(Object.assign(document.createElement('span'), { className: 'muted', textContent: `${notInZotero.length} not in your Zotero library` }))
  $('.refs-actions').replaceChildren(...actions)

  const shown = rows.filter(r => !filter || `${r.key} ${describe(r).title} ${describe(r).who}`.toLowerCase().includes(filter))
  $('.refs-list').replaceChildren(
    ...(shown.length ? shown.map(row) : [Object.assign(document.createElement('div'), { className: 'muted refs-empty', textContent: rows.length ? 'No match.' : 'No references yet. Cite from the Library tab, or type \\cite{.' })])
  )
}

function row(r: Row) {
  const d = describe(r)
  const div = document.createElement('div')
  div.className = `ref-row${!r.entry ? ' missing' : !r.uses.length ? ' unused' : ''}`
  const head = document.createElement('div')
  head.className = 'ref-head'
  const key = Object.assign(document.createElement('code'), { textContent: r.key })
  head.append(key)
  if (!r.entry) head.append(badge('missing', 'bad', 'Cited, but there is no entry for it in the .bib files'))
  else if (!r.uses.length) head.append(badge('unused', 'warn', 'In the bibliography but never cited'))
  else head.append(badge(`cited ${r.uses.length}×`, 'ok'))
  head.append(r.z ? badge('Zotero', 'z', r.z.citekey === r.key ? 'In your Zotero library' : `In your Zotero library, where Better BibTeX calls it ${r.z.citekey}`) : badge('not in Zotero', 'muted'))
  const title = Object.assign(document.createElement('div'), { className: 'ref-title', textContent: d.title })
  const who = Object.assign(document.createElement('div'), { className: 'muted ref-who', textContent: d.who })
  const uses = document.createElement('div')
  uses.className = 'ref-uses'
  for (const u of r.uses)
    uses.append(Object.assign(document.createElement('a'), { textContent: `${u.file}:${u.line}`, href: '#', onclick: (e: Event) => (e.preventDefault(), void host.openFile(u.file, u.line)) }))
  const acts = document.createElement('div')
  acts.className = 'ref-acts'
  if (!r.entry && r.inZotero) acts.append(button('Add from Zotero', async () => (await ensureInBib(host, [r.key]), await refresh())))
  if (r.entry && mayHavePdf(r.entry.fields, r.inZotero)) acts.append(button('📄 Read', () => void openPaper({ key: r.key, title: d.title, fields: r.entry!.fields, zoteroItemKey: r.z?.itemKey })))
  else if (!r.entry && r.z) acts.append(button('📄 Read', () => void openPaper({ key: r.key, title: d.title, fields: { doi: r.z!.doi ?? '', url: r.z!.url ?? '' }, zoteroItemKey: r.z!.itemKey })))
  if (r.entry && !r.inZotero) {
    const save = button('Save to Zotero', async () => {
      save.disabled = true
      save.textContent = 'Saving…'
      try {
        host.setStatus(await saveToZotero(r.entry!), 'ok')
      } catch (e) {
        host.setStatus(`Couldn't save to Zotero: ${(e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`, 'error')
      }
      await refresh()
    })
    acts.append(save)
  }
  if (r.z) acts.append(button('Show in Zotero', () => window.open(`zotero://select/library/items/${r.z!.itemKey}`)))
  div.append(head, title, who, uses, acts)
  return div
}

function button(label: string, onClick: () => void, cls = '') {
  const b = document.createElement('button')
  b.textContent = label
  b.className = cls
  b.onclick = onClick
  return b
}
