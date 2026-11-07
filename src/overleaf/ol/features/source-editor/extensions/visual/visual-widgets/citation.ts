// LaTeXDesk: \cite{…} in the visual editor, shown as the citation reads, e.g. (Smith & Lee, 2020)
import { WidgetType } from '@codemirror/view'

export class CitationWidget extends WidgetType {
  constructor(
    private text: string,
    private title: string,
    private missing: boolean
  ) {
    super()
  }

  toDOM() {
    const element = document.createElement('span')
    element.className = `ol-cm-citation${this.missing ? ' missing' : ''}`
    element.setAttribute('role', 'button')
    element.textContent = this.text
    element.title = `${this.title}\nClick to edit the citation.`
    return element
  }

  eq(widget: CitationWidget) {
    return widget.text === this.text && widget.title === this.title && widget.missing === this.missing
  }

  ignoreEvent(event: Event) {
    return event.type !== 'mousedown' && event.type !== 'mouseup'
  }

  coordsAt(element: HTMLElement) {
    return element.getBoundingClientRect()
  }
}
