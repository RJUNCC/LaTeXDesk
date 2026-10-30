// LaTeXDesk: Overleaf renders tables in the visual editor with a React table editor. This widget draws the
// same parsed table as a plain HTML table (alignment, borders, merged cells, maths and bold/italic text);
// clicking a cell puts the cursor in that cell's LaTeX so it can be edited.
import { EditorView, WidgetType } from '@codemirror/view'
import { SyntaxNode } from '@lezer/common'
import { ParsedTableData } from '../../../components/table-generator/utils'
import { loadMathJax } from '../../../../mathjax/load-mathjax'

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

/** A cell's LaTeX as display HTML: maths stays for KaTeX, common text commands become formatting. */
function cellHtml(latex: string) {
  const parts = latex.trim().split(/(\$[^$]*\$|\\\([\s\S]*?\\\))/)
  return parts
    .map((part, i) => {
      if (i % 2) return escapeHtml(part) // maths, typeset afterwards
      let html = escapeHtml(part)
      for (let pass = 0; pass < 3; pass++)
        html = html
          .replace(/\\textbf\{([^{}]*)\}/g, '<b>$1</b>')
          .replace(/\\(?:textit|emph)\{([^{}]*)\}/g, '<i>$1</i>')
          .replace(/\\underline\{([^{}]*)\}/g, '<u>$1</u>')
          .replace(/\\texttt\{([^{}]*)\}/g, '<code>$1</code>')
          .replace(/\\(?:multicolumn|multirow)\{[^{}]*\}\{[^{}]*\}\{([^{}]*)\}/g, '$1')
      return html
        .replace(/\\(?:hline|toprule|midrule|bottomrule|cline\{[^}]*\})/g, '')
        .replace(/\\([%&$#_{}])/g, '$1')
        .replace(/~/g, '&nbsp;')
        .replace(/\\\\/g, '')
    })
    .join('')
}

export class TabularWidget extends WidgetType {
  constructor(
    private parsedTableData: ParsedTableData,
    private tabularNode: SyntaxNode,
    private content: string,
    private tableNode: SyntaxNode | null,
    private isDirectChildOfTableEnvironment: boolean
  ) {
    super()
  }

  toDOM(view: EditorView) {
    const element = document.createElement('div')
    element.classList.add('ol-cm-tabular')
    if (this.tableNode) element.classList.add('ol-cm-environment-table')
    this.render(element, view)
    return element
  }

  private render(element: HTMLElement, view: EditorView) {
    const { table, cellPositions } = this.parsedTableData
    const tableEl = document.createElement('table')
    tableEl.className = 'ld-tabular'
    tableEl.title = 'Click a cell to edit it. Use the Table button to make a new table.'
    const align = { left: 'left', center: 'center', right: 'right', paragraph: 'left' } as const
    table.rows.forEach((row, r) => {
      const tr = document.createElement('tr')
      if (row.borderTop) tr.classList.add('ld-border-top')
      if (row.borderBottom) tr.classList.add('ld-border-bottom')
      let column = 0
      row.cells.forEach((cell, c) => {
        const td = document.createElement('td')
        const span = cell.multiColumn?.columnSpan ?? 1
        if (span > 1) td.colSpan = span
        const spec = cell.multiColumn?.columns.specification[0] ?? table.columns[column]
        if (spec) {
          td.style.textAlign = align[spec.alignment]
          if (spec.borderLeft) td.classList.add('ld-border-left')
          if (spec.borderRight) td.classList.add('ld-border-right')
        }
        td.innerHTML = cellHtml(cell.content) || '&nbsp;'
        const position = cellPositions[r]?.[c]
        td.addEventListener('mousedown', event => {
          event.preventDefault()
          const at = position ? position.from : this.tabularNode.from
          view.dispatch({ selection: { anchor: at }, scrollIntoView: true })
          view.focus()
        })
        tr.append(td)
        column += span
      })
      tableEl.append(tr)
    })
    element.replaceChildren(tableEl)
    loadMathJax()
      .then(MathJax => MathJax.typesetPromise([tableEl]))
      .catch(() => {})
      .finally(() => view.requestMeasure())
  }

  eq(widget: TabularWidget): boolean {
    return (
      this.tabularNode.from === widget.tabularNode.from &&
      this.tableNode?.from === widget.tableNode?.from &&
      this.tableNode?.to === widget.tableNode?.to &&
      this.content === widget.content &&
      this.isDirectChildOfTableEnvironment === widget.isDirectChildOfTableEnvironment
    )
  }

  updateDOM(element: HTMLElement, view: EditorView): boolean {
    this.render(element, view)
    return true
  }

  coordsAt(element: HTMLElement) {
    return element.getBoundingClientRect()
  }

  get estimatedHeight() {
    return this.parsedTableData.table.rows.length * 32
  }

  ignoreEvent(event: Event) {
    return event.type !== 'mousedown'
  }
}
