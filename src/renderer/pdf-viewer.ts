import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'

pdfjs.GlobalWorkerOptions.workerSrc = './pdf.worker.min.mjs'

type PageView = { el: HTMLDivElement; canvas: HTMLCanvasElement; width: number; height: number; rendered: number }

export class PdfViewer {
  private doc: PDFDocumentProxy | null = null
  private pages: PageView[] = []
  private observer: IntersectionObserver
  private scale = 1.2
  private fitWidth = true
  private resizeTimer = 0
  private renderToken = 0

  /** Called with PDF-point coordinates when the user double-clicks a page (reverse SyncTeX). */
  onDoubleClick: (page: number, x: number, y: number) => void = () => {}
  onScaleChange: (scale: number) => void = () => {}

  constructor(private container: HTMLElement) {
    this.observer = new IntersectionObserver(
      entries => {
        for (const entry of entries) {
          if (entry.isIntersecting) this.renderPage(this.pages.findIndex(p => p.el === entry.target))
        }
      },
      { root: container, rootMargin: '600px 0px' }
    )
    new ResizeObserver(() => {
      if (!this.fitWidth || !this.doc) return
      // while the pane is being resized (dragging the divider), only stretch the current page images, which
      // is cheap and keeps up with the mouse; redraw them sharp once the resizing stops
      this.stretchTo(this.computeFitScale())
      clearTimeout(this.resizeTimer)
      this.resizeTimer = window.setTimeout(() => this.applyScale(this.computeFitScale()), 150)
    }).observe(container)
  }

  async load(data: Uint8Array) {
    const token = ++this.renderToken
    // keep the reading position across recompiles
    const scrollRatio = this.container.scrollHeight ? this.container.scrollTop / this.container.scrollHeight : 0
    const doc = await pdfjs.getDocument({ data }).promise
    if (token !== this.renderToken) return
    this.doc?.destroy()
    this.doc = doc

    // show the previous compile's page images until the new ones are drawn, then crossfade
    const previous = this.pages.map(p => p.canvas)
    const pages: PageView[] = []
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const vp = page.getViewport({ scale: 1 })
      const el = document.createElement('div')
      el.className = 'pdf-page'
      const canvas = previous[i - 1] ?? document.createElement('canvas')
      el.appendChild(canvas)
      el.addEventListener('dblclick', ev => {
        const rect = el.getBoundingClientRect()
        this.onDoubleClick(i, (ev.clientX - rect.left) / this.scale, (ev.clientY - rect.top) / this.scale)
      })
      pages.push({ el, canvas, width: vp.width, height: vp.height, rendered: 0 })
    }
    if (token !== this.renderToken) return

    this.observer.disconnect()
    this.pages = pages
    this.container.replaceChildren(...pages.map(p => p.el))
    this.applyScale(this.fitWidth ? this.computeFitScale() : this.scale)
    this.container.scrollTop = scrollRatio * this.container.scrollHeight
    for (const p of pages) this.observer.observe(p.el)
  }

  clear() {
    this.renderToken++
    this.doc?.destroy()
    this.doc = null
    this.pages = []
    this.container.replaceChildren()
  }

  zoom(factor: number) {
    this.fitWidth = false
    this.applyScale(Math.min(5, Math.max(0.25, this.scale * factor)))
  }

  fit() {
    this.fitWidth = true
    this.applyScale(this.computeFitScale())
  }

  /** Scroll to and flash a SyncTeX box (coordinates in PDF points, top-left origin). */
  highlight(page: number, h: number, v: number, W: number, H: number) {
    const view = this.pages[page - 1]
    if (!view) return
    const box = document.createElement('div')
    box.className = 'synctex-highlight'
    Object.assign(box.style, {
      left: `${h * this.scale}px`,
      top: `${(v - H) * this.scale}px`,
      width: `${Math.max(W, 20) * this.scale}px`,
      height: `${Math.max(H, 8) * this.scale}px`,
    })
    view.el.appendChild(box)
    const top = view.el.offsetTop + (v - H) * this.scale - this.container.clientHeight / 3
    this.container.scrollTo({ top, behavior: 'smooth' })
    setTimeout(() => box.remove(), 1600)
  }

  private computeFitScale() {
    const widest = Math.max(...this.pages.map(p => p.width), 1)
    return Math.max(0.25, (this.container.clientWidth - 32) / widest)
  }

  /** Resize the page boxes without redrawing them (the canvases fill their box, so the images stretch). */
  private stretchTo(scale: number) {
    for (const p of this.pages) {
      p.el.style.width = `${p.width * scale}px`
      p.el.style.height = `${p.height * scale}px`
    }
  }

  private applyScale(scale: number) {
    this.scale = scale
    for (const p of this.pages) {
      p.el.style.width = `${p.width * scale}px`
      p.el.style.height = `${p.height * scale}px`
      p.rendered = 0
    }
    // re-render whatever is currently visible
    const top = this.container.scrollTop - 600
    const bottom = this.container.scrollTop + this.container.clientHeight + 600
    this.pages.forEach((p, i) => {
      if (p.el.offsetTop + p.el.offsetHeight > top && p.el.offsetTop < bottom) this.renderPage(i)
    })
    this.onScaleChange(scale)
  }

  private async renderPage(index: number) {
    const view = this.pages[index]
    if (!view || !this.doc || view.rendered === this.scale) return
    view.rendered = this.scale
    const scale = this.scale
    const page = await this.doc.getPage(index + 1)
    const ratio = window.devicePixelRatio || 1
    const viewport = page.getViewport({ scale: scale * ratio })
    // draw offscreen first so the old image stays visible until the new one is ready
    const canvas = document.createElement('canvas')
    canvas.width = viewport.width
    canvas.height = viewport.height
    await page.render({ canvasContext: canvas.getContext('2d')!, viewport }).promise
    if (view.rendered !== scale || !this.pages.includes(view)) return
    const old = view.canvas
    view.canvas = canvas
    // a blank placeholder (first load) is simply swapped; a real image fades out under the new one
    if (!old.width || !old.isConnected || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      old.replaceWith(canvas)
      return
    }
    canvas.className = 'pdf-fade-in'
    old.after(canvas)
    const done = () => {
      old.remove()
      canvas.className = ''
    }
    canvas.addEventListener('animationend', done, { once: true })
    setTimeout(done, 400) // in case the animation never runs (e.g. page scrolled out of view)
  }
}
