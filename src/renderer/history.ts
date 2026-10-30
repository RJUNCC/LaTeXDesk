// Version history: snapshots of the project's text files in .texdesk/history, taken automatically after
// each successful compile (when something changed) and on demand. Content-addressed, so unchanged files
// cost nothing; old snapshots are thinned (all from today, one a day for a month, then one a week).
import { diffLines } from 'diff'
import type { AppHost } from './host'
import { panelEl, whenShown } from './panels'

type Snapshot = { id: string; time: number; label: string; files: Record<string, string> }
type Index = { snapshots: Snapshot[] }

const DIR = '.texdesk/history'
const INDEX = `${DIR}/index.json`
const TEXT = /\.(tex|bib|sty|cls|bst|txt|md|csv)$/i
const DAY = 86400000

let host: AppHost
let index: Index = { snapshots: [] }
let selected: string | null = null
let busy: Promise<unknown> = Promise.resolve()

const $ = <T extends HTMLElement>(sel: string) => panelEl('history').querySelector<T>(sel)!

async function sha1(text: string) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}

export function initHistory(h: AppHost) {
  host = h
  panelEl('history').innerHTML = `
    <div class="pane-title hist-bar">
      <input class="hist-label" placeholder="Label (optional), e.g. “sent to supervisor”">
      <button class="primary hist-snap">Snapshot now</button>
    </div>
    <div class="hist-body">
      <div class="hist-list"></div>
      <div class="hist-detail"></div>
    </div>`
  $('.hist-snap').onclick = () => {
    const label = $<HTMLInputElement>('.hist-label').value.trim()
    $<HTMLInputElement>('.hist-label').value = ''
    void snapshot(label || 'Manual snapshot', true)
  }
  host.onProjectOpened(() => void load())
  host.onCompiled(ok => ok && void snapshot('', false))
  whenShown('history', render)
}

async function load() {
  selected = null
  try {
    index = JSON.parse((await host.readProjectFile(INDEX)) ?? '{"snapshots":[]}')
  } catch {
    index = { snapshots: [] }
  }
  render()
}

/** Record the current state of every text file. Automatic snapshots are skipped when nothing changed. */
export function snapshot(label: string, manual: boolean) {
  busy = busy.then(async () => {
    const files: Record<string, string> = {}
    for (const f of host.files()) {
      if (!f.editable || !TEXT.test(f.path)) continue
      const text = await host.fileText(f.path)
      const hash = await sha1(text)
      files[f.path] = hash
      if (!(await host.readProjectFile(`${DIR}/objects/${hash}`).then(t => t != null))) await host.writeProjectFile(`${DIR}/objects/${hash}`, text)
    }
    const last = index.snapshots[index.snapshots.length - 1]
    if (!manual && last && JSON.stringify(last.files) === JSON.stringify(files)) return
    index.snapshots.push({ id: crypto.randomUUID(), time: Date.now(), label, files })
    await thin()
    await host.writeProjectFile(INDEX, JSON.stringify(index))
    render()
  }).catch(e => host.setStatus(`History snapshot failed: ${e}`, 'warn'))
  return busy
}

/** Keep everything from the last day, the newest per day for 30 days, then the newest per week; labelled ones always. */
async function thin(now = Date.now()) {
  const keep = new Set<string>()
  const buckets = new Map<string, Snapshot>()
  for (const s of index.snapshots) {
    const age = now - s.time
    if (age < DAY || s.label) {
      keep.add(s.id)
      continue
    }
    const bucket = age < 30 * DAY ? `d${Math.floor(s.time / DAY)}` : `w${Math.floor(s.time / (7 * DAY))}`
    const prev = buckets.get(bucket)
    if (!prev || s.time > prev.time) buckets.set(bucket, s)
  }
  buckets.forEach(s => keep.add(s.id))
  const dropped = index.snapshots.filter(s => !keep.has(s.id))
  if (!dropped.length) return
  index.snapshots = index.snapshots.filter(s => keep.has(s.id))
  // delete stored versions no remaining snapshot refers to
  const live = new Set(index.snapshots.flatMap(s => Object.values(s.files)))
  for (const hash of new Set(dropped.flatMap(s => Object.values(s.files)))) {
    if (!live.has(hash)) await host.deleteAppData(`${DIR}/objects/${hash}`)
  }
}

const readVersion = (hash: string) => host.readProjectFile(`${DIR}/objects/${hash}`).then(t => t ?? '')

function when(t: number) {
  const mins = Math.round((Date.now() - t) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const d = new Date(t)
  const sameDay = new Date().toDateString() === d.toDateString()
  return sameDay ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
}

/** Files that differ between a snapshot and the one before it. */
function changedFiles(i: number) {
  const s = index.snapshots[i]
  const prev = index.snapshots[i - 1]
  const paths = new Set([...Object.keys(s.files), ...Object.keys(prev?.files ?? {})])
  return [...paths].filter(p => s.files[p] !== prev?.files[p])
}

function render() {
  if (!host) return
  const list = $('.hist-list')
  if (!index.snapshots.length) {
    list.replaceChildren(Object.assign(document.createElement('div'), { className: 'muted hist-empty', textContent: 'No snapshots yet. One is taken automatically each time the document compiles cleanly.' }))
    $('.hist-detail').replaceChildren()
    return
  }
  list.replaceChildren(
    ...index.snapshots
      .map((s, i) => {
        const row = document.createElement('div')
        row.className = `hist-row${s.id === selected ? ' active' : ''}`
        const changed = changedFiles(i)
        row.innerHTML = '<span class="hist-when"></span><span class="hist-label-text"></span><span class="muted hist-count"></span>'
        row.querySelector('.hist-when')!.textContent = when(s.time)
        row.querySelector('.hist-label-text')!.textContent = s.label || 'Compiled'
        row.querySelector('.hist-count')!.textContent = i === 0 ? `${Object.keys(s.files).length} files` : `${changed.length} changed`
        row.onclick = () => ((selected = s.id), render(), void showSnapshot(i))
        return row
      })
      .reverse()
  )
}

async function showSnapshot(i: number) {
  const s = index.snapshots[i]
  const detail = $('.hist-detail')
  const head = document.createElement('div')
  head.className = 'hist-detail-head'
  head.textContent = `${s.label || 'Compiled'} · ${new Date(s.time).toLocaleString()}`
  const restoreAll = document.createElement('button')
  restoreAll.textContent = 'Restore all files'
  restoreAll.onclick = async () => {
    if (!confirm('Replace every file with its version from this snapshot? (Files created later are left alone. A snapshot of the current state is taken first.)')) return
    await snapshot('Before restoring', true)
    for (const [path, hash] of Object.entries(s.files)) await host.applyFileText(path, await readVersion(hash))
    host.setStatus('Restored all files from the snapshot', 'ok')
  }
  head.appendChild(restoreAll)
  const files = document.createElement('div')
  const changed = new Set(i === 0 ? Object.keys(s.files) : changedFiles(i))
  for (const path of Object.keys(s.files).sort((a, b) => Number(changed.has(b)) - Number(changed.has(a)))) {
    const row = document.createElement('div')
    row.className = `hist-file${changed.has(path) ? ' changed' : ''}`
    row.textContent = path
    row.title = 'Compare this version with the current file'
    row.onclick = () => void compare(path, s)
    files.appendChild(row)
  }
  detail.replaceChildren(head, files, Object.assign(document.createElement('div'), { className: 'hist-diff' }))
}

/** Side-by-side: the snapshot's version (left) against the file as it is now (right). */
async function compare(path: string, s: Snapshot) {
  const old = await readVersion(s.files[path])
  const now = host.fileExists(path) ? await host.fileText(path) : ''
  const box = $('.hist-diff')
  const head = document.createElement('div')
  head.className = 'hist-diff-head'
  head.innerHTML = '<span></span><span>Now</span>'
  head.firstElementChild!.textContent = `${path} · snapshot`
  const restore = document.createElement('button')
  restore.textContent = old === now ? 'Identical to now' : 'Restore this file'
  restore.disabled = old === now
  restore.onclick = async () => {
    await snapshot('Before restoring', true)
    await host.applyFileText(path, old)
    host.setStatus(`Restored ${path} (Ctrl+Z in the editor undoes it)`, 'ok')
    void compare(path, s)
  }
  const table = document.createElement('div')
  table.className = 'hist-sbs'
  let l = 1
  let r = 1
  const cell = (n: number | '', text: string, cls: string) => {
    const d = document.createElement('div')
    d.className = `sbs ${cls}`
    d.dataset.n = String(n)
    d.textContent = text
    return d
  }
  for (const part of diffLines(old, now)) {
    const lines = part.value.replace(/\n$/, '').split('\n')
    for (const line of lines) {
      if (part.removed) table.append(cell(l++, line, 'del'), cell('', '', 'gap'))
      else if (part.added) table.append(cell('', '', 'gap'), cell(r++, line, 'add'))
      else table.append(cell(l++, line, ''), cell(r++, line, ''))
    }
  }
  box.replaceChildren(head, restore, table)
}
