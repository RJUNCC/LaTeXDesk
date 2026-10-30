// LaTeXDesk: Overleaf's pasted-content helpers without the React "paste formatted / plain" menu.
// Pasting formatted content (Word, Google Docs, the web) inserts it as LaTeX; inside maths, as plain text.
import { EditorSelection, Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { ancestorNodeOfType } from '../../utils/tree-operations/ancestors'

export type PastedContent = { latex: string; text: string }

export const insertPastedContent = (view: EditorView, { latex, text }: PastedContent) =>
  view.state.changeByRange(range => {
    // avoid pasting formatted content into a math container
    if (ancestorNodeOfType(view.state, range.anchor, '$MathContainer')) {
      return {
        range: EditorSelection.cursor(range.from + text.length),
        changes: { from: range.from, to: range.to, insert: text },
      }
    }

    return {
      range: EditorSelection.cursor(range.from + latex.length),
      changes: { from: range.from, to: range.to, insert: latex },
    }
  })

/** Overleaf remembers the paste for its menu; there's no menu here, so nothing to store. */
export const storePastedContent = (_content: PastedContent, _formatted: boolean) => ({})

export const pastedContent: Extension = []
