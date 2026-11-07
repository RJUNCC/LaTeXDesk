// 📚 Sources: references for people who have never seen a .bib file. Find a source by link, DOI, ISBN, title or
// a pasted reference (or a whole pasted list), fill one in with plain labels, import a file, cite with one
// click, and pick the reference style by name. The .bib file and \bibliography lines are written for them.
import type { AppHost } from './host'
import { BibEntry, addEntries, bibEntries, bibTarget, citedKeys, declareBibliography, parseBib, replaceEntry } from './bib-project'
import { BIB_STYLES, applyStyle, citeCommand, currentStyle, hasBibliography, lockedReason } from './bib-style'
import {
  Fields,
  SOURCE_TYPES,
  blankValues,
  citeLabel,
  classifyPaste,
  entryToForm,
  formToEntry,
  formatEntry,
  makeKey,
  parseRis,
  plain,
  readableReference,
  safeEntry,
  safeFields,
  sourceType,
  titleMatch,
} from './bib-sources'
import { openPaper } from './paper-reader'
import { insertCite, mayHavePdf, zoteroItemFor } from './zotero-client'
import { refreshCitations } from '@/features/source-editor/extensions/visual/citations'

type Candidate = { id: string; kind: 'doi' | 'isbn'; title: string; authors: string[]; year: number | null; venue: string; type: string }
type Cited = { key: string; kind: string; type: string; bibtex: string; fields: Fields }
type Bridge = {
  research: { cite(input: string): Promise<Cited>; match(text: string): Promise<Candidate[]> }
  chooseSources(): Promise<{ name: string; text: string }[]>
}
const api = (window as unknown as { texdesk: Bridge }).texdesk

let host: AppHost
let dlg: HTMLDialogElement
let entries: BibEntry[] = []
let citeCounts = new Map<string, number>()
// the style a new reference list gets (the dialog's choice before there is one)
let chosenStyle = BIB_STYLES[0].id

const q = <T extends HTMLElement>(sel: string) => dlg.querySelector<T>(sel)!
function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props)
  e.append(...children)
  return e
}
const button = (label: string, onClick: () => void, cls = '') => el('button', { type: 'button', textContent: label, className: cls, onclick: onClick })
const cleanError = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export function initSources(h: AppHost) {
  host = h
  dlg = el('dialog', { id: 'sources-dialog', className: 'wide sources' })
  dlg.innerHTML = `
    <form method="dialog">
      <div class="src-top"><h3>📚 Sources</h3><button value="close" class="icon" title="Close (Esc)">✕</button></div>
      <p class="muted src-intro">Add the books, articles, websites and videos you use. Click <b>Cite</b> to mention one in your writing.
        The reference list at the end of the document is made for you, in the style you pick below.</p>
      <div class="src-find">
        <textarea class="src-input" rows="2" placeholder="Paste a web address, DOI or ISBN, type a title, or paste references copied from anywhere (one per line)"></textarea>
        <div class="src-row">
          <button type="button" class="primary src-lookup">Look up</button>
          <button type="button" class="src-manual">Fill it in yourself</button>
          <button type="button" class="src-import" title="A .bib or .ris file exported from Google Scholar, EasyBib, Scribbr, Mendeley, EndNote or a library website">Import a file…</button>
          <span class="muted src-online">Looking up uses the internet (Crossref, Open Library, doi.org).</span>
        </div>
        <div class="src-out"></div>
      </div>
      <div class="src-list-head"><strong class="src-count">Your sources</strong><input class="src-filter" placeholder="Search your sources"></div>
      <ul class="src-list"></ul>
      <div class="src-style">
        <label>Reference style <select class="src-style-select"></select></label>
        <div class="muted src-style-note"></div>
      </div>
    </form>`
  document.body.append(dlg)
  const input = q<HTMLTextAreaElement>('.src-input')
  q('.src-lookup').onclick = () => void lookup(input.value)
  // Enter looks up a single line; pasted lists keep their line breaks
  input.onkeydown = e => {
    if (e.key === 'Enter' && !e.shiftKey && !input.value.includes('\n')) {
      e.preventDefault()
      void lookup(input.value)
    }
  }
  q('.src-manual').onclick = () => showForm({ values: guessValues(input.value) })
  q('.src-import').onclick = async () => {
    const files = await api.chooseSources()
    if (files.length) showResult(await importSources(files))
  }
  q<HTMLInputElement>('.src-filter').oninput = () => renderList()
  q<HTMLSelectElement>('.src-style-select').onchange = e => void changeStyle((e.target as HTMLSelectElement).value)
}

export async function openSources() {
  if (!host.root()) return host.setStatus('Open or create a project first', 'warn')
  q<HTMLTextAreaElement>('.src-input').value = ''
  q('.src-out').replaceChildren()
  q<HTMLInputElement>('.src-filter').value = ''
  await Promise.all([refreshList(), renderStyle()])
  if (!dlg.open) dlg.showModal()
  q<HTMLTextAreaElement>('.src-input').focus()
}

// ---------- the main document ----------

async function mainText() {
  const main = host.mainFile()
  return main && host.fileExists(main) ? { main, text: await host.fileText(main) } : null
}

/** Make sure the document prints a reference list, in the chosen style. */
async function ensureBibliography() {
  const doc = await mainText()
  if (!doc || hasBibliography(doc.text)) return
  const { file } = await bibTarget(host)
  if (lockedReason(doc.text)) return declareBibliography(host, file)
  await host.applyFileText(doc.main, applyStyle(doc.text, chosenStyle, file.replace(/^.*\//, '').replace(/\.bib$/, '')))
}

/** Changes to the sources show in the visual editor's citations straight away. */
function refreshVisual() {
  host.view.dispatch({ effects: refreshCitations.of(null) })
}

// ---------- adding ----------

/** Add BibTeX entries (raw text) to the project, declaring the reference list if needed. Returns the keys added. */
async function addRaw(raws: string[]) {
  if (!raws.length) return []
  await ensureBibliography()
  const added = await addEntries(host, raws.join('\n\n'))
  await refreshList()
  refreshVisual()
  return added
}

const titleKey = (f: Fields) => plain(f.title).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
/** The same work: same DOI, ISBN or web page, or the same title and year. */
const sameSource = (a: Fields, b: Fields) =>
  (!!a.doi && a.doi.toLowerCase() === b.doi?.toLowerCase()) ||
  (!!a.isbn && a.isbn.replace(/-/g, '') === b.isbn?.replace(/-/g, '')) ||
  (!!a.url && a.url === b.url && !a.doi) ||
  (!!titleKey(a) && titleKey(a) === titleKey(b) && (a.year ?? '') === (b.year ?? ''))

/** A looked-up source as an entry with a key that's free in this project (or the existing entry for it). */
function prepare(c: { type: string; fields: Fields; key?: string }) {
  const existing = entries.find(e => sameSource(c.fields, e.fields))
  if (existing) return { existing }
  const taken = new Set(entries.map(e => e.key))
  const key = c.key && !taken.has(c.key) ? c.key : makeKey(c.fields, taken)
  // web pages and publishers send titles like "Harness^2" or "R&D": escape what LaTeX would read as commands
  return { key, raw: formatEntry(c.type, key, safeFields(c.fields)) }
}

async function addOne(c: { type: string; fields: Fields; key?: string }, cite: boolean) {
  const p = prepare(c)
  const key = p.existing ? p.existing.key : (await addRaw([p.raw!]), p.key!)
  const label = citeLabel(p.existing?.fields ?? c.fields)
  if (cite) return void (await citeKey(key))
  showResult(p.existing ? `This source is already in your list (${label.who}, ${label.year}).` : `Added ${label.who} (${label.year}).`, key)
}

/** Import .bib / .ris text (files or a paste). Also used by File → Add Existing File. */
export async function importSources(files: { name: string; text: string }[]) {
  await refreshList()
  const taken = new Set(entries.map(e => e.key))
  const raws: string[] = []
  let skipped = 0
  for (const f of files) {
    const kind = /\.ris$/i.test(f.name) || /^TY\s{1,2}-/m.test(f.text) ? 'ris' : 'bibtex'
    const found: { type: string; fields: Fields; key: string; raw?: string }[] =
      kind === 'ris' ? parseRis(f.text).map(r => ({ type: r.bibtype, fields: r.fields, key: '' })) : parseBib(f.text).map(e => ({ type: e.type, fields: e.fields, key: e.key, raw: e.raw }))
    for (const item of found) {
      if (entries.some(e => sameSource(item.fields, e.fields) || (e.key === item.key && e.fields.title === item.fields.title))) {
        skipped++
        continue
      }
      // BibTeX keeps its own text (and key, unless that key is taken by a different source)
      const key = item.key && !taken.has(item.key) ? item.key : makeKey(item.fields, taken)
      taken.add(key)
      raws.push(item.raw && key === item.key ? safeEntry(item.raw, item.fields) : formatEntry(item.type, key, safeFields(item.fields)))
    }
  }
  const added = await addRaw(raws)
  const names = files.map(f => f.name).join(', ')
  if (!added.length && !skipped) return `No sources found in ${names}.`
  return `Added ${added.length} source${added.length === 1 ? '' : 's'} from ${names}${skipped ? ` (${skipped} already in your list)` : ''}.`
}

// ---------- looking up ----------

/** A DOI, link, ISBN or arXiv id anywhere in the text (a pasted reference often ends with one). */
function identifierIn(text: string) {
  const doi = text.match(/\b10\.\d{4,9}\/[^\s"<>]+/)?.[0].replace(/[.,;)\]]+$/, '')
  if (doi) return doi
  const url = text.match(/https?:\/\/[^\s<>"]+/)?.[0].replace(/[.,;)\]]+$/, '')
  if (url) return url
  const t = text.trim()
  if (/^(isbn[:\s-]*)?[\d][\d\s-]{8,16}[\dxX]$/i.test(t) || /^(arxiv:)?\d{4}\.\d{4,5}(v\d+)?$/i.test(t)) return t
  return null
}

async function lookup(raw: string) {
  const text = raw.trim()
  if (!text) return
  const pasted = classifyPaste(text)
  if (pasted.kind === 'bibtex' || pasted.kind === 'ris') return showResult(await importSources([{ name: 'the pasted text', text }]))
  if (pasted.kind === 'list') return lookupList(pasted.items)
  const out = q('.src-out')
  out.replaceChildren(el('div', { className: 'muted', textContent: 'Looking up…' }))
  const id = identifierIn(text)
  try {
    if (id) {
      const c = await api.research.cite(id)
      return showFound(c)
    }
    const candidates = (await api.research.match(text)).map(c => ({ ...c, score: titleMatch(c.title, text) })).sort((a, b) => b.score - a.score)
    const good = candidates.filter((c, i) => c.score >= 0.5 || i < 3).slice(0, 5)
    if (!good.length) {
      out.replaceChildren(el('div', { className: 'muted', textContent: 'Nothing found. You can fill it in yourself.' }), button('Fill it in yourself', () => showForm({ values: guessValues(text) })))
      return
    }
    out.replaceChildren(
      el('div', { className: 'muted', textContent: good[0].score >= 0.75 ? 'Is it this one?' : 'Is it one of these?' }),
      el('ul', { className: 'src-candidates' }, ...good.map(c => candidateRow(c))),
      el('div', { className: 'src-row' }, el('span', { className: 'muted', textContent: 'Not here?' }), button('Fill it in yourself', () => showForm({ values: guessValues(text) })))
    )
  } catch (e) {
    out.replaceChildren(el('div', { className: 'error', textContent: cleanError(e) }), button('Fill it in yourself', () => showForm({ values: guessValues(text) })))
  }
}

function candidateRow(c: Candidate) {
  const who = c.authors.length > 2 ? `${c.authors[0]} et al.` : c.authors.join(' & ')
  const busy = (b: HTMLButtonElement) => ((b.disabled = true), (b.textContent = 'Adding…'))
  const add = (cite: boolean) => async (ev: Event) => {
    busy(ev.target as HTMLButtonElement)
    try {
      await addOne(await api.research.cite(c.id), cite)
    } catch (e) {
      showResult(`Couldn't add it: ${cleanError(e)}`)
    }
  }
  return el(
    'li',
    {},
    el('div', { className: 'src-cand-title', textContent: c.title }),
    el('div', { className: 'muted', textContent: [who, c.year, c.venue, c.kind === 'isbn' ? 'book' : ''].filter(Boolean).join(' · ') }),
    el('div', { className: 'src-acts' }, el('button', { type: 'button', className: 'primary', textContent: 'Add & cite here', onclick: add(true), disabled: !canCite() }), el('button', { type: 'button', textContent: 'Just add', onclick: add(false) }))
  )
}

function showFound(c: Cited) {
  const p = prepare(c)
  const label = citeLabel(p.existing?.fields ?? c.fields)
  q('.src-out').replaceChildren(
    el('div', { className: 'muted', textContent: p.existing ? 'Already in your sources:' : 'Found:' }),
    el('div', { className: 'src-found', textContent: readableReference(p.existing?.fields ?? c.fields) }),
    el(
      'div',
      { className: 'src-row' },
      p.existing
        ? el('button', { type: 'button', className: 'primary', textContent: 'Cite here', disabled: !canCite(), onclick: () => void citeKey(p.existing!.key) })
        : el('button', { type: 'button', className: 'primary', textContent: 'Add & cite here', disabled: !canCite(), onclick: () => void addOne(c, true) }),
      p.existing ? '' : button('Just add', () => void addOne(c, false)),
      button('Fix details…', () => {
        const { typeId, values } = entryToForm(c.type, p.existing?.fields ?? c.fields)
        if (p.existing) showForm({ typeId, values, editing: p.existing })
        else showForm({ typeId, values, base: c.fields })
      }),
      el('span', { className: 'muted', textContent: `${label.who}, ${label.year}` })
    )
  )
}

/** Several pasted references: look each up, then add the ones that were found in one go. */
async function lookupList(items: string[]) {
  const out = q('.src-out')
  const rows = items.map(text => ({ text, li: el('li', { className: 'src-batch-row' }, el('div', { className: 'src-batch-text', textContent: text }), el('div', { className: 'muted', textContent: 'Waiting…' })), found: null as Cited | null, box: null as HTMLInputElement | null }))
  const addBtn = el('button', { type: 'button', className: 'primary', textContent: 'Add checked sources', disabled: true })
  const note = el('span', { className: 'muted', textContent: `Looking up ${items.length} references…` })
  out.replaceChildren(el('ul', { className: 'src-batch' }, ...rows.map(r => r.li)), el('div', { className: 'src-row' }, addBtn, note))
  const update = () => {
    const n = rows.filter(r => r.box?.checked).length
    addBtn.disabled = !n
    addBtn.textContent = n ? `Add ${n} checked source${n === 1 ? '' : 's'}` : 'Add checked sources'
  }
  for (const r of rows) {
    const status = r.li.lastElementChild as HTMLElement
    status.textContent = 'Looking up…'
    try {
      const id = identifierIn(r.text)
      let c: Cited | null = null
      if (id) c = await api.research.cite(id)
      else {
        const best = (await api.research.match(r.text)).map(x => ({ ...x, score: titleMatch(x.title, r.text) })).sort((a, b) => b.score - a.score)[0]
        if (best && best.score >= 0.75) c = await api.research.cite(best.id)
      }
      if (!c) throw new Error('not found')
      const p = prepare(c)
      if (p.existing) {
        status.replaceChildren(`✓ Already in your sources: ${readableReference(p.existing.fields)}`)
        continue
      }
      r.found = c
      r.box = el('input', { type: 'checkbox', checked: true, onchange: update })
      status.replaceChildren(el('label', { className: 'check' }, r.box, ` ${readableReference(c.fields)}`))
      status.className = 'src-batch-found'
    } catch {
      status.className = 'muted'
      status.replaceChildren('Not found automatically. ', button('Fill it in yourself', () => showForm({ values: guessValues(r.text), after: r.li })))
    }
    update()
  }
  const found = rows.filter(r => r.found).length
  note.textContent = `Found ${found} of ${items.length}.${found < items.length ? ' Fill in the others yourself, or add them later.' : ''}`
  addBtn.onclick = async () => {
    const chosen = rows.filter(r => r.found && r.box?.checked)
    const taken = new Set(entries.map(e => e.key))
    const raws = chosen.map(r => {
      const key = r.found!.key && !taken.has(r.found!.key) ? r.found!.key : makeKey(r.found!.fields, taken)
      taken.add(key)
      return formatEntry(r.found!.type, key, r.found!.fields)
    })
    const added = await addRaw(raws)
    for (const r of chosen) {
      r.box!.disabled = true
      r.li.classList.add('added')
    }
    addBtn.disabled = true
    note.textContent = `Added ${added.length} source${added.length === 1 ? '' : 's'}. Click Cite next to one below to use it.`
  }
}

/** Starting values for the form from what was typed: a link becomes the URL, anything else the title. */
function guessValues(text: string): Fields {
  const t = text.trim()
  if (!t || t.includes('\n')) return {}
  const url = t.match(/^https?:\/\/\S+$/)?.[0]
  return url ? { url } : t.length < 200 ? { title: t } : {}
}

// ---------- the form ----------

function showForm(opts: { typeId?: string; values?: Fields; base?: Fields; editing?: BibEntry; after?: HTMLElement }) {
  let typeId = opts.typeId ?? 'website'
  let values: Fields = { ...blankValues(typeId), ...opts.values }
  const box = el('div', { className: 'src-form' })
  const render = () => {
    const t = sourceType(typeId)
    const types = el('div', { className: 'src-types' }, ...SOURCE_TYPES.map(s => el('button', { type: 'button', textContent: s.label, className: s.id === typeId ? 'active' : '', onclick: () => {
      collect()
      typeId = s.id
      values = { ...blankValues(typeId), ...values }
      render()
    } })))
    const grid = el('div', { className: 'src-fields' })
    for (const f of t.fields) {
      const id = `src-f-${f.name}`
      const input = f.options
        ? el('select', { id }, ...f.options.map(([v, label]) => el('option', { value: v, textContent: label, selected: (values[f.name] ?? f.options![0][0]) === v })))
        : f.multiline
          ? el('textarea', { id, rows: 2, placeholder: f.placeholder ?? '', value: values[f.name] ?? '' })
          : el('input', { id, placeholder: f.placeholder ?? '', value: values[f.name] ?? '' })
      input.dataset.field = f.name
      input.oninput = input.onchange = () => (collect(), preview())
      grid.append(el('label', { htmlFor: id, textContent: f.label }), input)
    }
    const pre = el('div', { className: 'src-preview muted' })
    const save = (cite: boolean) => async () => {
      collect()
      if (!values.title?.trim()) {
        pre.textContent = 'Please give it a title.'
        pre.className = 'src-preview error'
        return
      }
      const { bibtype, fields } = formToEntry(typeId, values, opts.editing?.fields ?? opts.base)
      if (opts.editing) {
        await replaceEntry(host, opts.editing, formatEntry(bibtype, opts.editing.key, fields))
        await refreshList()
        refreshVisual()
        if (cite) return void (await citeKey(opts.editing.key))
        return showResult(`Saved changes to ${citeLabel(fields).who} (${citeLabel(fields).year}).`, opts.editing.key)
      }
      if (opts.after) {
        // filling in one of a pasted list: keep the list, mark this row done
        const p = prepare({ type: bibtype, fields })
        if (!p.existing) await addRaw([p.raw!])
        box.replaceChildren(el('span', { textContent: `✓ Added ${citeLabel(fields).who} (${citeLabel(fields).year}).` }))
        return
      }
      await addOne({ type: bibtype, fields }, cite)
    }
    box.replaceChildren(
      el('div', { className: 'src-form-head' }, el('strong', { textContent: opts.editing ? 'Edit source' : 'What kind of source is it?' })),
      types,
      grid,
      pre,
      el(
        'div',
        { className: 'src-row' },
        el('button', { type: 'button', className: 'primary', textContent: opts.editing ? 'Save' : canCite() && !opts.after ? 'Add & cite here' : 'Add source', onclick: save(!opts.editing && !opts.after && canCite()) }),
        opts.editing || opts.after || !canCite() ? '' : button('Just add', save(false)),
        button('Cancel', () => (opts.after ? box.remove() : q('.src-out').replaceChildren()))
      )
    )
    preview()
    function preview() {
      pre.className = 'src-preview muted'
      pre.textContent = values.title?.trim() ? `Looks like: ${readableReference(formToEntry(typeId, values).fields)}` : ''
    }
  }
  function collect() {
    for (const input of box.querySelectorAll<HTMLInputElement>('[data-field]')) values[input.dataset.field!] = input.value
  }
  render()
  if (opts.after) {
    opts.after.querySelector('.src-form')?.remove()
    opts.after.append(box)
  } else q('.src-out').replaceChildren(box)
  box.querySelector<HTMLElement>('input, textarea')?.focus()
}

// ---------- the list ----------

async function refreshList() {
  const [byKey, uses] = await Promise.all([bibEntries(host), citedKeys(host)])
  entries = [...byKey.values()]
  citeCounts = new Map([...uses].map(([k, v]) => [k, v.length]))
  renderList()
}

function renderList() {
  const filter = q<HTMLInputElement>('.src-filter').value.toLowerCase()
  q('.src-count').textContent = `Your sources (${entries.length})`
  q<HTMLInputElement>('.src-filter').hidden = entries.length < 6
  const shown = entries
    .map(e => ({ e, text: readableReference(e.fields) }))
    .filter(x => !filter || `${x.text} ${x.e.key}`.toLowerCase().includes(filter))
    .sort((a, b) => a.text.localeCompare(b.text))
  q('.src-list').replaceChildren(
    ...(shown.length
      ? shown.map(({ e, text }) => {
          const n = citeCounts.get(e.key) ?? 0
          return el(
            'li',
            { className: 'src-item' },
            el('div', { className: 'src-ref', textContent: text }),
            el('div', { className: 'muted src-meta', textContent: `${n ? `cited ${n}×` : 'not cited yet'} · ${e.key}` }),
            el(
              'div',
              { className: 'src-acts' },
              el('button', { type: 'button', className: 'primary', textContent: 'Cite', title: canCite() ? 'Cite it where the cursor is' : 'Open a .tex file to cite', disabled: !canCite(), onclick: () => void citeKey(e.key) }),
              button('Edit', () => {
                const { typeId, values } = entryToForm(e.type, e.fields)
                showForm({ typeId, values, editing: e })
                q('.src-out').scrollIntoView({ block: 'nearest' })
              }),
              (() => {
                const z = zoteroItemFor(e.key, e.fields)
                if (!mayHavePdf(e.fields, !!z)) return ''
                const read = button('📄 Read', () => {
                  dlg.close()
                  void openPaper({ key: e.key, title: plain(e.fields.title) || e.key, fields: e.fields, zoteroItemKey: z?.itemKey })
                })
                read.title = 'Read the paper’s PDF beside your writing'
                return read
              })()
            )
          )
        })
      : [el('li', { className: 'muted src-empty', textContent: entries.length ? 'No match.' : 'No sources yet. Add one above.' })])
  )
}

// ---------- citing ----------

const canCite = () => /\.tex$/i.test(host.currentPath() ?? '')

async function citeKey(key: string) {
  if (!canCite()) return showResult('Open a .tex file first, then cite.')
  await ensureBibliography()
  const doc = await mainText()
  insertCite(host, key, doc ? citeCommand(doc.text) : 'cite')
  const e = entries.find(x => x.key === key)
  dlg.close()
  host.setStatus(`Cited ${e ? `${citeLabel(e.fields).who} (${citeLabel(e.fields).year})` : key}. Compile to see the reference list.`, 'ok')
}

function showResult(message: string, citeKeyAfter?: string) {
  q<HTMLTextAreaElement>('.src-input').value = ''
  q('.src-out').replaceChildren(
    el('div', { className: 'src-row' }, el('span', { textContent: `✓ ${message}` }), citeKeyAfter && canCite() ? el('button', { type: 'button', className: 'primary', textContent: 'Cite it here', onclick: () => void citeKey(citeKeyAfter) }) : '')
  )
  void renderStyle()
}

// ---------- the style ----------

async function renderStyle() {
  const select = q<HTMLSelectElement>('.src-style-select')
  const note = q('.src-style-note')
  const doc = await mainText()
  const locked = doc && lockedReason(doc.text)
  const listed = doc && hasBibliography(doc.text)
  const current = doc ? currentStyle(doc.text) : null
  const options = BIB_STYLES.map(s => el('option', { value: s.id, textContent: `${s.name}  ${s.example}` }))
  if (listed && current && !current.id) options.unshift(el('option', { value: '', textContent: `${current.name} (current)`, disabled: true }))
  select.replaceChildren(...options)
  select.value = listed ? (current?.id ?? '') : chosenStyle
  select.disabled = !!locked
  note.textContent = locked
    ? locked
    : listed
      ? 'Your reference list is at the end of the document. Change the style any time.'
      : 'The reference list is added at the end of the document when you add your first source.'
}

async function changeStyle(id: string) {
  chosenStyle = id
  const doc = await mainText()
  if (!doc || !hasBibliography(doc.text)) {
    if (doc && entries.length) await ensureBibliography()
    return renderStyle()
  }
  await host.applyFileText(doc.main, applyStyle(doc.text, id))
  refreshVisual()
  await renderStyle()
  q('.src-style-note').textContent = `Style changed to ${BIB_STYLES.find(s => s.id === id)?.name}. Compile to see it.`
}
