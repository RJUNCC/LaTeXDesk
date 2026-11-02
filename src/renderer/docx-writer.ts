// Writes the document model from latex-to-doc.ts as a Word file (.docx): styles, numbered lists, footnotes,
// tables, pictures, editable equations, and the project's comments and suggestions as Word comments and
// tracked changes.
import { strToU8, zipSync } from 'fflate'
import type { Block, DocModel, Run, Style } from './latex-to-doc'
import { latexToOmml } from './mathml-omml'

export type Media = { data: Uint8Array; ext: 'png' | 'jpeg' | 'gif'; width: number; height: number }
export type ReviewMarks = {
  comments: Map<string, { author: string; date: number; text: string; replies: { author: string; date: number; text: string }[] }>
  changes: Map<string, { kind: 'insert' | 'delete'; author: string; date: number; deleted?: string }>
}

/** Review markers placed in the LaTeX before conversion: start, end, and a deletion point. */
export const MARK = { start: '', end: '', del: '', close: '' }
const MARKER = /([ic])([^]*)|([ic])([^]*)|d([^]*)/g
export const stripMarks = (s: string) => s.replace(MARKER, '')

/** The lines of an equation array that is the whole formula (aligned equations), else null. */
function eqArrRows(omml: string): string[] | null {
  if (!omml.startsWith('<m:eqArr>') || !omml.endsWith('</m:eqArr>')) return null
  const body = omml.slice('<m:eqArr>'.length, -'</m:eqArr>'.length)
  const rows: string[] = []
  let depth = 0
  let start = 0
  for (const m of body.matchAll(/<m:e>|<\/m:e>/g)) {
    if (m[0] === '<m:e>') {
      if (depth++ === 0) start = m.index! + 5
    } else if (--depth === 0) rows.push(body.slice(start, m.index))
  }
  return rows
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F-]/g, '')
const TEXT_WIDTH_PT = 468
const iso = (t: number) => new Date(t).toISOString().replace(/\.\d+Z$/, 'Z')

class Writer {
  rels: { id: string; type: string; target: string; external?: boolean }[] = []
  // links inside footnotes belong to the footnotes part, which has its own relationships
  footnoteRels: { id: string; type: string; target: string; external?: boolean }[] = []
  inFootnote = false
  media: { name: string; data: Uint8Array }[] = []
  footnotes: string[] = []
  comments: string[] = []
  commentIds = new Map<string, number>()
  markId = 100
  drawingId = 1
  ins: { author: string; date: number } | null = null
  usedToc = false

  constructor(readonly model: DocModel, readonly images: Map<string, Media | null>, readonly review?: ReviewMarks) {}

  rel(type: string, target: string, external = false) {
    const list = this.inFootnote ? this.footnoteRels : this.rels
    const id = `rId${list.length + 10}`
    list.push({ id, type, target, external })
    return id
  }

  // ---------- runs ----------

  rPr(s: Style & { rStyle?: string }) {
    const p: string[] = []
    if (s.rStyle) p.push(`<w:rStyle w:val="${s.rStyle}"/>`)
    if (s.mono) p.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>')
    if (s.b) p.push('<w:b/>')
    if (s.i) p.push('<w:i/>')
    if (s.sc) p.push('<w:smallCaps/>')
    if (s.strike) p.push('<w:strike/>')
    if (s.color) p.push(`<w:color w:val="${s.color}"/>`)
    if (s.size) p.push(`<w:sz w:val="${Math.round(s.size * 2)}"/>`)
    if (s.u) p.push('<w:u w:val="single"/>')
    if (s.sup) p.push('<w:vertAlign w:val="superscript"/>')
    if (s.sub) p.push('<w:vertAlign w:val="subscript"/>')
    return p.length ? `<w:rPr>${p.join('')}</w:rPr>` : ''
  }

  /** One text run, wrapped as a tracked insertion while one is open. */
  textRun(text: string, style: Style & { rStyle?: string }) {
    if (!text) return ''
    const parts = text.split('\n')
    const inner = parts.map((t, i) => (i ? '<w:br/>' : '') + `<w:t xml:space="preserve">${esc(t)}</w:t>`).join('')
    const r = `<w:r>${this.rPr(style)}${inner}</w:r>`
    return this.ins ? `<w:ins w:id="${this.markId++}" w:author="${esc(this.ins.author)}" w:date="${iso(this.ins.date)}">${r}</w:ins>` : r
  }

  /** Text that may contain review markers. */
  text(text: string, style: Style & { rStyle?: string }) {
    let out = ''
    let last = 0
    for (const m of text.matchAll(MARKER)) {
      out += this.textRun(text.slice(last, m.index), style)
      last = m.index! + m[0].length
      out += this.mark(m)
    }
    return out + this.textRun(text.slice(last), style)
  }

  mark(m: RegExpMatchArray) {
    const r = this.review
    if (!r) return ''
    const [, startKind, startId, endKind, endId, delId] = m
    if (startKind === 'i' && r.changes.has(startId)) this.ins = r.changes.get(startId)!
    else if (endKind === 'i') this.ins = null
    else if (startKind === 'c' && r.comments.has(startId)) {
      const n = this.commentIds.size
      this.commentIds.set(startId, n)
      return `<w:commentRangeStart w:id="${n}"/>`
    } else if (endKind === 'c' && this.commentIds.has(endId)) {
      const n = this.commentIds.get(endId)!
      this.commentXml(endId, n)
      return `<w:commentRangeEnd w:id="${n}"/><w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="${n}"/></w:r>`
    } else if (delId && r.changes.get(delId)?.deleted) {
      const c = r.changes.get(delId)!
      return `<w:del w:id="${this.markId++}" w:author="${esc(c.author)}" w:date="${iso(c.date)}"><w:r><w:delText xml:space="preserve">${esc(c.deleted!)}</w:delText></w:r></w:del>`
    }
    return ''
  }

  commentXml(id: string, n: number) {
    const c = this.review!.comments.get(id)!
    const initials = c.author.split(/\s+/).map(w => w[0] ?? '').join('').slice(0, 3).toUpperCase()
    const para = (body: string, first: boolean) =>
      `<w:p><w:pPr><w:pStyle w:val="CommentText"/></w:pPr>${first ? '<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:annotationRef/></w:r>' : ''}<w:r><w:t xml:space="preserve">${esc(body)}</w:t></w:r></w:p>`
    const paras = [para(c.text, true), ...c.replies.map(r => para(`${r.author}: ${r.text}`, false))]
    this.comments.push(`<w:comment w:id="${n}" w:author="${esc(c.author)}" w:date="${iso(c.date)}" w:initials="${esc(initials)}">${paras.join('')}</w:comment>`)
  }

  runs(list: Run[], base: Style & { rStyle?: string } = {}): string {
    let out = ''
    for (const r of list) {
      if (r.kind === 'text') {
        const { kind: _k, text, link, ...style } = r
        const merged = { ...base, ...style }
        if (link && /^(https?|mailto):/i.test(link)) {
          const id = this.rel('http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink', link, true)
          out += `<w:hyperlink r:id="${id}" w:history="1">${this.text(text, { ...merged, rStyle: 'Hyperlink' })}</w:hyperlink>`
        } else out += this.text(text, merged)
      } else if (r.kind === 'math') {
        out += latexToOmml(stripMarks(r.tex), false, this.model.macros)
      } else if (r.kind === 'break') {
        out += '<w:r><w:br/></w:r>'
      } else if (r.kind === 'footnote') {
        const id = this.footnotes.length + 1
        const saved = this.ins
        this.ins = null
        this.inFootnote = true
        const inner = r.blocks
          .map((b, i) =>
            b.kind === 'para'
              ? `<w:p><w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr>${i === 0 ? '<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> </w:t></w:r>' : ''}${this.runs(b.runs)}</w:p>`
              : ''
          )
          .join('')
        this.ins = saved
        this.inFootnote = false
        this.footnotes.push(`<w:footnote w:id="${id}">${inner || '<w:p><w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr><w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r></w:p>'}</w:footnote>`)
        out += `<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="${id}"/></w:r>`
      }
    }
    return out
  }

  // ---------- blocks ----------

  pPr(o: { style?: string; keepNext?: boolean; num?: { num: number; level: number }; indent?: number; align?: string }) {
    const p: string[] = []
    if (o.style) p.push(`<w:pStyle w:val="${o.style}"/>`)
    if (o.keepNext) p.push('<w:keepNext/>')
    if (o.num) p.push(`<w:numPr><w:ilvl w:val="${o.num.level}"/><w:numId w:val="${o.num.num + 1}"/></w:numPr>`)
    if (o.indent) p.push(`<w:ind w:left="${o.indent * 720}"/>`)
    if (o.align) p.push(`<w:jc w:val="${o.align === 'both' ? 'both' : o.align}"/>`)
    return p.length ? `<w:pPr>${p.join('')}</w:pPr>` : ''
  }

  block(b: Block): string {
    switch (b.kind) {
      case 'para':
        return `<w:p>${this.pPr({ style: b.style, keepNext: b.keepNext, num: b.list, indent: b.list ? 0 : b.indent, align: b.align })}${this.runs(b.runs)}</w:p>`
      case 'heading':
        return `<w:p>${this.pPr({ style: `Heading${Math.min(4, b.level)}` })}${this.runs(b.runs)}</w:p>`
      case 'equation': {
        const omml = latexToOmml(stripMarks(b.tex), true, this.model.macros)
        if (!b.numbers.some(Boolean)) return `<w:p>${this.pPr({ style: 'Equation' })}${omml}</w:p>`
        // Word's own numbered equations: the number after # in an equation array, set at the right margin
        const number = (n: string | null) => (n ? `<m:r><m:t>#</m:t></m:r><m:d><m:e><m:r><m:rPr><m:nor/></m:rPr><m:t>${esc(n)}</m:t></m:r></m:e></m:d>` : '')
        const inner = omml.replace(/^<m:oMathPara><m:oMath>/, '').replace(/<\/m:oMath><\/m:oMathPara>$/, '')
        const lines = b.numbers.length > 1 ? eqArrRows(inner) : null
        // align: each line keeps its own number
        const rows = lines && lines.length === b.numbers.length ? lines.map((l, i) => l + number(b.numbers[i])) : [inner + number(b.numbers.filter(Boolean).join(', '))]
        return `<w:p>${this.pPr({ style: 'Equation' })}<m:oMathPara><m:oMath><m:eqArr><m:eqArrPr><m:maxDist m:val="1"/></m:eqArrPr>${rows.map(r => `<m:e>${r}</m:e>`).join('')}</m:eqArr></m:oMath></m:oMathPara></w:p>`
      }
      case 'pagebreak':
        return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>'
      case 'toc':
        this.usedToc = true
        return (
          `<w:p><w:pPr><w:pStyle w:val="TOCHeading"/></w:pPr><w:r><w:t>Contents</w:t></w:r></w:p>` +
          `<w:p><w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>Right-click here and choose Update Field to show the table of contents.</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`
        )
      case 'image':
        return this.image(b)
      case 'table':
        return this.table(b)
    }
  }

  image(b: Extract<Block, { kind: 'image' }>) {
    const m = this.images.get(b.path)
    if (!m) return `<w:p>${this.pPr({ align: 'center' })}${this.textRun(`[Picture not found: ${stripMarks(b.path)}]`, { i: true })}</w:p>`
    // points: as given in the LaTeX, else the picture's own size (96 dpi), never wider than the text
    const aspect = m.height / m.width
    let w = b.width ?? (b.height ? b.height / aspect : b.scale ? m.width * 0.75 * b.scale : m.width * 0.75)
    let h = b.height && b.width ? b.height : w * aspect
    if (w > TEXT_WIDTH_PT) (h *= TEXT_WIDTH_PT / w), (w = TEXT_WIDTH_PT)
    const name = `image${this.media.length + 1}.${m.ext}`
    this.media.push({ name, data: m.data })
    const rid = this.rel('http://schemas.openxmlformats.org/officeDocument/2006/relationships/image', `media/${name}`)
    const cx = Math.round(w * 12700)
    const cy = Math.round(h * 12700)
    const id = this.drawingId++
    return `<w:p>${this.pPr({ align: 'center', keepNext: true })}<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="Picture ${id}" descr="${esc(b.path)}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`
  }

  table(b: Extract<Block, { kind: 'table' }>) {
    // a small starting width: Word widens each column to fit its contents (autofit)
    const colW = 600
    const line = (sz: number) => `w:val="single" w:sz="${sz}" w:space="0" w:color="000000"`
    const tblBorders =
      b.rules === 'grid' ? `<w:tblBorders><w:top ${line(4)}/><w:left ${line(4)}/><w:bottom ${line(4)}/><w:right ${line(4)}/><w:insideH ${line(4)}/><w:insideV ${line(4)}/></w:tblBorders>` : ''
    const rows = b.rows.map((row, ri) => {
      const last = ri === b.rows.length - 1
      const cells = row.cells.map(c => {
        // booktabs: a heavy rule above and below the table, a light one under the header
        const borders: string[] = []
        if (b.rules === 'booktabs') {
          if (ri === 0) borders.push(`<w:top ${line(12)}/>`)
          if (row.header) borders.push(`<w:bottom ${line(6)}/>`)
          else if (last) borders.push(`<w:bottom ${line(12)}/>`)
        }
        const tcPr = `<w:tcPr><w:tcW w:w="0" w:type="auto"/>${c.span > 1 ? `<w:gridSpan w:val="${c.span}"/>` : ''}${borders.length ? `<w:tcBorders>${borders.join('')}</w:tcBorders>` : ''}</w:tcPr>`
        return `<w:tc>${tcPr}<w:p>${this.pPr({ style: 'TableText', align: c.align })}${this.runs(c.runs)}</w:p></w:tc>`
      })
      // rows short of cells still need them, or Word reports the file as damaged
      const filled = row.cells.reduce((n, c) => n + c.span, 0)
      for (let k = filled; k < b.cols; k++) cells.push(`<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr><w:p/></w:tc>`)
      return `<w:tr>${row.header ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${cells.join('')}</w:tr>`
    })
    const grid = `<w:tblGrid>${Array.from({ length: b.cols }, () => `<w:gridCol w:w="${colW}"/>`).join('')}</w:tblGrid>`
    // an empty paragraph after a table keeps two tables (or a table and a caption) apart
    return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:jc w:val="center"/>${tblBorders}<w:tblLayout w:type="autofit"/><w:tblCellMar><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr>${grid}${rows.join('')}</w:tbl><w:p>${this.pPr({ style: 'AfterTable' })}</w:p>`
  }

  // ---------- the package ----------

  build(): Uint8Array {
    const body = this.model.blocks.map(b => this.block(b)).join('')
    const page = this.model.paper === 'a4' ? '<w:pgSz w:w="11906" w:h="16838"/>' : '<w:pgSz w:w="12240" w:h="15840"/>'
    const ns =
      'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"'
    const xml = (s: string) => strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${s}`)
    const document = `<w:document ${ns}><w:body>${body}<w:sectPr>${page}<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`
    const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
    const fixed = [
      { id: 'rId1', type: `${R}/styles`, target: 'styles.xml' },
      { id: 'rId2', type: `${R}/numbering`, target: 'numbering.xml' },
      { id: 'rId3', type: `${R}/footnotes`, target: 'footnotes.xml' },
      { id: 'rId4', type: `${R}/settings`, target: 'settings.xml' },
      ...(this.comments.length ? [{ id: 'rId5', type: `${R}/comments`, target: 'comments.xml' }] : []),
    ]
    const relXml = (list: { id: string; type: string; target: string; external?: boolean }[]) =>
      list.map(r => `<Relationship Id="${r.id}" Type="${r.type}" Target="${esc(r.target)}"${r.external ? ' TargetMode="External"' : ''}/>`).join('')
    const rels = relXml([...fixed, ...this.rels])
    const files: Record<string, Uint8Array> = {
      '[Content_Types].xml': xml(
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="gif" ContentType="image/gif"/>` +
          `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>${this.comments.length ? '<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>' : ''}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`
      ),
      '_rels/.rels': xml(`<Relationships xmlns="${R.replace('officeDocument/2006/relationships', 'package/2006/relationships')}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`),
      'docProps/core.xml': xml(
        `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(this.model.title)}</dc:title><dc:creator>${esc(this.model.author)}</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${iso(Date.now())}</dcterms:created></cp:coreProperties>`
      ),
      'word/document.xml': xml(document),
      'word/_rels/document.xml.rels': xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`),
      'word/styles.xml': xml(STYLES),
      'word/numbering.xml': xml(this.numbering()),
      'word/footnotes.xml': xml(
        `<w:footnotes ${ns}><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>${this.footnotes.join('')}</w:footnotes>`
      ),
      'word/settings.xml': xml(
        `<w:settings ${ns}>${this.usedToc ? '<w:updateFields w:val="true"/>' : ''}<w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/><w:footnotePr><w:footnote w:id="-1"/><w:footnote w:id="0"/></w:footnotePr><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat><m:mathPr><m:mathFont m:val="Cambria Math"/><m:brkBin m:val="before"/><m:smallFrac m:val="0"/><m:dispDef/><m:lMargin m:val="0"/><m:rMargin m:val="0"/><m:defJc m:val="centerGroup"/><m:intLim m:val="subSup"/><m:naryLim m:val="undOvr"/></m:mathPr></w:settings>`
      ),
    }
    if (this.comments.length) files['word/comments.xml'] = xml(`<w:comments ${ns}>${this.comments.join('')}</w:comments>`)
    if (this.footnoteRels.length) files['word/_rels/footnotes.xml.rels'] = xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relXml(this.footnoteRels)}</Relationships>`)
    for (const m of this.media) files[`word/media/${m.name}`] = m.data
    return zipSync(files, { level: 6 })
  }

  numbering() {
    const ns = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
    const bullets = ['•', '◦', '▪']
    const formats = ['decimal', 'lowerLetter', 'lowerRoman']
    const abstract = this.model.lists
      .map((def, i) => {
        const levels = Array.from({ length: 9 }, (_, l) => {
          const fmt = def.type === 'bullet' ? 'bullet' : formats[l % 3]
          const text = def.type === 'bullet' ? bullets[l % 3] : fmt === 'lowerLetter' ? `(%${l + 1})` : `%${l + 1}.`
          return `<w:lvl w:ilvl="${l}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 * (l + 1)}" w:hanging="360"/></w:pPr>${def.type === 'bullet' ? '<w:rPr><w:rFonts w:ascii="Cambria" w:hAnsi="Cambria"/></w:rPr>' : ''}</w:lvl>`
        }).join('')
        return `<w:abstractNum w:abstractNumId="${i}"><w:multiLevelType w:val="hybridMultilevel"/>${levels}</w:abstractNum>`
      })
      .join('')
    const nums = this.model.lists.map((_, i) => `<w:num w:numId="${i + 1}"><w:abstractNumId w:val="${i}"/></w:num>`).join('')
    return `<w:numbering ${ns}>${abstract}${nums}</w:numbering>`
  }
}

/** Styles in the spirit of a LaTeX article: a serif font, numbered headings, centred title and captions. */
const STYLES = `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Cambria" w:hAnsi="Cambria" w:eastAsia="Cambria" w:cs="Times New Roman"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/><w:jc w:val="both"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="240" w:after="240"/><w:jc w:val="center"/></w:pPr><w:rPr><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:style>
<w:style w:type="paragraph" w:customStyle="1" w:styleId="Author"><w:name w:val="Author"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="60"/><w:jc w:val="center"/></w:pPr><w:rPr><w:sz w:val="26"/></w:rPr></w:style>
<w:style w:type="paragraph" w:customStyle="1" w:styleId="Date"><w:name w:val="Date"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="360"/><w:jc w:val="center"/></w:pPr><w:rPr><w:sz w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="360" w:after="120"/><w:jc w:val="left"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="300" w:after="120"/><w:jc w:val="left"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="240" w:after="100"/><w:jc w:val="left"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="200" w:after="80"/><w:jc w:val="left"/><w:outlineLvl w:val="3"/></w:pPr><w:rPr><w:b/><w:i/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="TOCHeading"><w:name w:val="TOC Heading"/><w:basedOn w:val="Heading1"/><w:next w:val="Normal"/><w:pPr><w:outlineLvl w:val="9"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="60" w:after="240"/><w:jc w:val="center"/></w:pPr><w:rPr><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style>
<w:style w:type="paragraph" w:customStyle="1" w:styleId="Equation"><w:name w:val="Equation"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="120" w:after="120"/><w:jc w:val="center"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:ind w:left="720" w:right="720"/></w:pPr></w:style>
<w:style w:type="paragraph" w:customStyle="1" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/><w:ind w:left="360"/><w:jc w:val="left"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="19"/></w:rPr></w:style>
<w:style w:type="paragraph" w:customStyle="1" w:styleId="Abstract"><w:name w:val="Abstract"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="720" w:right="720"/></w:pPr><w:rPr><w:sz w:val="20"/></w:rPr></w:style>
<w:style w:type="paragraph" w:customStyle="1" w:styleId="AbstractTitle"><w:name w:val="Abstract Title"/><w:basedOn w:val="Normal"/><w:next w:val="Abstract"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="60"/><w:jc w:val="center"/></w:pPr><w:rPr><w:b/><w:sz w:val="20"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Bibliography"><w:name w:val="Bibliography"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="480" w:hanging="480"/><w:jc w:val="left"/></w:pPr><w:rPr><w:sz w:val="20"/></w:rPr></w:style>
<w:style w:type="paragraph" w:customStyle="1" w:styleId="TableText"><w:name w:val="Table Text"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="40" w:after="40" w:line="240" w:lineRule="auto"/><w:jc w:val="left"/></w:pPr><w:rPr><w:sz w:val="20"/></w:rPr></w:style>
<w:style w:type="paragraph" w:customStyle="1" w:styleId="AfterTable"><w:name w:val="After Table"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0" w:line="120" w:lineRule="exact"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="FootnoteText"><w:name w:val="footnote text"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="FootnoteReference"><w:name w:val="footnote reference"/><w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="1F5FA8"/><w:u w:val="single"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="CommentText"><w:name w:val="annotation text"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="left"/></w:pPr><w:rPr><w:sz w:val="20"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="CommentReference"><w:name w:val="annotation reference"/><w:rPr><w:sz w:val="16"/></w:rPr></w:style>
</w:styles>`

export function writeDocx(model: DocModel, images: Map<string, Media | null>, review?: ReviewMarks): Uint8Array {
  return new Writer(model, images, review).build()
}
