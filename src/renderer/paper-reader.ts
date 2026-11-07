// The Paper tab: read a source's PDF beside your writing. The PDF comes from Zotero when the paper has one there,
// else a free copy online (arXiv, or an open-access copy), downloaded only when you press Read and kept for next time.
// When there's none to download, you can get it from the paper's page yourself, or choose a PDF you already have.
// Notes on the paper sit under it (paper-notes.ts); selected text in the PDF can be quoted into them.
import type { AppHost } from './host'
import { addQuote, initPaperNotes, saveNotes, showNotes } from './paper-notes'
import { PdfViewer } from './pdf-viewer'
import { panelEl, showPanel } from './panels'

type Fields = Record<string, string>
/** `key` is the paper's citation key, which names its note (notes/<key>.md). */
export type Paper = { key?: string; title: string; fields: Fields; zoteroItemKey?: string }

type Got = { bytes: Uint8Array; from: string }
const api = (window as unknown as {
  texdesk: {
    research: {
      paperPdf(fields: Fields, zoteroItemKey?: string): Promise<Got | { error: string; page?: string }>
      choosePaperPdf(fields: Fields): Promise<Got | null>
      paperFromPage(fields: Fields, page: string): Promise<Got | null>
    }
  }
}).texdesk.research
const $ = <T extends HTMLElement>(sel: string) => panelEl('reader').querySelector<T>(sel)!
const tab = () => document.querySelector<HTMLButtonElement>('#side-tabs button[data-panel="reader"]')!

let viewer: PdfViewer | null = null
let opening = 0
let host: AppHost

export function initPaperReader(h: AppHost) {
  host = h
}

const store = (k: string, v?: string) => {
  try {
    if (v === undefined) return localStorage.getItem(k)
    localStorage.setItem(k, v)
  } catch {}
  return null
}

function init() {
  panelEl('reader').innerHTML = `
    <div class="pane-title reader-bar">
      <span class="reader-title"></span>
      <div class="spacer"></div>
      <button class="icon reader-notes-toggle" title="Show or hide your notes on this paper">📝</button>
      <button class="icon reader-out" title="Zoom out">−</button>
      <span class="reader-zoom">100%</span>
      <button class="icon reader-in" title="Zoom in">+</button>
      <button class="icon reader-fit" title="Fit width">⤢</button>
      <button class="icon reader-close" title="Close the paper">×</button>
    </div>
    <div class="reader-note muted"></div>
    <div class="reader-pdf"></div>
    <div class="reader-split" title="Drag to resize the notes"></div>
    <div class="reader-notes"></div>
    <button class="reader-quote" hidden title="Quote the selected text in your notes, with its page number">📝 Add to notes</button>`
  viewer = new PdfViewer($('.reader-pdf'))
  viewer.selectableText = true
  initPaperNotes(host, $('.reader-notes'))
  setupNotesLayout()
  setupQuoting()
  viewer.onScaleChange = s => ($('.reader-zoom').textContent = `${Math.round(s * 100)}%`)
  $('.reader-in').onclick = () => viewer!.zoom(1.15)
  $('.reader-out').onclick = () => viewer!.zoom(1 / 1.15)
  $('.reader-fit').onclick = () => viewer!.fit()
  $('.reader-close').onclick = closePaper
  return viewer
}

/** The notes pane under the PDF: shown or hidden with 📝 (remembered), its height set by dragging the divider. */
function setupNotesLayout() {
  const notes = $('.reader-notes'), split = $('.reader-split')
  const show = (on: boolean) => {
    notes.hidden = split.hidden = !on
    $('.reader-notes-toggle').classList.toggle('active', on)
    store('texdesk.paperNotes', on ? '1' : '0')
  }
  show(store('texdesk.paperNotes') !== '0')
  $('.reader-notes-toggle').onclick = () => show(!!notes.hidden)
  const saved = Number(store('texdesk.paperNotesHeight'))
  if (saved > 0) notes.style.height = `${saved}px`
  split.onmousedown = down => {
    down.preventDefault()
    const panel = panelEl('reader').getBoundingClientRect()
    const move = (ev: MouseEvent) => (notes.style.height = `${Math.round(Math.min(panel.height - 140, Math.max(90, panel.bottom - ev.clientY)))}px`)
    const up = () => {
      removeEventListener('mousemove', move)
      removeEventListener('mouseup', up)
      store('texdesk.paperNotesHeight', String(notes.offsetHeight))
    }
    addEventListener('mousemove', move)
    addEventListener('mouseup', up)
  }
}

/** Selecting text in the PDF shows "Add to notes" by it, which quotes it in the note with its page number. */
function setupQuoting() {
  const pdf = $('.reader-pdf'), button = $<HTMLButtonElement>('.reader-quote')
  let picked: { text: string; page: number | null } | null = null
  const hide = () => ((button.hidden = true), (picked = null))
  // as in pdf.js's viewer: while dragging, the layer's end marker covers the page so the selection doesn't jump
  pdf.addEventListener('mousedown', ev => (ev.target as Element).closest?.('.textLayer')?.classList.add('selecting'))
  pdf.addEventListener('mouseup', () =>
    setTimeout(() => {
      pdf.querySelectorAll('.textLayer.selecting').forEach(l => l.classList.remove('selecting'))
      const sel = getSelection()
      const chosen = sel?.toString().trim()
      if (!sel || !chosen || !sel.rangeCount || !pdf.contains(sel.anchorNode)) return hide()
      const pageEl = (sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode?.parentElement)?.closest<HTMLElement>('.pdf-page')
      picked = { text: sel.toString(), page: Number(pageEl?.dataset.page) || null }
      const r = sel.getRangeAt(0).getBoundingClientRect(), panel = panelEl('reader').getBoundingClientRect()
      button.style.left = `${Math.max(4, Math.min(panel.width - 130, r.left - panel.left))}px`
      button.style.top = `${Math.max(4, r.bottom - panel.top + 6)}px`
      button.hidden = false
    })
  )
  pdf.addEventListener('scroll', hide)
  button.onmousedown = ev => ev.preventDefault() // keep the selection
  button.onclick = () => {
    if (!picked) return
    if ($('.reader-notes').hidden) $<HTMLButtonElement>('.reader-notes-toggle').click()
    addQuote(picked.text, picked.page)
    getSelection()?.removeAllRanges()
    hide()
  }
}

/** A note name for a paper with no citation key (from its title). */
const keyOf = (p: Paper) => p.key || p.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'paper'

/** Where the paper can be seen online when there's no PDF to show here: its link, else its DOI's page. */
function pageOf(f: Fields) {
  const url = f.url || f.howpublished?.match(/\\url\{([^}]*)\}/)?.[1]
  if (url && /^https?:\/\//.test(url)) return url
  const doi = f.doi?.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
  return doi ? `https://doi.org/${doi}` : null
}

/** Show the paper's PDF in the Paper tab (next to the PDF and AI tabs). */
export async function openPaper(p: Paper) {
  const v = viewer ?? init()
  const token = ++opening
  tab().hidden = false
  tab().title = p.title
  showPanel('reader')
  $('.reader-title').textContent = p.title
  $('.reader-title').title = p.title
  const note = $('.reader-note')
  note.textContent = 'Finding the PDF…'
  note.hidden = false
  v.clear()
  void showNotes({ key: keyOf(p), title: p.title }, v)
  const res = await api.paperPdf(p.fields, p.zoteroItemKey).catch(e => ({ error: String((e as Error).message ?? e), page: undefined }))
  if (token !== opening) return
  if ('bytes' in res) return show(v, res)
  noPdf(p, res.error.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), res.page)
}

async function show(v: PdfViewer, got: Got) {
  await v.load(new Uint8Array(got.bytes))
  $('.reader-note').textContent = `From ${got.from}`
}

/** No PDF to download: say why, and offer the paper's page (download it there) or a PDF the user already has. */
function noPdf(p: Paper, message: string, freePage?: string) {
  const note = $('.reader-note')
  note.textContent = message
  const actions = document.createElement('div')
  actions.className = 'reader-actions'
  const button = (label: string, title: string, get: () => Promise<Got | null>, waiting: string) => {
    const b = Object.assign(document.createElement('button'), { textContent: label, title })
    b.onclick = async () => {
      const token = opening
      actions.querySelectorAll('button').forEach(x => (x.disabled = true))
      const hint = Object.assign(document.createElement('div'), { className: 'reader-wait', textContent: waiting })
      note.append(hint)
      const got = await get().catch(() => null)
      if (token !== opening) return
      hint.remove()
      actions.querySelectorAll('button').forEach(x => (x.disabled = false))
      if (got) await show(viewer!, got)
    }
    actions.append(b)
  }
  const page = freePage ?? pageOf(p.fields)
  if (page)
    button('Open its page', 'Opens the paper’s page in a window. Download the PDF there and it shows here.', () => api.paperFromPage(p.fields, page),
      'Download the PDF in the window that opened (look for a Download or PDF button). It will show here.')
  button('Choose a PDF…', 'Already have the PDF (from your browser or school library)? Pick it and it shows here from now on.', () => api.choosePaperPdf(p.fields), 'Choose the PDF in the file window…')
  if (page) actions.append(Object.assign(document.createElement('a'), { href: page, target: '_blank', textContent: 'or open it in your browser' }))
  note.append(actions)
}

export function closePaper() {
  void saveNotes()
  opening++
  viewer?.clear()
  tab().hidden = true
  showPanel('pdf')
}
