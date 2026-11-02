// File → Export to Word: the document (with its \input files, pictures, bibliography and numbering) as a .docx
// that people without LaTeX can read and edit, with equations as Word equations. Comments and suggested
// changes can go along as Word comments and tracked changes, so a reviewer can work in Word.
import * as pdfjs from 'pdfjs-dist'
import { parseBib } from './bib-project'
import { reviewFor } from './comments-panel'
import { MARK, Media, ReviewMarks, writeDocx } from './docx-writer'
import type { AppHost } from './host'
import { latexToDoc } from './latex-to-doc'
import type { FileReview } from './track-changes'

type Bridge = {
  readBinary(root: string, rel: string): Promise<string | null>
  exportWord(base64: string, defaultName: string, savePath?: string): Promise<string | null>
  openExported(path: string): Promise<void>
}
const bridge = (window as unknown as { texdesk: Bridge }).texdesk

const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '')
const normalize = (p: string) => {
  const out: string[] = []
  for (const part of p.split('/')) {
    if (part === '..') out.pop()
    else if (part && part !== '.') out.push(part)
  }
  return out.join('/')
}

// ---------- comments and suggestions → markers in the LaTeX ----------

/** Places inside the LaTeX where a marker would break it: maths, verbatim, command names and non-text arguments. */
function protectedRanges(text: string): [number, number][] {
  const ranges: [number, number][] = []
  const add = (re: RegExp, endOf: (m: RegExpMatchArray) => number) => {
    for (const m of text.matchAll(re)) ranges.push([m.index!, endOf(m)])
  }
  const after = (from: number, close: string) => {
    const i = text.indexOf(close, from)
    return i < 0 ? text.length : i + close.length
  }
  // inline and display maths, read in order so each $ pairs with the right one
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '%') {
      const nl = text.indexOf('\n', i)
      i = nl < 0 ? text.length : nl
    } else if (c === '\\' && (text[i + 1] === '(' || text[i + 1] === '[')) {
      const end = after(i + 2, text[i + 1] === '(' ? '\\)' : '\\]')
      ranges.push([i, end])
      i = end - 1
    } else if (c === '\\') i++
    else if (c === '$') {
      const close = text[i + 1] === '$' ? '$$' : '$'
      let j = i + close.length
      while (j < text.length && !text.startsWith(close, j)) j += text[j] === '\\' ? 2 : 1
      ranges.push([i, Math.min(text.length, j + close.length)])
      i = j + close.length - 1
    }
  }
  add(/\\begin\{(equation|align|gather|multline|eqnarray|flalign|alignat|displaymath|math|verbatim|lstlisting|minted|tikzpicture|tabular)\*?\}/g, m => after(m.index!, `\\end{${m[1]}`))
  // arguments that are names, keys or paths, not text
  add(/\\(?:cite\w*|[a-zA-Z]*ref|label|includegraphics|input|include|subfile|begin|end|url|href|usepackage|documentclass|bibliography\w*|addbibresource|newcommand|renewcommand|def|textcolor|color)\*?\s*(?:\[[^\]]*\]\s*)*\{/g, m => {
    let depth = 0
    for (let j = m.index! + m[0].length - 1; j < text.length; j++) {
      if (text[j] === '\\') j++
      else if (text[j] === '{') depth++
      else if (text[j] === '}' && --depth === 0) return j + 1
    }
    return text.length
  })
  return ranges
}

function safeAt(text: string, pos: number, ranges: [number, number][]) {
  if (ranges.some(([a, b]) => pos > a && pos < b)) return false
  // not inside a command name, or between a command and its arguments
  return !/\\[A-Za-z@]*\*?$/.test(text.slice(Math.max(0, pos - 40), pos))
}

const plain = (latex: string) =>
  latex
    .replace(/\\[A-Za-z]+\*?(\[[^\]]*\])?/g, '')
    .replace(/[{}]/g, '')
    .replace(/~/g, ' ')

/** The file's text with review markers inserted, and the review data the writer needs. */
function withMarks(text: string, review: FileReview, marks: ReviewMarks, skipped: { n: number }) {
  const ranges = protectedRanges(text)
  const inserts: { at: number; s: string; order: number }[] = []
  for (const c of review.comments) {
    if (c.resolved || c.to <= c.from) continue
    if (!safeAt(text, c.from, ranges) || !safeAt(text, c.to, ranges)) {
      skipped.n++
      continue
    }
    inserts.push({ at: c.from, s: `${MARK.start}c${c.id}${MARK.close}`, order: 2 }, { at: c.to, s: `${MARK.end}c${c.id}${MARK.close}`, order: 0 })
    marks.comments.set(c.id, { author: c.author, date: c.date, text: c.text, replies: c.replies })
  }
  for (const ch of review.changes) {
    if (!safeAt(text, ch.from, ranges) || (ch.kind === 'insert' && !safeAt(text, ch.to, ranges))) {
      skipped.n++
      continue
    }
    if (ch.kind === 'insert') {
      inserts.push({ at: ch.from, s: `${MARK.start}i${ch.id}${MARK.close}`, order: 3 }, { at: ch.to, s: `${MARK.end}i${ch.id}${MARK.close}`, order: 1 })
      marks.changes.set(ch.id, { kind: 'insert', author: ch.author, date: ch.date })
    } else {
      inserts.push({ at: ch.from, s: `${MARK.del}d${ch.id}${MARK.close}`, order: 2 })
      marks.changes.set(ch.id, { kind: 'delete', author: ch.author, date: ch.date, deleted: plain(ch.text) })
    }
  }
  // from the end, so positions stay valid; at one spot, things that end come before things that start
  inserts.sort((a, b) => b.at - a.at || b.order - a.order)
  let out = text
  for (const m of inserts) out = out.slice(0, m.at) + m.s + out.slice(m.at)
  return out
}

// ---------- pictures ----------

async function imageSize(bytes: Uint8Array, type: string) {
  const bmp = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>], { type }))
  const size = { width: bmp.width, height: bmp.height }
  bmp.close()
  return size
}

/** The first page of a PDF figure, as a PNG Word can show. */
async function pdfToPng(bytes: Uint8Array): Promise<Media> {
  pdfjs.GlobalWorkerOptions.workerSrc ||= './pdf.worker.min.mjs'
  const doc = await pdfjs.getDocument({ data: bytes }).promise
  const page = await doc.getPage(1)
  const vp = page.getViewport({ scale: 3 })
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(vp.width)
  canvas.height = Math.ceil(vp.height)
  const g = canvas.getContext('2d')!
  g.fillStyle = '#fff'
  g.fillRect(0, 0, canvas.width, canvas.height)
  await page.render({ canvasContext: g, viewport: vp }).promise
  void doc.destroy()
  const blob = await new Promise<Blob>(r => canvas.toBlob(b => r(b!), 'image/png'))
  // sized as the PDF page (points → pixels at 96 dpi)
  const natural = page.getViewport({ scale: 1 })
  return { data: new Uint8Array(await blob.arrayBuffer()), ext: 'png', width: natural.width / 0.75, height: natural.height / 0.75 }
}

async function loadImages(host: AppHost, paths: string[], mainDir: string, graphicsPaths: string[], warnings: string[]) {
  const root = host.root()!
  const files = new Set(host.files().map(f => f.path))
  const out = new Map<string, Media | null>()
  for (const p of new Set(paths)) {
    let found: string | null = null
    for (const dir of ['', ...graphicsPaths]) {
      for (const ext of ['', '.png', '.jpg', '.jpeg', '.pdf', '.gif', '.PNG', '.JPG']) {
        const candidate = normalize(mainDir + dir + p + ext)
        if (files.has(candidate)) {
          found = candidate
          break
        }
      }
      if (found) break
    }
    if (!found) {
      warnings.push(`Picture not found: ${p}`)
      out.set(p, null)
      continue
    }
    try {
      const b64 = await bridge.readBinary(root, found)
      if (!b64) throw new Error('unreadable')
      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
      if (/\.pdf$/i.test(found)) out.set(p, await pdfToPng(bytes))
      else if (/\.(png|jpe?g|gif)$/i.test(found)) {
        const ext = /\.png$/i.test(found) ? 'png' : /\.gif$/i.test(found) ? 'gif' : 'jpeg'
        out.set(p, { data: bytes, ext, ...(await imageSize(bytes, `image/${ext}`)) })
      } else {
        warnings.push(`${found}: this picture format can’t go into Word (use PNG, JPG or PDF)`)
        out.set(p, null)
      }
    } catch {
      warnings.push(`Couldn’t read the picture ${found}`)
      out.set(p, null)
    }
  }
  return out
}

// ---------- the export ----------

export type WordExport = { path: string; warnings: string[]; counts: Record<string, number>; reviewItems: number; skipped: number }

/** Merge \input/\include'd files into one text (as LaTeX does), adding review markers on the way. */
async function gather(host: AppHost, path: string, mainDir: string, includeReview: boolean, marks: ReviewMarks, skipped: { n: number }, seen = new Set<string>()): Promise<string> {
  if (seen.has(path)) return ''
  seen.add(path)
  let text = await host.fileText(path)
  if (includeReview) text = withMarks(text, reviewFor(path, text), marks, skipped)
  const files = new Set(host.files().map(f => f.path))
  const parts: string[] = []
  let last = 0
  for (const m of text.matchAll(/\\(input|include|subfile)\s*\{([^}]+)\}/g)) {
    // not when commented out
    const lineStart = text.lastIndexOf('\n', m.index!) + 1
    if (/(^|[^\\])%/.test(text.slice(lineStart, m.index))) continue
    const target = normalize(mainDir + m[2].trim())
    const file = files.has(target) ? target : files.has(`${target}.tex`) ? `${target}.tex` : null
    if (!file) continue
    parts.push(text.slice(last, m.index), m[1] === 'include' ? '\\clearpage\n' : '', await gather(host, file, mainDir, includeReview, marks, skipped, seen))
    last = m.index! + m[0].length
  }
  parts.push(text.slice(last))
  return parts.join('')
}

/** Ask what to include; resolves false if cancelled. */
function askOptions(reviewCount: number): Promise<{ includeReview: boolean } | null> {
  return new Promise(resolve => {
    const dlg = document.createElement('dialog')
    dlg.className = 'export-word'
    dlg.innerHTML = `<form method="dialog">
      <h3>Export to Word</h3>
      <p class="muted">Makes a .docx with the same headings, lists, tables, pictures, footnotes, references and numbering. Equations become Word equations you can edit.</p>
      ${reviewCount ? `<label class="check"><input type="checkbox" class="ew-review" checked> Include ${reviewCount} comment${reviewCount === 1 ? '' : 's'} and suggestion${reviewCount === 1 ? '' : 's'} (as Word comments and tracked changes)</label>` : ''}
      <menu><button value="ok" class="primary">Export…</button><button value="cancel">Cancel</button></menu></form>`
    document.body.append(dlg)
    dlg.addEventListener('close', () => {
      const box = dlg.querySelector<HTMLInputElement>('.ew-review')
      resolve(dlg.returnValue === 'ok' ? { includeReview: !!box?.checked } : null)
      dlg.remove()
    })
    dlg.showModal()
  })
}

/** Export the compiled document (`target`) to Word. `savePath` is for tests; normally the user picks. */
export async function exportWord(host: AppHost, target: string, savePath?: string): Promise<WordExport | null> {
  const root = host.root()
  if (!root) return null
  await host.save()
  const files = host.files()
  // how many open comments and suggestions the document's files have
  let reviewCount = 0
  for (const f of files.filter(f => f.path.endsWith('.tex'))) {
    const r = reviewFor(f.path, await host.fileText(f.path))
    reviewCount += r.comments.filter(c => !c.resolved).length + r.changes.length
  }
  const options = savePath ? { includeReview: true } : await askOptions(reviewCount)
  if (!options) return null
  host.setStatus('Exporting to Word…')
  const mainDir = dirOf(target)
  const marks: ReviewMarks = { comments: new Map(), changes: new Map() }
  const skipped = { n: 0 }
  const source = await gather(host, target, mainDir, options.includeReview && reviewCount > 0, marks, skipped)
  const base = target.replace(/^.*\//, '').replace(/\.tex$/i, '')
  const bib = new Map<string, Record<string, string>>()
  for (const f of files.filter(f => f.path.endsWith('.bib'))) for (const e of parseBib(await host.fileText(f.path), f.path)) bib.set(e.key, e.fields)
  const model = latexToDoc(source, {
    aux: (await host.readProjectFile(`.texdesk/${base}.aux`)) ?? undefined,
    bbl: (await host.readProjectFile(`.texdesk/${base}.bbl`)) ?? undefined,
    bib,
  })
  const warnings = [...model.warnings]
  if (skipped.n) warnings.push(`${skipped.n} comment${skipped.n === 1 ? '' : 's'} or suggestion${skipped.n === 1 ? '' : 's'} inside equations or commands couldn’t be placed; the text is exported as it is now`)
  const graphicsPaths = [...(source.match(/\\graphicspath\s*\{((?:\{[^}]*\})+)\}/)?.[1].matchAll(/\{([^}]*)\}/g) ?? [])].map(m => m[1].replace(/\/?$/, '/'))
  const imagePaths = model.blocks.flatMap(b => (b.kind === 'image' ? [b.path] : []))
  const images = await loadImages(host, imagePaths.map(p => p.replace(/[\uE000-\uE003][^\uE001]*\uE001/g, '')), mainDir, graphicsPaths, warnings)
  // the writer looks pictures up by the path in the model
  for (const p of imagePaths) {
    const clean = p.replace(/[\uE000-\uE003][^\uE001]*\uE001/g, '')
    if (p !== clean) images.set(p, images.get(clean) ?? null)
  }
  const bytes = writeDocx(model, images, options.includeReview ? marks : undefined)
  let b64 = ''
  for (let i = 0; i < bytes.length; i += 0x8000) b64 += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  const path = await bridge.exportWord(btoa(b64), `${base}.docx`, savePath)
  if (!path) {
    host.setStatus('')
    return null
  }
  const result = { path, warnings, counts: model.counts, reviewItems: marks.comments.size + marks.changes.size, skipped: skipped.n }
  host.setStatus(`Exported to ${path.replace(/^.*[\\/]/, '')}`, warnings.length ? 'warn' : 'ok')
  if (!savePath) showReport(result)
  return result
}

function showReport(r: WordExport) {
  const dlg = document.createElement('dialog')
  dlg.className = 'wide export-report'
  const c = r.counts
  const bits = [c.equations && `${c.equations} equation${c.equations === 1 ? '' : 's'}`, c.figures && `${c.figures} picture${c.figures === 1 ? '' : 's'}`, c.tables && `${c.tables} table${c.tables === 1 ? '' : 's'}`, c.footnotes && `${c.footnotes} footnote${c.footnotes === 1 ? '' : 's'}`, r.reviewItems && `${r.reviewItems} comment${r.reviewItems === 1 ? '' : 's'} and suggestion${r.reviewItems === 1 ? '' : 's'}`].filter(Boolean)
  dlg.innerHTML = `<h3>✓ Exported to Word</h3><p class="muted"></p><p></p><div class="ex-warn"></div><menu><button class="primary ew-open">Open in Word</button><button class="ew-ok">OK</button></menu>`
  dlg.querySelectorAll('p')[0].textContent = r.path
  dlg.querySelectorAll('p')[1].textContent = bits.length ? `Includes ${bits.join(', ')}.` : ''
  dlg.querySelector('.ex-warn')!.replaceChildren(...r.warnings.map(w => Object.assign(document.createElement('div'), { className: 'dr-problem', textContent: `⚠ ${w}` })))
  dlg.querySelector<HTMLButtonElement>('.ew-open')!.onclick = () => (void bridge.openExported(r.path), dlg.close())
  dlg.querySelector<HTMLButtonElement>('.ew-ok')!.onclick = () => dlg.close()
  dlg.addEventListener('close', () => dlg.remove())
  document.body.append(dlg)
  dlg.showModal()
}
