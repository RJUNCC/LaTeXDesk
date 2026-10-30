// LaTeXDesk: PDF figures in the visual editor use the same pdf.js as the PDF preview.
import * as pdfjs from 'pdfjs-dist'

pdfjs.GlobalWorkerOptions.workerSrc ||= './pdf.worker.min.mjs'

export const loadPdfDocumentFromUrl = (url: string) => pdfjs.getDocument({ url, isEvalSupported: false })
