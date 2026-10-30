// CSV / spreadsheet data → a booktabs table or a pgfplots chart, with a live preview.
import type { EditorView } from '@codemirror/view'
import { FormatContext, insertRawBlock } from './format'

type Data = { header: string[]; rows: string[][] }

/** RFC 4180-ish parsing; the delimiter (tab, semicolon or comma) is detected from the first line. */
export function parseCsv(text: string): Data {
  const first = text.split(/\r?\n/)[0] ?? ''
  const delim = first.includes('\t') ? '\t' : (first.match(/;/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? ';' : ','
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') (cell += '"'), i++
      else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"' && !cell) quoted = true
    else if (ch === delim) row.push(cell.trim()), (cell = '')
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cell.trim())
      if (row.some(c => c)) rows.push(row)
      row = []
      cell = ''
    } else cell += ch
  }
  row.push(cell.trim())
  if (row.some(c => c)) rows.push(row)
  const width = Math.max(0, ...rows.map(r => r.length))
  const padded = rows.map(r => [...r, ...Array(width - r.length).fill('')])
  return { header: padded[0] ?? [], rows: padded.slice(1) }
}

const isNum = (s: string) => /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?%?$/.test(s.trim())
const num = (s: string) => parseFloat(s.replace('%', ''))
const texEscape = (s: string) =>
  s.replace(/\\/g, '\\textbackslash{}').replace(/([&%$#_{}])/g, '\\$1').replace(/~/g, '\\textasciitilde{}').replace(/\^/g, '\\textasciicircum{}')

export function tableLatex(d: Data, caption: string, headerRow: boolean) {
  const rows = headerRow ? d.rows : [d.header, ...d.rows]
  const numeric = d.header.map((_, c) => rows.every(r => !r[c] || isNum(r[c])))
  const spec = numeric.map(n => (n ? 'r' : 'l')).join('')
  const line = (cells: string[]) => `    ${cells.map(texEscape).join(' & ')} \\\\`
  return [
    '\\begin{table}[h]',
    '  \\centering',
    `  \\begin{tabular}{${spec}}`,
    '    \\toprule',
    ...(headerRow ? [line(d.header), '    \\midrule'] : []),
    ...rows.map(line),
    '    \\bottomrule',
    '  \\end{tabular}',
    `  \\caption{${texEscape(caption)}}`,
    '  \\label{tab:data}',
    '\\end{table}',
  ].join('\n')
}

export type PlotKind = 'line' | 'scatter' | 'bar'

export function plotLatex(d: Data, kind: PlotKind, xCol: number, yCols: number[], caption: string) {
  const symbolic = !d.rows.every(r => !r[xCol] || isNum(r[xCol]))
  const label = (s: string) => s.replace(/[{},]/g, '').trim() || 'x'
  const series = yCols.map(c => {
    const pts = d.rows.filter(r => r[c] && isNum(r[c]) && r[xCol]).map(r => `(${symbolic ? label(r[xCol]) : num(r[xCol])},${num(r[c])})`)
    const style = kind === 'scatter' ? 'only marks' : kind === 'line' ? 'mark=*' : ''
    return `    \\addplot${kind === 'bar' ? '' : `+[${style}]`} coordinates {${pts.join(' ')}};\n    \\addlegendentry{${texEscape(d.header[c] || `y${c}`)}}`
  })
  const axisOpts = [
    `xlabel={${texEscape(d.header[xCol] || 'x')}}`,
    yCols.length === 1 ? `ylabel={${texEscape(d.header[yCols[0]] || 'y')}}` : '',
    'width=0.85\\linewidth',
    'height=6cm',
    'legend pos=north west',
    kind === 'bar' ? 'ybar' : '',
    symbolic ? `symbolic x coords={${[...new Set(d.rows.map(r => label(r[xCol])))].join(',')}}, xtick=data` : '',
    kind === 'bar' ? 'ymin=0' : '',
  ].filter(Boolean)
  return [
    '\\begin{figure}[h]',
    '  \\centering',
    '  \\begin{tikzpicture}',
    `    \\begin{axis}[${axisOpts.join(', ')}]`,
    ...series,
    '    \\end{axis}',
    '  \\end{tikzpicture}',
    `  \\caption{${texEscape(caption)}}`,
    '  \\label{fig:data}',
    '\\end{figure}',
  ].join('\n')
}

let dialog: HTMLDialogElement | null = null

function buildDialog() {
  const dlg = document.createElement('dialog')
  dlg.className = 'wide csv-dialog'
  dlg.innerHTML = `
    <h3>Table or plot from data</h3>
    <p class="muted">Paste CSV, or cells copied from Excel/Sheets (tab-separated), or open a .csv file.</p>
    <div class="rs-row"><textarea class="csv-text" rows="7" placeholder="x,y\n1,2\n2,4"></textarea></div>
    <div class="rs-row"><input type="file" class="csv-file" accept=".csv,.tsv,.txt"><label class="check"><input type="checkbox" class="csv-header" checked> First row is a header</label></div>
    <div class="csv-opts">
      <label>Output <select class="csv-kind"><option value="table">Table (booktabs)</option><option value="line">Line plot</option><option value="scatter">Scatter plot</option><option value="bar">Bar chart</option></select></label>
      <label class="csv-xwrap">x column <select class="csv-x"></select></label>
      <span class="csv-ywrap">y columns <span class="csv-ys"></span></span>
      <label>Caption <input class="csv-caption" value="Data"></label>
    </div>
    <div class="csv-preview"></div>
    <menu><button type="button" class="primary csv-insert">Insert</button><button type="button" class="csv-cancel">Cancel</button></menu>`
  document.body.appendChild(dlg)
  return dlg
}

export function openCsvImport(view: EditorView, ctx: FormatContext) {
  dialog ??= buildDialog()
  const dlg = dialog
  const q = <T extends Element>(s: string) => dlg.querySelector<T>(s)!
  let data: Data = { header: [], rows: [] }

  const current = () => {
    const kind = q<HTMLSelectElement>('.csv-kind').value as 'table' | PlotKind
    const x = +q<HTMLSelectElement>('.csv-x').value || 0
    const ys = [...dlg.querySelectorAll<HTMLInputElement>('.csv-ys input:checked')].map(b => +b.value)
    return { kind, x, ys, caption: q<HTMLInputElement>('.csv-caption').value, header: q<HTMLInputElement>('.csv-header').checked }
  }

  const refresh = () => {
    data = parseCsv(q<HTMLTextAreaElement>('.csv-text').value)
    if (!q<HTMLInputElement>('.csv-header').checked) {
      data = { header: data.header.map((_, i) => `col${i + 1}`), rows: [data.header, ...data.rows] }
    }
    const cols = data.header.map((h, i) => ({ h: h || `col${i + 1}`, i }))
    const xSel = q<HTMLSelectElement>('.csv-x')
    const prevX = xSel.value
    xSel.replaceChildren(...cols.map(c => new Option(c.h, String(c.i), false, String(c.i) === prevX)))
    const prevY = new Set([...dlg.querySelectorAll<HTMLInputElement>('.csv-ys input:checked')].map(b => b.value))
    q('.csv-ys').replaceChildren(
      ...cols.map(c => {
        const l = document.createElement('label')
        const b = document.createElement('input')
        b.type = 'checkbox'
        b.value = String(c.i)
        b.checked = prevY.size ? prevY.has(String(c.i)) : c.i === 1
        b.onchange = renderPreview
        l.append(b, ` ${c.h}`)
        return l
      })
    )
    renderPreview()
  }

  const renderPreview = () => {
    const o = current()
    const plot = o.kind !== 'table'
    q<HTMLElement>('.csv-xwrap').hidden = q<HTMLElement>('.csv-ywrap').hidden = !plot
    const box = q('.csv-preview')
    q<HTMLButtonElement>('.csv-insert').disabled = !data.rows.length || (plot && !o.ys.length)
    if (!data.rows.length) return box.replaceChildren()
    if (!plot) {
      const t = document.createElement('table')
      const h = t.insertRow()
      data.header.forEach(c => (h.insertCell().textContent = c))
      data.rows.slice(0, 12).forEach(r => {
        const tr = t.insertRow()
        r.forEach(c => (tr.insertCell().textContent = c))
      })
      return box.replaceChildren(t)
    }
    box.replaceChildren(plotPreview(data, o.kind as PlotKind, o.x, o.ys))
  }

  q<HTMLTextAreaElement>('.csv-text').oninput = refresh
  q<HTMLInputElement>('.csv-header').onchange = refresh
  q<HTMLSelectElement>('.csv-kind').onchange = renderPreview
  q<HTMLSelectElement>('.csv-x').onchange = renderPreview
  q<HTMLInputElement>('.csv-file').onchange = async ev => {
    const f = (ev.target as HTMLInputElement).files?.[0]
    if (f) (q<HTMLTextAreaElement>('.csv-text').value = await f.text()), refresh()
  }
  q<HTMLButtonElement>('.csv-cancel').onclick = () => dlg.close()
  q<HTMLButtonElement>('.csv-insert').onclick = () => {
    const o = current()
    dlg.close()
    if (o.kind === 'table') {
      insertRawBlock(view, tableLatex(data, o.caption, true))
      ctx.ensurePackage('booktabs')
    } else {
      insertRawBlock(view, plotLatex(data, o.kind, o.x, o.ys, o.caption))
      ctx.ensurePackage('pgfplots')
      ctx.ensurePreamble('\\pgfplotsset{compat=1.18}', /\\pgfplotsset\s*\{[^}]*compat/)
    }
  }
  refresh()
  dlg.showModal()
}

/** Quick SVG sketch of the chart (the real one is drawn by pgfplots when you compile). */
function plotPreview(d: Data, kind: PlotKind, xCol: number, yCols: number[]) {
  const W = 520
  const H = 220
  const pad = 30
  const NS = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`)
  svg.setAttribute('class', 'csv-svg')
  const symbolic = !d.rows.every(r => !r[xCol] || isNum(r[xCol]))
  const xs = d.rows.map((r, i) => (symbolic ? i : num(r[xCol])))
  const ys = yCols.flatMap(c => d.rows.map(r => num(r[c])).filter(Number.isFinite))
  if (!ys.length) return svg
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)]
  const [y0, y1] = [Math.min(0, ...ys), Math.max(...ys)]
  const sx = (x: number) => pad + ((x - x0) / (x1 - x0 || 1)) * (W - 2 * pad)
  const sy = (y: number) => H - pad - ((y - y0) / (y1 - y0 || 1)) * (H - 2 * pad)
  const colors = ['#7cb7ff', '#f0b46e', '#8fd18f', '#c792ea', '#f78c6c']
  const axis = document.createElementNS(NS, 'path')
  axis.setAttribute('d', `M${pad},${pad / 2} V${H - pad} H${W - pad / 2}`)
  axis.setAttribute('class', 'csv-axis')
  svg.appendChild(axis)
  yCols.forEach((c, k) => {
    const pts = d.rows.map((r, i) => [sx(xs[i]), sy(num(r[c]))] as const).filter(p => Number.isFinite(p[1]))
    const color = colors[k % colors.length]
    if (kind === 'bar') {
      const bw = Math.max(4, (W - 2 * pad) / Math.max(1, pts.length) / (yCols.length + 1))
      pts.forEach(([x, y]) => {
        const rect = document.createElementNS(NS, 'rect')
        rect.setAttribute('x', String(x - (bw * yCols.length) / 2 + k * bw))
        rect.setAttribute('y', String(y))
        rect.setAttribute('width', String(bw))
        rect.setAttribute('height', String(Math.max(0, sy(0) - y)))
        rect.setAttribute('fill', color)
        svg.appendChild(rect)
      })
      return
    }
    if (kind === 'line') {
      const line = document.createElementNS(NS, 'polyline')
      line.setAttribute('points', pts.map(p => p.join(',')).join(' '))
      line.setAttribute('fill', 'none')
      line.setAttribute('stroke', color)
      line.setAttribute('stroke-width', '2')
      svg.appendChild(line)
    }
    pts.forEach(([x, y]) => {
      const dot = document.createElementNS(NS, 'circle')
      dot.setAttribute('cx', String(x))
      dot.setAttribute('cy', String(y))
      dot.setAttribute('r', '3')
      dot.setAttribute('fill', color)
      svg.appendChild(dot)
    })
  })
  return svg
}
