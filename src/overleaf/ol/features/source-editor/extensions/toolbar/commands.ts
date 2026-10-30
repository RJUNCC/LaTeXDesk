// Trimmed from Overleaf's toolbar commands: only the list indent commands the visual keymap uses
// (the rest of Overleaf's toolbar is replaced by LaTeXDesk's own toolbar).
import { EditorState } from '@codemirror/state'
import { Command } from '@codemirror/view'
import {
  ancestorListType,
  unwrapBulletList,
  unwrapDescriptionList,
  unwrapNumberedList,
  wrapInBulletList,
  wrapInDescriptionList,
  wrapInNumberedList,
} from './lists'
import { minimumListDepthForSelection } from '../../utils/tree-operations/ancestors'

export const indentDecrease: Command = view => {
  if (minimumListDepthForSelection(view.state) < 2) {
    return false
  }
  switch (ancestorListType(view.state)) {
    case 'itemize':
      return unwrapBulletList(view)
    case 'enumerate':
      return unwrapNumberedList(view)
    case 'description':
      return unwrapDescriptionList(view)
    default:
      return false
  }
}

export const cursorIsAtStartOfListItem = (state: EditorState) => {
  return state.selection.ranges.every(range => {
    const line = state.doc.lineAt(range.from)
    const prefix = state.sliceDoc(line.from, range.from)
    return /\\item\s*$/.test(prefix)
  })
}

export const indentIncrease: Command = view => {
  if (minimumListDepthForSelection(view.state) < 1) {
    return false
  }
  switch (ancestorListType(view.state)) {
    case 'itemize':
      return wrapInBulletList(view)
    case 'enumerate':
      return wrapInNumberedList(view)
    case 'description':
      return wrapInDescriptionList(view)
    default:
      return false
  }
}

