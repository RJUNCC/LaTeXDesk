// File → Import Document: Word (.docx, also Google Docs → Download → .docx), LibreOffice (.odt), Markdown and
// HTML become a complete LaTeX document. Everything is turned into HTML first, then into LaTeX by the same
// converter Visual mode uses for pasting (from Overleaf). Images, footnotes and equations, which that converter
// doesn't handle, are swapped for placeholder words before conversion and put back as LaTeX afterwards.
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import mammoth from 'mammoth'
import { marked } from 'marked'
import { convertHtmlStringToLatex } from '@/features/source-editor/extensions/visual/paste-html'
import { ommlToLatex } from './omml'

export type ImportResult = {
  tex: string
  /** images to write into the project, as base64 */
  images: { path: string; base64: string }[]
  /** images the document links to by a relative path, to copy from beside it into the project */
  linked: { src: string; path: string }[]
  warnings: string[]
}

type Maths = { latex: string; display: boolean }[]

// placeholders are plain letters and digits, so the HTML→LaTeX converter passes them through untouched
const token = (kind: string, n: number) => `LDX${kind}${n}XDL`
const TOKEN_RE = /LDX(MATH|IMG|FN)(\d+)XDL/g

export async function importDocument(fileName: string, bytes: Uint8Array, imageDir: string): Promise<ImportResult> {
  const ext = fileName.split('.').pop()!.toLowerCase()
  const warnings: string[] = []
  const maths: Maths = []
  let html: string
  if (ext === 'docx') {
    const pre = extractWordMaths(bytes, maths)
    const result = await mammoth.convertToHtml(
      { arrayBuffer: pre.buffer.slice(pre.byteOffset, pre.byteOffset + pre.byteLength) as ArrayBuffer },
      {
        styleMap: ["p[style-name='Title'] => h1.ld-title:fresh", "p[style-name='Subtitle'] => p.ld-subtitle:fresh"],
        convertImage: mammoth.images.imgElement(image => image.read('base64').then(data => ({ src: `data:${image.contentType};base64,${data}` }))),
      }
    )
    html = result.value
    if (result.messages.some(m => /comment|tracked|text box/i.test(m.message))) warnings.push('Comments, tracked changes and text boxes were left out.')
  } else if (ext === 'odt') {
    html = odtToHtml(bytes, warnings)
  } else if (ext === 'md' || ext === 'markdown') {
    html = markdownToHtml(new TextDecoder().decode(bytes), maths)
  } else if (ext === 'html' || ext === 'htm') {
    html = new TextDecoder().decode(bytes)
  } else {
    // plain text: paragraphs separated by blank lines
    html = new TextDecoder()
      .decode(bytes)
      .split(/\n\s*\n/)
      .map(p => `<p>${p.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)}</p>`)
      .join('')
  }
  return htmlToDocument(html, maths, imageDir, fileName, warnings)
}

// ---------- Word equations ----------

/** Replace each Word equation with a placeholder run (remembering its LaTeX), so mammoth keeps its position. */
function extractWordMaths(bytes: Uint8Array, maths: Maths): Uint8Array {
  const files = unzipSync(bytes)
  let changed = false
  for (const part of ['word/document.xml', 'word/footnotes.xml', 'word/endnotes.xml']) {
    if (!files[part]) continue
    const xml = new DOMParser().parseFromString(strFromU8(files[part]), 'application/xml')
    const W = xml.documentElement.lookupNamespaceURI('w') ?? 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
    const all = [...xml.getElementsByTagNameNS('*', 'oMathPara'), ...[...xml.getElementsByTagNameNS('*', 'oMath')].filter(m => m.parentElement?.localName !== 'oMathPara')]
    for (const el of all) {
      // an equation alone in its paragraph is displayed; one inside a sentence is inline
      const para = el.closest('p') ?? el.parentElement
      const ownText = para
        ? [...para.getElementsByTagNameNS(W, 't')].filter(t => !t.closest('oMath, oMathPara') && !(t.parentElement && isInsideMath(t))).map(t => t.textContent ?? '').join('')
        : ''
      const display = el.localName === 'oMathPara' || !ownText.trim()
      maths.push({ latex: ommlToLatex(el), display })
      const run = xml.createElementNS(W, 'w:r')
      const t = xml.createElementNS(W, 'w:t')
      t.setAttribute('xml:space', 'preserve')
      t.textContent = token('MATH', maths.length - 1)
      run.append(t)
      el.replaceWith(run)
      changed = true
    }
    files[part] = strToU8(new XMLSerializer().serializeToString(xml))
  }
  return changed ? zipSync(files) : bytes
}

const isInsideMath = (el: Element) => {
  for (let p = el.parentElement; p; p = p.parentElement) if (p.localName === 'oMath' || p.localName === 'oMathPara') return true
  return false
}

// ---------- Markdown ----------

function markdownToHtml(md: string, maths: Maths) {
  // protect $…$ / $$…$$ maths from the Markdown parser
  const protectedMd = md
    .replace(/\$\$([\s\S]+?)\$\$/g, (_m, tex: string) => (maths.push({ latex: tex.trim(), display: true }), `\n\n${token('MATH', maths.length - 1)}\n\n`))
    .replace(/(^|[^\\$])\$([^$\n]+?)\$/g, (_m, pre: string, tex: string) => (maths.push({ latex: tex.trim(), display: false }), `${pre}${token('MATH', maths.length - 1)}`))
  return marked.parse(protectedMd, { async: false, gfm: true }) as string
}

// ---------- LibreOffice (.odt) ----------

function odtToHtml(bytes: Uint8Array, warnings: string[]) {
  const files = unzipSync(bytes)
  const xml = new DOMParser().parseFromString(strFromU8(files['content.xml']), 'application/xml')
  // automatic styles say which spans are bold / italic / underlined
  const styles = new Map<string, { b: boolean; i: boolean; u: boolean }>()
  for (const s of xml.getElementsByTagNameNS('*', 'style')) {
    const tp = [...s.children].find(c => c.localName === 'text-properties')
    if (!tp) continue
    const attr = (n: string) => [...tp.attributes].find(a => a.localName === n)?.value
    styles.set(s.getAttribute('style:name') ?? '', { b: attr('font-weight') === 'bold', i: attr('font-style') === 'italic', u: !!attr('text-underline-style') && attr('text-underline-style') !== 'none' })
  }
  const esc = (s: string) => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)
  let notes = 0
  let formulas = 0
  const html = (el: Element): string =>
    [...el.childNodes]
      .map(n => {
        if (n.nodeType === Node.TEXT_NODE) return esc(n.textContent ?? '')
        if (n.nodeType !== Node.ELEMENT_NODE) return ''
        const e = n as Element
        const inner = () => html(e)
        switch (e.localName) {
          case 'h': {
            const level = Math.min(5, Number(e.getAttribute('text:outline-level') ?? 1))
            return `<h${level}>${inner()}</h${level}>`
          }
          case 'p':
            return `<p>${inner()}</p>`
          case 'span': {
            const st = styles.get(e.getAttribute('text:style-name') ?? '')
            let s = inner()
            if (st?.b) s = `<b>${s}</b>`
            if (st?.i) s = `<i>${s}</i>`
            if (st?.u) s = `<u>${s}</u>`
            return s
          }
          case 'a':
            return `<a href="${esc(e.getAttribute('xlink:href') ?? '')}">${inner()}</a>`
          case 'list':
            return `<ul>${inner()}</ul>`
          case 'list-item':
            return `<li>${inner()}</li>`
          case 'table':
            return `<table>${inner()}</table>`
          case 'table-row':
            return `<tr>${inner()}</tr>`
          case 'table-cell':
            return `<td>${inner()}</td>`
          case 'table-header-rows':
          case 'table-rows':
            return inner()
          case 'line-break':
            return '<br>'
          case 's':
            return ' '
          case 'tab':
            return ' '
          case 'note': {
            const body = [...e.children].find(c => c.localName === 'note-body')
            notes++
            return body ? `<sup data-ld-note="${encodeURIComponent(html(body))}"></sup>` : ''
          }
          case 'frame': {
            const img = [...e.children].find(c => c.localName === 'image')
            const obj = [...e.children].find(c => c.localName === 'object')
            if (obj) formulas++
            const href = img?.getAttribute('xlink:href')
            const data = href && files[href]
            if (!data) return ''
            const ext = href!.split('.').pop()!.toLowerCase()
            const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'gif' ? 'image/gif' : 'image/png'
            let bin = ''
            for (let i = 0; i < data.length; i += 0x8000) bin += String.fromCharCode(...data.subarray(i, i + 0x8000))
            return `<img src="data:${mime};base64,${btoa(bin)}">`
          }
          case 'sequence-decls':
          case 'tracked-changes':
          case 'annotation':
            return ''
          default:
            return inner()
        }
      })
      .join('')
  const body = xml.getElementsByTagNameNS('*', 'text')[0]
  const out = body ? html(body) : ''
  if (formulas) warnings.push(`${formulas} equation${formulas > 1 ? 's' : ''} in the .odt file weren't converted (save it as .docx in LibreOffice to keep equations).`)
  void notes
  return out
}

// ---------- HTML → LaTeX document ----------

function htmlToDocument(html: string, maths: Maths, imageDir: string, fileName: string, warnings: string[]): ImportResult {
  const doc = new DOMParser().parseFromString(`<!doctype html><html><body>${html}</body></html>`, 'text/html')
  const body = doc.body
  const images: ImportResult['images'] = []
  const linked: ImportResult['linked'] = []
  const footnotes: string[] = []

  // title (Word's Title style) and subtitle
  const titleEl = body.querySelector('h1.ld-title')
  const title = titleEl?.textContent?.trim() ?? ''
  titleEl?.remove()
  const subtitleEl = body.querySelector('p.ld-subtitle')
  const subtitle = subtitleEl?.textContent?.trim() ?? ''
  subtitleEl?.remove()

  // footnotes: mammoth links <sup><a href="#footnote-1">[1]</a></sup> to a list at the end; ODT notes are inline
  for (const ref of [...body.querySelectorAll('a[href^="#footnote-"], a[href^="#endnote-"]')]) {
    const target = body.querySelector(`[id="${ref.getAttribute('href')!.slice(1)}"]`)
    if (!target) continue
    target.querySelectorAll('a[href^="#footnote-ref-"], a[href^="#endnote-ref-"]').forEach(a => a.remove())
    footnotes.push(target.innerHTML)
    const sup = ref.closest('sup') ?? ref
    sup.replaceWith(doc.createTextNode(token('FN', footnotes.length - 1)))
  }
  body.querySelectorAll('ol').forEach(ol => {
    if (ol.querySelector('li[id^="footnote-"], li[id^="endnote-"]') && !ol.querySelector('li:not([id^="footnote-"]):not([id^="endnote-"])')) ol.remove()
  })
  for (const sup of [...body.querySelectorAll('sup[data-ld-note]')]) {
    footnotes.push(decodeURIComponent(sup.getAttribute('data-ld-note')!))
    sup.replaceWith(doc.createTextNode(token('FN', footnotes.length - 1)))
  }

  // images: embedded ones are saved into the project; linked ones are referenced by path
  const figures: string[] = []
  for (const img of [...body.querySelectorAll('img')]) {
    const src = img.getAttribute('src') ?? ''
    const m = /^data:image\/([a-z+]+);base64,(.+)$/i.exec(src)
    let path: string
    if (m) {
      const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase().replace('svg+xml', 'svg')
      if (!['png', 'jpg', 'pdf'].includes(ext)) {
        warnings.push(`An image in ${ext.toUpperCase()} format was skipped (pdflatex can't use it).`)
        img.remove()
        continue
      }
      path = `${imageDir}/image${images.length + 1}.${ext}`
      images.push({ path, base64: m[2] })
    } else if (src && !/^[a-z]+:/i.test(src) && /\.(png|jpe?g|pdf)$/i.test(src)) {
      path = `${imageDir}/${decodeURIComponent(src).split(/[\\/]/).pop()}`
      linked.push({ src: decodeURIComponent(src), path })
    } else {
      if (src) warnings.push(`An image (${src.slice(0, 60)}) was left out: only PNG, JPG and PDF images can be used.`)
      img.remove()
      continue
    }
    figures.push(path.replace(/\.(png|jpe?g|pdf)$/i, ''))
    const marker = doc.createElement('p')
    marker.textContent = token('IMG', figures.length - 1)
    // a figure is a block: lift it out of the paragraph it was in
    const block = img.closest('p, li, td, h1, h2, h3, h4, h5, h6')
    if (block && block.tagName === 'P' && !block.textContent?.trim()) block.replaceWith(marker)
    else if (block && block.tagName === 'P') (block.after(marker), img.remove())
    else img.replaceWith(marker)
  }

  const convert = (fragment: string) => (convertHtmlStringToLatex(`<html><body>${fragment}</body></html>`, 0) ?? '').trim()
  let tex = convert(body.innerHTML)
  tex = tex.replace(TOKEN_RE, (_m, kind: string, n: string) => {
    const i = Number(n)
    if (kind === 'MATH') return maths[i].display ? `\n\\[\n  ${maths[i].latex}\n\\]\n` : `$${maths[i].latex}$`
    if (kind === 'IMG') return `\n\\begin{figure}[h]\n  \\centering\n  \\includegraphics[width=0.8\\linewidth]{${figures[i]}}\n\\end{figure}\n`
    return `\\footnote{${convert(footnotes[i]).replace(TOKEN_RE, (_x, k: string, j: string) => (k === 'MATH' ? `$${maths[Number(j)].latex}$` : ''))}}`
  })
  tex = tex.replace(/\n{3,}/g, '\n\n').trim()

  const packages = ['amsmath', 'amssymb']
  if (figures.length) packages.push('graphicx')
  if (/\\href|\\url/.test(tex)) packages.push('hyperref')
  if (/\\(toprule|midrule|bottomrule)/.test(tex)) packages.push('booktabs')
  const docTitle = title || fileName.replace(/\.[^.]+$/, '')
  const lines = [
    '\\documentclass{article}',
    '\\usepackage[T1]{fontenc}',
    ...packages.map(p => `\\usepackage{${p}}`),
    '',
    `\\title{${escapeText(docTitle)}${subtitle ? `\\\\[0.5em]\\large ${escapeText(subtitle)}` : ''}}`,
    '\\author{}',
    '\\date{}',
    '',
    '\\begin{document}',
    '\\maketitle',
    '',
    tex,
    '',
    '\\end{document}',
    '',
  ]
  return { tex: lines.join('\n'), images, linked, warnings }
}

const escapeText = (s: string) => s.replace(/([\\{}%$&#_^~])/g, c => (c === '\\' ? '\\textbackslash{}' : c === '~' ? '\\textasciitilde{}' : c === '^' ? '\\textasciicircum{}' : `\\${c}`))
