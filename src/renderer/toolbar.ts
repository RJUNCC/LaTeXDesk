// The formatting toolbar above the editor.
import { EditorView } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { toggleComment } from '@codemirror/commands'
import {
  FormatContext,
  HEADINGS,
  Heading,
  TableOptions,
  currentHeading,
  environment,
  insertBlock,
  insertFigure,
  insertLink,
  insertSnippet,
  insertTable,
  insertWithCompletion,
  mathSnippet,
  isCommandActive,
  list,
  setHeading,
  toggleCommand,
  wrap,
} from './format'
import { openMarkovBuilder } from './markov'
import { openCsvImport } from './csv-import'

type MenuItem = { label: string; hint?: string; swatch?: string; run: () => void } | 'sep'

const HEADING_LABELS: Record<Heading, string> = {
  normal: 'Normal text',
  part: 'Part',
  chapter: 'Chapter',
  section: 'Section',
  subsection: 'Subsection',
  subsubsection: 'Subsubsection',
  paragraph: 'Paragraph',
}

const SIZES = ['tiny', 'scriptsize', 'footnotesize', 'small', 'normalsize', 'large', 'Large', 'LARGE', 'huge', 'Huge']

const COLORS: [string, string][] = [
  ['red', '#e53935'], ['blue', '#1e66f5'], ['green', '#2e9d3a'], ['orange', '#f08c00'],
  ['violet', '#8e44ad'], ['cyan', '#0fa3b1'], ['magenta', '#d6336c'], ['gray', '#888'],
]

export class FormatToolbar {
  private headingSelect!: HTMLSelectElement
  private toggles: [HTMLButtonElement, string][] = []
  private openMenu: HTMLElement | null = null

  constructor(private bar: HTMLElement, private view: EditorView, private ctx: FormatContext) {
    this.build()
    document.addEventListener('mousedown', e => {
      if (this.openMenu && !this.openMenu.contains(e.target as Node)) this.closeMenu()
    })
    document.addEventListener('keydown', e => e.key === 'Escape' && this.closeMenu())
  }

  /** Refresh active states for the cursor position. */
  update(state: EditorState) {
    this.headingSelect.value = currentHeading(state)
    for (const [btn, cmd] of this.toggles) btn.classList.toggle('active', isCommandActive(state, cmd))
  }

  setEnabled(enabled: boolean) {
    this.bar.hidden = !enabled
  }

  private build() {
    const v = this.view
    const ctx = this.ctx

    // headings
    this.headingSelect = document.createElement('select')
    this.headingSelect.title = 'Paragraph style'
    for (const h of ['normal', ...HEADINGS] as Heading[]) this.headingSelect.add(new Option(HEADING_LABELS[h], h))
    this.headingSelect.onchange = () => setHeading(v, this.headingSelect.value as Heading)
    this.bar.append(this.headingSelect, this.sep())

    // text style
    this.bar.append(
      this.toggle('<b>B</b>', 'textbf', 'Bold (Ctrl+B)'),
      this.toggle('<i>I</i>', 'textit', 'Italic (Ctrl+I)'),
      this.toggle('<u>U</u>', 'underline', 'Underline'),
      this.menuButton('<span style="font-family:var(--mono)">Aa</span>', 'More text styles', () => [
        { label: 'Monospace', hint: '\\texttt', run: () => toggleCommand(v, 'texttt') },
        { label: 'Small caps', hint: '\\textsc', run: () => toggleCommand(v, 'textsc') },
        { label: 'Emphasis', hint: '\\emph', run: () => toggleCommand(v, 'emph') },
        { label: 'Strikethrough', hint: '\\sout', run: () => (toggleCommand(v, 'sout'), ctx.ensurePackage('ulem', 'normalem')) },
        { label: 'Superscript', hint: '\\textsuperscript', run: () => toggleCommand(v, 'textsuperscript') },
        { label: 'Subscript', hint: '\\textsubscript', run: () => toggleCommand(v, 'textsubscript') },
      ]),
      this.menuButton('<span class="color-a">A</span>', 'Text colour', () =>
        COLORS.map(([name, css]) => ({
          label: name[0].toUpperCase() + name.slice(1),
          swatch: css,
          run: () => (wrap(v, `\\textcolor{${name}}{`, '}'), ctx.ensurePackage('xcolor')),
        }))
      ),
      this.menuButton('<span style="font-size:11px">A</span><span style="font-size:15px">A</span>', 'Font size', () =>
        SIZES.map(size => ({ label: size, hint: `\\${size}`, run: () => wrap(v, `{\\${size} `, '}') }))
      ),
      this.sep()
    )

    // lists & alignment
    this.bar.append(
      this.button('• ≡', 'Bulleted list', () => list(v, 'itemize')),
      this.button('1. ≡', 'Numbered list', () => list(v, 'enumerate')),
      this.menuButton('≣', 'Alignment & blocks', () => [
        { label: 'Align left', hint: 'flushleft', run: () => environment(v, 'flushleft') },
        { label: 'Center', hint: 'center', run: () => environment(v, 'center') },
        { label: 'Align right', hint: 'flushright', run: () => environment(v, 'flushright') },
        'sep',
        { label: 'Description list', hint: 'description', run: () => list(v, 'description') },
        { label: 'Quotation', hint: 'quote', run: () => environment(v, 'quote') },
        { label: 'Code block', hint: 'verbatim', run: () => environment(v, 'verbatim') },
      ]),
      this.sep()
    )

    // math
    this.bar.append(
      this.button('<i>x</i>²', 'Inline math ($…$)', () =>
        v.state.selection.main.empty ? insertSnippet(v, '$#{}$') : wrap(v, '$', '$')
      ),
      this.menuButton('∑', 'Math', () => [
        { label: 'Inline math', hint: '$ … $', run: () => (v.state.selection.main.empty ? insertSnippet(v, '$#{}$') : wrap(v, '$', '$')) },
        { label: 'Display math', hint: '\\[ … \\]', run: () => insertBlock(v, '\\[\n\t#{}\n\\]') },
        { label: 'Numbered equation', hint: 'equation', run: () => environment(v, 'equation') },
        { label: 'Aligned equations', hint: 'align', run: () => (environment(v, 'align', '#{a} &= #{b} \\\\\n\t#{c} &= #{d}'), ctx.ensurePackage('amsmath')) },
        'sep',
        { label: 'Fraction', hint: '\\frac{a}{b}', run: () => mathSnippet(v, '\\frac{#{num}}{#{den}}') },
        { label: 'Square root', hint: '\\sqrt{x}', run: () => mathSnippet(v, '\\sqrt{#{}}') },
        { label: 'Sum', hint: '\\sum_{i=1}^{n}', run: () => mathSnippet(v, '\\sum_{#{i=1}}^{#{n}} ') },
        { label: 'Integral', hint: '\\int_a^b', run: () => mathSnippet(v, '\\int_{#{a}}^{#{b}} #{} \\, d#{x}') },
        { label: 'Matrix', hint: 'pmatrix', run: () => (mathSnippet(v, '\\begin{pmatrix}\n\t#{} & #{} \\\\\n\t#{} & #{}\n\\end{pmatrix}'), ctx.ensurePackage('amsmath')) },
      ]),
      this.sep()
    )

    // inserts
    this.bar.append(
      this.button('⊞ Table', 'Insert table', () => this.tableDialog()),
      this.button('▣ Figure', 'Insert figure', () => insertFigure(v, ctx)),
      this.button('Link', 'Insert link (\\href)', () => insertLink(v, ctx)),
      this.button('⇄ Markov', 'Markov chain builder (place the cursor inside an existing chain to edit it)', () => openMarkovBuilder(v, ctx)),
      this.menuButton('+ Insert', 'Insert', () => [
        { label: 'Footnote', hint: '\\footnote', run: () => insertSnippet(v, '\\footnote{#{}}') },
        { label: 'Citation', hint: '\\cite', run: () => insertWithCompletion(v, 'cite') },
        { label: 'Cross-reference', hint: '\\ref', run: () => insertWithCompletion(v, 'ref') },
        { label: 'Label', hint: '\\label', run: () => insertSnippet(v, '\\label{#{}}') },
        'sep',
        { label: 'Page break', hint: '\\newpage', run: () => insertBlock(v, '\\newpage\n#{}') },
        { label: 'Horizontal line', hint: '\\rule', run: () => insertBlock(v, '\\noindent\\rule{\\linewidth}{0.4pt}\n#{}') },
        { label: 'Vertical space', hint: '\\vspace', run: () => insertBlock(v, '\\vspace{#{1em}}') },
        { label: 'Table of contents', hint: '\\tableofcontents', run: () => insertBlock(v, '\\tableofcontents\n#{}') },
        { label: 'Markov chain…', hint: 'TikZ', run: () => openMarkovBuilder(v, ctx) },
        { label: 'Table / plot from data…', hint: 'CSV', run: () => openCsvImport(v, ctx) },
        'sep',
        { label: 'Comment / uncomment', hint: 'Ctrl+/', run: () => (toggleComment(v), v.focus()) },
      ])
    )
  }

  private sep() {
    const s = document.createElement('span')
    s.className = 'fb-sep'
    return s
  }

  private button(html: string, title: string, run: () => void) {
    const b = document.createElement('button')
    b.className = 'fb-btn'
    b.innerHTML = html
    b.title = title
    // keep editor focus/selection when clicking toolbar buttons
    b.onmousedown = e => e.preventDefault()
    b.onclick = () => run()
    return b
  }

  private toggle(html: string, command: string, title: string) {
    const b = this.button(html, title, () => toggleCommand(this.view, command))
    this.toggles.push([b, command])
    return b
  }

  private menuButton(html: string, title: string, items: () => MenuItem[]) {
    const b = this.button(html + '<span class="caret">▾</span>', title, () => {
      if (this.openMenu?.dataset.owner === title) return this.closeMenu()
      this.closeMenu()
      const menu = document.createElement('div')
      menu.className = 'fb-menu'
      menu.dataset.owner = title
      for (const item of items()) {
        if (item === 'sep') {
          menu.appendChild(document.createElement('hr'))
          continue
        }
        const row = document.createElement('button')
        row.onmousedown = e => e.preventDefault()
        row.innerHTML = `${item.swatch ? `<span class="swatch" style="background:${item.swatch}"></span>` : ''}<span>${item.label}</span>${item.hint ? `<span class="hint"></span>` : ''}`
        if (item.hint) row.querySelector('.hint')!.textContent = item.hint
        row.onclick = () => {
          this.closeMenu()
          item.run()
        }
        menu.appendChild(row)
      }
      document.body.appendChild(menu)
      const r = b.getBoundingClientRect()
      menu.style.top = `${r.bottom + 2}px`
      menu.style.left = `${Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)}px`
      this.openMenu = menu
    })
    return b
  }

  private closeMenu() {
    this.openMenu?.remove()
    this.openMenu = null
  }

  private tableDialog() {
    const dlg = document.getElementById('table-dialog') as HTMLDialogElement
    const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
    const rows = $<HTMLInputElement>('tbl-rows')
    const cols = $<HTMLInputElement>('tbl-cols')
    const grid = $('table-grid')
    const label = $('table-grid-label')

    // Word-style size picker: hover to preview, click to pick
    const paint = (r: number, c: number) => {
      grid.querySelectorAll<HTMLElement>('div').forEach(cell => {
        cell.classList.toggle('on', +cell.dataset.r! <= r && +cell.dataset.c! <= c)
      })
      label.textContent = `${r} × ${c}`
    }
    if (!grid.childElementCount) {
      for (let r = 1; r <= 8; r++)
        for (let c = 1; c <= 8; c++) {
          const cell = document.createElement('div')
          cell.dataset.r = String(r)
          cell.dataset.c = String(c)
          cell.onmouseenter = () => paint(r, c)
          cell.onclick = () => {
            rows.value = String(r)
            cols.value = String(c)
            dlg.close('ok')
          }
          grid.appendChild(cell)
        }
      grid.onmouseleave = () => paint(+rows.value, +cols.value)
      rows.oninput = cols.oninput = () => paint(+rows.value, +cols.value)
    }
    paint(+rows.value, +cols.value)
    dlg.returnValue = ''
    dlg.showModal()
    dlg.onclose = () => {
      if (dlg.returnValue !== 'ok') return this.view.focus()
      const opts: TableOptions = {
        rows: Math.max(1, Math.min(50, +rows.value || 3)),
        cols: Math.max(1, Math.min(20, +cols.value || 3)),
        align: $<HTMLSelectElement>('tbl-align').value as TableOptions['align'],
        style: $<HTMLSelectElement>('tbl-style').value as TableOptions['style'],
        header: $<HTMLInputElement>('tbl-header').checked,
        float: $<HTMLInputElement>('tbl-float').checked,
        caption: $<HTMLInputElement>('tbl-caption').value || 'Caption',
      }
      insertTable(this.view, this.ctx, opts)
    }
  }
}
