// LaTeXDesk: \bibliography{…} (or \printbibliography) in the visual editor: a labeled block for the reference
// list, with its style and a button that opens the Sources dialog
import { WidgetType } from '@codemirror/view'
import { citationProvider } from '../citations'

export class BibliographyWidget extends WidgetType {
  constructor(
    private style: string,
    private count: number
  ) {
    super()
  }

  toDOM() {
    const element = document.createElement('span')
    element.className = 'ol-cm-bibliography'
    const title = document.createElement('strong')
    title.textContent = '📚 References'
    const info = document.createElement('span')
    info.className = 'ol-cm-bibliography-info'
    info.textContent = `${this.style} · ${this.count} source${this.count === 1 ? '' : 's'} · the list appears here in the PDF`
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = 'Sources & style…'
    button.addEventListener('mousedown', event => event.preventDefault())
    button.addEventListener('click', event => {
      event.preventDefault()
      citationProvider().openSources()
    })
    element.append(title, info, button)
    return element
  }

  eq(widget: BibliographyWidget) {
    return widget.style === this.style && widget.count === this.count
  }

  // the button handles its own clicks; elsewhere, clicking reveals the LaTeX like other widgets
  ignoreEvent(event: Event) {
    return (event.target as HTMLElement).tagName === 'BUTTON' || (event.type !== 'mousedown' && event.type !== 'mouseup')
  }

  coordsAt(element: HTMLElement) {
    return element.getBoundingClientRect()
  }
}

/** \bibliographystyle{…} is described by the reference list block, so it shows as nothing. */
export class HiddenWidget extends WidgetType {
  toDOM() {
    return document.createElement('span')
  }

  eq() {
    return true
  }
}
